import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentTaskSessions,
  agentWakeupRequests,
  caseEvents,
  completionContracts,
  costEvents,
  decisionArchiveNotificationOutbox,
  decisionBundles,
  decisionQueueItems,
  decisionQueues,
  decisionRetention,
  decisionTriage,
  decisionTriageEvents,
  decisions,
  financeEvents,
  heartbeatRunEvents,
  heartbeatRuns,
  inboxDismissals,
  issueThreadInteractions,
  nativeRunFinalizations,
  nativeRunResults,
  runIdentityContexts,
  statusDecisions,
  workAssessments,
} from "@paperclipai/db";

// A live runner may still be writing to these runs; deleting under it would
// race the writer and recreate orphan rows, so they are left behind.
const ACTIVE_RUN_STATUSES = ["running", "queued", "scheduled_retry"] as const;

/**
 * Deletes the agent-side run history (runs, run events, logs, native-run
 * family, identity contexts) tied to the given issues, and detaches runs from
 * rows that outlive them (task sessions, cost/finance events, decision queue
 * provenance). Runs referenced by decisions or decision bundles are kept so
 * decision provenance survives. Cost and finance rows themselves are never
 * deleted. Must run inside the same transaction as the issue deletion.
 */
export async function purgeIssueRunData(
  db: Db,
  companyId: string,
  issueIds: string[],
): Promise<number> {
  if (issueIds.length === 0) return 0;

  const candidateRuns = await db
    .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        or(
          inArray(heartbeatRuns.nativeIssueId, issueIds),
          inArray(sql<string>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`, issueIds),
        ),
      ),
    );
  if (candidateRuns.length === 0) return 0;

  const candidateIds = candidateRuns.map((run) => run.id);
  const protectedRunIds = new Set(
    (
      await Promise.all([
        db
          .select({ runId: decisions.originRunId })
          .from(decisions)
          .where(inArray(decisions.originRunId, candidateIds)),
        db
          .select({ runId: decisionBundles.originRunId })
          .from(decisionBundles)
          .where(inArray(decisionBundles.originRunId, candidateIds)),
      ])
    )
      .flat()
      .map((row) => row.runId),
  );

  const runIds = candidateRuns
    .filter((run) => !(ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status))
    .filter((run) => !protectedRunIds.has(run.id))
    .map((run) => run.id);
  if (runIds.length === 0) return 0;

  // Task sessions are keyed by the raw issue id in taskKey, so a deleted
  // issue's sessions go with it; sessions of other tasks keep their row and
  // only lose the dangling lastRunId below.
  await db
    .delete(agentTaskSessions)
    .where(
      and(
        eq(agentTaskSessions.companyId, companyId),
        inArray(agentTaskSessions.taskKey, issueIds),
      ),
    );
  await db
    .update(agentTaskSessions)
    .set({ lastRunId: null })
    .where(inArray(agentTaskSessions.lastRunId, runIds));
  await db
    .update(costEvents)
    .set({ heartbeatRunId: null })
    .where(inArray(costEvents.heartbeatRunId, runIds));
  await db
    .update(financeEvents)
    .set({ heartbeatRunId: null })
    .where(inArray(financeEvents.heartbeatRunId, runIds));
  await db
    .update(decisionQueues)
    .set({ createdByRunId: null })
    .where(inArray(decisionQueues.createdByRunId, runIds));
  await db
    .update(decisionQueueItems)
    .set({ addedByRunId: null })
    .where(inArray(decisionQueueItems.addedByRunId, runIds));
  await db
    .update(decisionTriage)
    .set({ setByRunId: null })
    .where(inArray(decisionTriage.setByRunId, runIds));
  await db
    .update(decisionTriageEvents)
    .set({ actorRunId: null })
    .where(inArray(decisionTriageEvents.actorRunId, runIds));
  await db
    .update(decisionRetention)
    .set({ archivedByRunId: null })
    .where(inArray(decisionRetention.archivedByRunId, runIds));
  await db
    .update(agentWakeupRequests)
    .set({ runId: null })
    .where(inArray(agentWakeupRequests.runId, runIds));
  await db
    .update(caseEvents)
    .set({ runId: null })
    .where(inArray(caseEvents.runId, runIds));

  // Finalizations reference results, assessments and status decisions, and
  // work assessments reference completion contracts, so the delete order below
  // matters: finalizations, then status decisions, then assessments, then
  // results, then contracts.
  await db
    .delete(nativeRunFinalizations)
    .where(inArray(nativeRunFinalizations.runId, runIds));
  await db.delete(statusDecisions).where(inArray(statusDecisions.runId, runIds));
  await db.delete(workAssessments).where(inArray(workAssessments.runId, runIds));
  await db.delete(nativeRunResults).where(inArray(nativeRunResults.runId, runIds));
  await db
    .delete(completionContracts)
    .where(inArray(completionContracts.issueId, issueIds));
  await db
    .delete(runIdentityContexts)
    .where(inArray(runIdentityContexts.runId, runIds));
  await db.delete(activityLog).where(inArray(activityLog.runId, runIds));
  await db.delete(heartbeatRunEvents).where(inArray(heartbeatRunEvents.runId, runIds));

  // Cascades from this delete also clear provider traces, watchdog decisions
  // and issue checkout/execution run references.
  await db.delete(heartbeatRuns).where(inArray(heartbeatRuns.id, runIds));
  return runIds.length;
}

/**
 * Purges polymorphic decision sidecars (queue items, triage state, retention,
 * outbox) and dismissal state tied to the given issues and their thread
 * interactions.
 *
 * MUST be called BEFORE deleting issues from the database: thread interactions
 * cascade-delete with the issue via foreign key, which would leave polymorphic
 * sidecar rows stranded (since they reference interaction IDs as loose text
 * strings rather than via foreign keys).
 */
export async function purgeIssueAttentionAndDecisionData(
  db: Db,
  companyId: string,
  issueIds: string[],
): Promise<number> {
  if (issueIds.length === 0) return 0;

  // 1. Collect all interaction IDs belonging to these issues before the issue
  // cascade drops them.
  const interactionRows = await db
    .select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .where(
      and(
        eq(issueThreadInteractions.companyId, companyId),
        inArray(issueThreadInteractions.issueId, issueIds),
      ),
    );
  const interactionIds = interactionRows.map((row) => row.id);

  // 2. Build target conditions covering both direct issue references and
  // references to the issue's thread interactions.
  const queueConditions = [
    inArray(decisionQueueItems.sourceId, issueIds),
    ...(interactionIds.length > 0
      ? [
          and(
            eq(decisionQueueItems.sourceKind, "issue_thread_interaction"),
            inArray(decisionQueueItems.sourceId, interactionIds),
          ),
        ]
      : []),
  ];

  const triageConditions = [
    inArray(decisionTriage.sourceId, issueIds),
    ...(interactionIds.length > 0
      ? [
          and(
            eq(decisionTriage.sourceKind, "issue_thread_interaction"),
            inArray(decisionTriage.sourceId, interactionIds),
          ),
        ]
      : []),
  ];

  const triageEventConditions = [
    inArray(decisionTriageEvents.sourceId, issueIds),
    ...(interactionIds.length > 0
      ? [
          and(
            eq(decisionTriageEvents.sourceKind, "issue_thread_interaction"),
            inArray(decisionTriageEvents.sourceId, interactionIds),
          ),
        ]
      : []),
  ];

  const retentionConditions = [
    inArray(decisionRetention.sourceId, issueIds),
    ...(interactionIds.length > 0
      ? [
          and(
            eq(decisionRetention.sourceKind, "issue_thread_interaction"),
            inArray(decisionRetention.sourceId, interactionIds),
          ),
        ]
      : []),
  ];

  const outboxConditions = [
    inArray(decisionArchiveNotificationOutbox.sourceId, issueIds),
    inArray(decisionArchiveNotificationOutbox.originIssueId, issueIds),
    ...(interactionIds.length > 0
      ? [
          and(
            eq(decisionArchiveNotificationOutbox.sourceKind, "issue_thread_interaction"),
            inArray(decisionArchiveNotificationOutbox.sourceId, interactionIds),
          ),
        ]
      : []),
  ];

  // 3. Build dismissal keys for attention items tied to these interactions and issues
  const dismissalKeys = [
    ...issueIds.map((id) => `attention:issue:${id}`),
    ...issueIds.map((id) => `attention:review:${id}`),
    ...issueIds.map((id) => `attention:blocker_attention:${id}`),
    ...interactionIds.map((id) => `attention:issue_thread_interaction:${id}`),
  ];

  await Promise.all([
    db
      .delete(decisionQueueItems)
      .where(and(eq(decisionQueueItems.companyId, companyId), or(...queueConditions))),
    db
      .delete(decisionTriage)
      .where(and(eq(decisionTriage.companyId, companyId), or(...triageConditions))),
    db
      .delete(decisionTriageEvents)
      .where(and(eq(decisionTriageEvents.companyId, companyId), or(...triageEventConditions))),
    db
      .delete(decisionRetention)
      .where(and(eq(decisionRetention.companyId, companyId), or(...retentionConditions))),
    db
      .delete(decisionArchiveNotificationOutbox)
      .where(and(eq(decisionArchiveNotificationOutbox.companyId, companyId), or(...outboxConditions))),
    db
      .delete(inboxDismissals)
      .where(and(eq(inboxDismissals.companyId, companyId), inArray(inboxDismissals.itemKey, dismissalKeys))),
    ...(interactionIds.length > 0
      ? [
          db
            .delete(activityLog)
            .where(
              and(
                eq(activityLog.companyId, companyId),
                eq(activityLog.entityType, "issue_thread_interaction"),
                inArray(activityLog.entityId, interactionIds),
              ),
            ),
        ]
      : []),
  ]);

  return interactionIds.length;
}
