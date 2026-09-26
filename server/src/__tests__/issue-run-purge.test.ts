import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  activityLog,
  agentTaskSessions,
  agents,
  companies,
  completionContracts,
  costEvents,
  createDb,
  decisionBundles,
  decisionQueueItems,
  decisionQueues,
  decisionRetention,
  decisionTriage,
  heartbeatRunEvents,
  heartbeatRuns,
  inboxDismissals,
  issueComments,
  issueThreadInteractions,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisions,
  workAssessments,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { issueService } from "../services/issues.js";
import { purgeIssueAttentionAndDecisionData, purgeIssueRunData } from "../services/issue-run-purge.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;

const companyId = randomUUID();
const agentId = randomUUID();
const issueA = randomUUID();
const issueB = randomUUID();
const issueC = randomUUID();

const runDone = randomUUID();
const runActive = randomUUID();
const runProtected = randomUUID();
const runNative = randomUUID();
const runOther = randomUUID();
const runIssueC = randomUUID();
const commentC = randomUUID();

beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("paperclip-purge-db-");
  db = createDb(database.connectionString);

  await db.insert(companies).values({ id: companyId, name: "Purge tests", issuePrefix: "PRG" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Scrub", adapterType: "claude_local" });
  await db.insert(issues).values([
    { id: issueA, companyId, title: "Task A", status: "done" },
    { id: issueB, companyId, title: "Task B", status: "todo" },
    { id: issueC, companyId, title: "Task C", status: "todo" },
  ]);

  await db.insert(heartbeatRuns).values([
    { id: runDone, companyId, agentId, status: "succeeded", contextSnapshot: { issueId: issueA } },
    { id: runActive, companyId, agentId, status: "running", contextSnapshot: { issueId: issueA } },
    { id: runProtected, companyId, agentId, status: "succeeded", nativeIssueId: issueA },
    { id: runNative, companyId, agentId, status: "succeeded", nativeIssueId: issueA, completionContractId: null },
    { id: runOther, companyId, agentId, status: "succeeded", contextSnapshot: { issueId: issueB } },
    { id: runIssueC, companyId, agentId, status: "succeeded", contextSnapshot: { issueId: issueC } },
  ]);
  await db.insert(heartbeatRunEvents).values([
    { companyId, runId: runDone, agentId, seq: 1, eventType: "log", message: "done" },
    { companyId, runId: runActive, agentId, seq: 1, eventType: "log", message: "active" },
  ]);
  await db.insert(activityLog).values({
    companyId,
    actorId: agentId,
    action: "run.started",
    entityType: "issue",
    entityId: issueA,
    runId: runDone,
  });
  await db.insert(agentTaskSessions).values([
    { companyId, agentId, adapterType: "claude_local", taskKey: issueA, lastRunId: runDone },
    { companyId, agentId, adapterType: "claude_local", taskKey: issueB, lastRunId: runOther },
    { companyId, agentId, adapterType: "claude_local", taskKey: "__heartbeat__", lastRunId: runDone },
  ]);
  await db.insert(costEvents).values({
    companyId,
    agentId,
    provider: "anthropic",
    model: "claude-sonnet-5",
    costCents: 10,
    occurredAt: new Date(),
    heartbeatRunId: runDone,
  });
  // Surviving decision provenance keeps runProtected alive.
  await db.insert(decisionBundles).values({
    companyId,
    title: "Keep me",
    summary: "References a run on a deleted issue through a live issue",
    originAgentId: agentId,
    originIssueId: issueB,
    originRunId: runProtected,
  });

  const contractId = randomUUID();
  await db.insert(completionContracts).values({
    id: contractId,
    companyId,
    issueId: issueA,
    revision: 1,
    schemaVersion: "v1",
    policyVersion: "v1",
    risk: "low",
    completionAuthority: "agent",
    incompleteCriteriaPolicy: "reopen",
    contractJson: {},
    canonicalSha256: "sha256:fixture",
    createdByActorType: "user",
    createdByActorId: "fixture",
  });
  await db.update(heartbeatRuns).set({ completionContractId: contractId }).where(eq(heartbeatRuns.id, runNative));
  await db.insert(nativeRunResults).values({
    companyId,
    issueId: issueA,
    runId: runNative,
    completionContractId: contractId,
    serverFingerprint: "fixture",
    schemaStatus: "valid",
    resultJson: {},
    canonicalSha256: "sha256:fixture",
  });
  const resultId = (
    await db.select({ id: nativeRunResults.id }).from(nativeRunResults).where(eq(nativeRunResults.runId, runNative))
  )[0]!.id;
  await db.insert(workAssessments).values({
    companyId,
    issueId: issueA,
    runId: runNative,
    contractId,
    resultId,
    triggerKind: "run_completion",
    triggerActorCompanyId: companyId,
    priorIssueStatus: "in_progress",
    priorStatusVersion: 1,
    policyVersion: "v1",
    assessmentJson: {},
    inputDigest: "sha256:fixture",
  });
  const assessmentId = (
    await db.select({ id: workAssessments.id }).from(workAssessments).where(eq(workAssessments.runId, runNative))
  )[0]!.id;
  await db.insert(statusDecisions).values({
    companyId,
    issueId: issueA,
    runId: runNative,
    assessmentId,
    decisionVersion: 1,
    policyVersion: "v1",
    fromStatus: "in_progress",
    toStatus: "done",
    reasonCode: "criteria_met",
    decisionJson: {},
    decisionDigest: "sha256:fixture",
  });
  const decisionId = (
    await db.select({ id: statusDecisions.id }).from(statusDecisions).where(eq(statusDecisions.runId, runNative))
  )[0]!.id;
  await db.insert(nativeRunFinalizations).values({
    runId: runNative,
    companyId,
    issueId: issueA,
    phase: "finalized",
    resultId,
    assessmentId,
    decisionId,
  });

  // Entity-scoped activity for issue C, including a comment cascade that the
  // activity rows outlive.
  await db.insert(issueComments).values({ id: commentC, companyId, issueId: issueC, body: "go" });
  await db.insert(activityLog).values([
    { companyId, actorId: agentId, action: "issue.updated", entityType: "issue", entityId: issueC },
    { companyId, actorId: agentId, action: "issue.commented", entityType: "issue_comment", entityId: commentC },
    { companyId, actorId: agentId, action: "agent.created", entityType: "agent", entityId: agentId },
  ]);
}, 120000);

afterAll(async () => {
  await database?.cleanup();
});

describe("purgeIssueRunData", () => {
  it("deletes terminal runs tied to the issue and keeps protected, active, and unrelated runs", async () => {
    const purged = await purgeIssueRunData(db, companyId, [issueA]);
    expect(purged).toBe(2);

    const remainingRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId));
    expect(new Set(remainingRuns.map((run) => run.id))).toEqual(
      new Set([runActive, runProtected, runOther, runIssueC]),
    );

    const remainingEvents = await db
      .select({ runId: heartbeatRunEvents.runId })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.companyId, companyId));
    expect(remainingEvents.map((event) => event.runId)).toEqual([runActive]);

    expect(
      await db.select({ id: activityLog.id }).from(activityLog).where(eq(activityLog.runId, runDone)),
    ).toEqual([]);

    const sessions = await db
      .select({ taskKey: agentTaskSessions.taskKey, lastRunId: agentTaskSessions.lastRunId })
      .from(agentTaskSessions)
      .where(eq(agentTaskSessions.companyId, companyId));
    expect(sessions).toHaveLength(2);
    expect(sessions.find((session) => session.taskKey === issueB)?.lastRunId).toBe(runOther);
    expect(sessions.find((session) => session.taskKey === "__heartbeat__")?.lastRunId).toBeNull();

    const [cost] = await db
      .select({ heartbeatRunId: costEvents.heartbeatRunId })
      .from(costEvents)
      .where(eq(costEvents.companyId, companyId));
    expect(cost?.heartbeatRunId).toBeNull();

    // Native-run family and the owned completion contract disappear with the run.
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runNative))).toEqual([]);
    expect(await db.select().from(workAssessments).where(eq(workAssessments.runId, runNative))).toEqual([]);
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.runId, runNative))).toEqual([]);
    expect(await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runNative))).toEqual([]);
    expect(await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueA))).toEqual([]);

    // Decision provenance survives with its run.
    const bundles = await db
      .select({ originRunId: decisionBundles.originRunId })
      .from(decisionBundles)
      .where(eq(decisionBundles.companyId, companyId));
    expect(bundles.map((bundle) => bundle.originRunId)).toEqual([runProtected]);
  });

  it("purges run history through issueService.remove", async () => {
    const removed = await issueService(db).remove(issueC);
    expect(removed?.id).toBe(issueC);

    expect(await db.select({ id: issues.id }).from(issues).where(eq(issues.id, issueC))).toEqual([]);
    expect(
      await db.select({ id: issues.id }).from(issues).where(inArray(issues.id, [issueA, issueB])),
    ).toHaveLength(2);

    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId));
    expect(new Set(runs.map((run) => run.id))).toEqual(new Set([runActive, runProtected, runOther]));

    // Entity-scoped activity for the removed issue and its comment is gone;
    // unrelated activity survives.
    expect(
      await db
        .select({ entityId: activityLog.entityId })
        .from(activityLog)
        .where(eq(activityLog.companyId, companyId)),
    ).toEqual([{ entityId: agentId }]);
  });

  it("purges polymorphic decision sidecars tied to an issue and its interactions", async () => {
    const issueSidecar = randomUUID();
    const interactionId = randomUUID();
    const queueId = randomUUID();

    await db.insert(issues).values({ id: issueSidecar, companyId, title: "Task with question", status: "todo" });
    await db.insert(decisionQueues).values({
      id: queueId,
      companyId,
      key: "test-questions",
      title: "Test Questions",
      createdByType: "system",
    });
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId: issueSidecar,
      kind: "ask_user_questions",
      payload: { questions: [] },
    });
    await db.insert(decisionQueueItems).values({
      companyId,
      queueId,
      sourceKind: "issue_thread_interaction",
      sourceId: interactionId,
      addedByType: "system",
    });
    await db.insert(decisionTriage).values({
      companyId,
      sourceKind: "issue_thread_interaction",
      sourceId: interactionId,
      setByType: "user",
      setByUserId: "tester",
    });
    await db.insert(decisionRetention).values({
      companyId,
      sourceKind: "issue_thread_interaction",
      sourceId: interactionId,
      sourceActivityAt: new Date(),
    });
    await db.insert(inboxDismissals).values({
      companyId,
      userId: "tester",
      itemKey: `attention:issue_thread_interaction:${interactionId}`,
    });

    // Delete the issue through issueService.remove — which should clean up
    // the polymorphic decision sidecars before the issue and interaction drop.
    const removed = await issueService(db).remove(issueSidecar);
    expect(removed?.id).toBe(issueSidecar);

    // Verify sidecars are gone, not orphaned.
    const remainingItems = await db
      .select({ id: decisionQueueItems.id })
      .from(decisionQueueItems)
      .where(eq(decisionQueueItems.sourceId, interactionId));
    expect(remainingItems).toEqual([]);

    const remainingTriage = await db
      .select({ id: decisionTriage.id })
      .from(decisionTriage)
      .where(eq(decisionTriage.sourceId, interactionId));
    expect(remainingTriage).toEqual([]);

    const remainingRetention = await db
      .select({ id: decisionRetention.id })
      .from(decisionRetention)
      .where(eq(decisionRetention.sourceId, interactionId));
    expect(remainingRetention).toEqual([]);

    const remainingDismissals = await db
      .select({ id: inboxDismissals.id })
      .from(inboxDismissals)
      .where(eq(inboxDismissals.itemKey, `attention:issue_thread_interaction:${interactionId}`));
    expect(remainingDismissals).toEqual([]);
  });
});
