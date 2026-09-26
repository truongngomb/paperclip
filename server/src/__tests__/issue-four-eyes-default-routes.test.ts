import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres four-eyes default route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("four-eyes completion default for multi-agent companies", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() }));

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-four-eyes-default-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    enqueueWakeup.mockClear();
    await db.delete(issueComments);
    await db.delete(issueThreadInteractions);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix: string, withPeer: boolean) {
    const companyId = randomUUID();
    const workerAgentId = randomUUID();
    const peerAgentId = randomUUID();
    const memberUserId = `${prefix.toLowerCase()}-member`;
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Company`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    const agentRows = [
      {
        id: workerAgentId,
        companyId,
        name: `${prefix} Worker`,
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ];
    if (withPeer) {
      agentRows.push({
        id: peerAgentId,
        companyId,
        name: `${prefix} QA`,
        role: "qa",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
    await db.insert(agents).values(agentRows);
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: memberUserId,
      status: "active",
      membershipRole: "operator",
    });
    return { companyId, workerAgentId, peerAgentId, memberUserId };
  }

  async function seedIssue(input: {
    companyId: string;
    assigneeAgentId: string;
    identifier: string;
    status?: string;
    reviewPolicy?: "anyone" | "not_creator" | "human_only" | null;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.identifier,
      status: input.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId,
      reviewPolicy: input.reviewPolicy ?? null,
    });
    return issueId;
  }

  async function seedRun(companyId: string, agentId: string, issueId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    return runId;
  }

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {
      stalledReviewDecisionEnqueueWakeup: enqueueWakeup as any,
    }));
    testApp.use(errorHandler);
    return testApp;
  }

  function agentActor(companyId: string, agentId: string, runId: string) {
    return {
      type: "agent",
      source: "agent_key",
      companyId,
      agentId,
      runId,
    };
  }

  function boardActor(companyId: string, userId: string) {
    return {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "operator" }],
      isInstanceAdmin: false,
    };
  }

  it("rejects an agent closing its own deliverable directly in a multi-agent company", async () => {
    const seeded = await seedCompany("FEM", true);
    const issueId = await seedIssue({
      companyId: seeded.companyId,
      assigneeAgentId: seeded.workerAgentId,
      identifier: "FEM-1",
    });
    const runId = await seedRun(seeded.companyId, seeded.workerAgentId, issueId);

    const response = await request(app(agentActor(seeded.companyId, seeded.workerAgentId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      details: expect.objectContaining({
        code: "independent_verification_required",
        policy: "not_creator",
        policySource: "org_default_multi_agent",
      }),
    });
  });

  it("allows the same direct closure in a single-agent company", async () => {
    const seeded = await seedCompany("FES", false);
    const issueId = await seedIssue({
      companyId: seeded.companyId,
      assigneeAgentId: seeded.workerAgentId,
      identifier: "FES-1",
    });
    const runId = await seedRun(seeded.companyId, seeded.workerAgentId, issueId);

    const response = await request(app(agentActor(seeded.companyId, seeded.workerAgentId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ id: issueId, status: "done" });
  });

  it("allows direct closure when the issue opts out with reviewPolicy anyone", async () => {
    const seeded = await seedCompany("FEO", true);
    const issueId = await seedIssue({
      companyId: seeded.companyId,
      assigneeAgentId: seeded.workerAgentId,
      identifier: "FEO-1",
      reviewPolicy: "anyone",
    });
    const runId = await seedRun(seeded.companyId, seeded.workerAgentId, issueId);

    const response = await request(app(agentActor(seeded.companyId, seeded.workerAgentId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ id: issueId, status: "done" });
  });

  it("allows a board user to close directly in a multi-agent company", async () => {
    const seeded = await seedCompany("FEB", true);
    const issueId = await seedIssue({
      companyId: seeded.companyId,
      assigneeAgentId: seeded.workerAgentId,
      identifier: "FEB-1",
    });

    const response = await request(app(boardActor(seeded.companyId, seeded.memberUserId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ id: issueId, status: "done" });
  });

  it("lets a peer agent close the issue after the author requests review", async () => {
    const seeded = await seedCompany("FER", true);
    const issueId = await seedIssue({
      companyId: seeded.companyId,
      assigneeAgentId: seeded.workerAgentId,
      identifier: "FER-1",
    });
    const workerRunId = await seedRun(seeded.companyId, seeded.workerAgentId, issueId);
    const peerRunId = await seedRun(seeded.companyId, seeded.peerAgentId, issueId);

    // A bare in_review move is rejected (invalid_issue_disposition); the author
    // must attach a real review path — here a human reviewer via assigneeUserId.
    const moveToReview = await request(
      app(agentActor(seeded.companyId, seeded.workerAgentId, workerRunId)),
    )
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review", assigneeAgentId: null, assigneeUserId: seeded.memberUserId });
    expect(moveToReview.status, JSON.stringify(moveToReview.body)).toBe(200);

    const peerClose = await request(app(agentActor(seeded.companyId, seeded.peerAgentId, peerRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });
    expect(peerClose.status, JSON.stringify(peerClose.body)).toBe(200);
    expect(peerClose.body).toMatchObject({ id: issueId, status: "done" });
  });

  it("blocks the review requester from approving their own review in a multi-agent company", async () => {
    const seeded = await seedCompany("FEQ", true);
    const issueId = await seedIssue({
      companyId: seeded.companyId,
      assigneeAgentId: seeded.workerAgentId,
      identifier: "FEQ-1",
    });
    const workerRunId = await seedRun(seeded.companyId, seeded.workerAgentId, issueId);

    const moveToReview = await request(
      app(agentActor(seeded.companyId, seeded.workerAgentId, workerRunId)),
    )
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review", assigneeAgentId: null, assigneeUserId: seeded.memberUserId });
    expect(moveToReview.status, JSON.stringify(moveToReview.body)).toBe(200);

    const selfApproval = await request(
      app(agentActor(seeded.companyId, seeded.workerAgentId, workerRunId)),
    )
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });
    expect(selfApproval.status).toBe(403);
    expect(selfApproval.body).toMatchObject({
      details: expect.objectContaining({
        code: "review_policy_denied",
        policy: "not_creator",
      }),
    });
  });
});
