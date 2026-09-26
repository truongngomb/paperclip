import { supportsLocalAiLogin } from "../services/local-ai-login-policy.js";
import { readVerifiedLocalAiCredential } from "../services/local-ai-credentials.js";
import { localAiLoginService } from "../services/local-ai-login.js";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { Router, type Request } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  type Db,
  adapterAuthSessions,
  heartbeatRuns,
  toolConnections,
  connectionGrants,
  agents,
} from "@paperclipai/db";
import {
  createAiConnectionSchema,
  aiConnectionLoginIntentSchema,
  localAiConnectionSchema,
  localAiLoginStartSchema,
  isAiConnectionCompatible,
  isAiGatewayBaseUrl,
  type AiConnectionLoginIntent,
  type AiProvider,
  type AiConnectionBinding,
} from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { accessService } from "../services/access.js";
import { logActivity } from "../services/activity-log.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { validate } from "../middleware/validate.js";

/** Agent API calls inherit authenticated run identity, never the agent's own ID. */
export function responsibleUserForAiRequest(req: Request): string | null {
  return req.actor.type === "agent"
    ? req.actor.onBehalfOfUserId ?? null
    : getActorInfo(req).actorId;
}

export async function assertAiConnectionCreateAccess(
  db: Db,
  req: Request,
  companyId: string,
  input: Pick<
    AiConnectionLoginIntent,
    "ownership" | "allAgents" | "agentIds" | "connectionId"
  >,
) {
  assertBoard(req);
  assertCompanyAccess(req, companyId);
  const actor = getActorInfo(req);
  const userId = actor.actorId;
  if (input.connectionId) {
    const [grant] = await db
      .select({
        owner: connectionGrants.subjectUserId,
        creator: toolConnections.createdByUserId,
      })
      .from(connectionGrants)
      .innerJoin(
        toolConnections,
        eq(toolConnections.id, connectionGrants.connectionId),
      )
      .where(
        and(
          eq(toolConnections.id, input.connectionId),
          eq(toolConnections.companyId, companyId),
          eq(toolConnections.connectionPurpose, "ai"),
        ),
      )
      .limit(1);
    if (!grant || (grant.owner ?? grant.creator) !== userId)
      throw forbidden(
        "Only the account owner can reconnect this AI connection",
      );
  }
  const membership = req.actor.memberships?.find(
    (m) => m.companyId === companyId && m.status === "active",
  );
  const manager =
    req.actor.source === "local_implicit" ||
    req.actor.isInstanceAdmin ||
    membership?.membershipRole === "owner" ||
    membership?.membershipRole === "admin" ||
    (await accessService(db).hasPermission(
      companyId,
      "user",
      userId,
      "tools:manage_connections",
    ));
  if (
    !input.connectionId &&
    !manager &&
    (input.ownership === "shared" || input.allAgents)
  )
    throw forbidden(
      "A connection manager must authorize company-shared access",
    );
  if (!input.connectionId && !manager && input.agentIds.length) {
    for (const id of input.agentIds) {
      if (
        !(
          await accessService(db).decide({
            actor: { type: "board", userId },
            action: "agent_config:update",
            resource: { type: "agent", companyId, agentId: id },
          })
        ).allowed
      )
        throw forbidden("You cannot configure this agent");
    }
  }
  if (membership?.membershipRole === "viewer")
    throw forbidden("Viewers cannot create AI connections");
  return userId;
}

/** Creating an agent may install a shared connection only with the existing
 * connection-configure authority. An agent actor cannot grant itself access. */
export async function canInstallSharedAiConnectionForNewAgent(
  db: Db, req: Request, companyId: string, binding: AiConnectionBinding,
): Promise<boolean> {
  if (req.actor.type !== "board" || binding.mode !== "shared") return false;
  assertCompanyAccess(req, companyId);
  const member = req.actor.memberships?.find(m => m.companyId === companyId && m.status === "active");
  if (member?.membershipRole === "viewer") return false;
  const userId = getActorInfo(req).actorId;
  const [connection] = await db.select({ creator: toolConnections.createdByUserId })
    .from(toolConnections).where(and(eq(toolConnections.companyId, companyId),
      eq(toolConnections.id, binding.connectionId), eq(toolConnections.connectionPurpose, "ai")));
  if (!connection) return false;
  return req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true ||
    connection.creator === userId || await accessService(db).hasPermission(companyId, "user", userId, "tools:manage_connections");
}

type AiGatewayDnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;
const defaultAiGatewayDnsLookup: AiGatewayDnsLookup = (hostname, options) =>
  dnsLookup(hostname, options) as Promise<Array<{ address: string; family: number }>>;

function isLoopbackGatewayHost(hostname: string) {
  return ["localhost", "127.0.0.1", "::1"].includes(
    hostname.replace(/^\[|\]$/g, "").toLowerCase(),
  );
}
function isPrivateOrReservedIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && c === 0))) ||
    (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function isPublicGatewayAddress(address: string) {
  const version = isIP(address);
  if (version === 4) return !isPrivateOrReservedIpv4(address);
  if (version !== 6) return false;
  const lower = address.toLowerCase();
  return !(lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") ||
    /^fe[89ab]/.test(lower) || lower.startsWith("ff") || lower.startsWith("100:") ||
    lower.startsWith("2001:db8:") || lower.startsWith("2001:2:") || lower.startsWith("2002:") ||
    lower.startsWith("64:ff9b:"));
}

/** Verify a caller-chosen gateway resolves only to public addresses (unless it
 * is an explicit localhost development endpoint) before sending its API key. */
export async function assertSafeAiGatewayEndpoint(
  baseUrl: string,
  lookup: AiGatewayDnsLookup = defaultAiGatewayDnsLookup,
) {
  const url = new URL(baseUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isLoopbackGatewayHost(hostname)) return;
  if (isIP(hostname)) {
    if (!isPublicGatewayAddress(hostname))
      throw unprocessable("The gateway base URL must not use a private network address.");
    return;
  }
  let addresses: Array<{ address: string; family: number }>;
  try { addresses = await lookup(hostname, { all: true, verbatim: true }); }
  catch { throw unprocessable("Could not resolve the gateway base URL. Try again."); }
  if (!addresses.length || addresses.some(({ address }) => !isPublicGatewayAddress(address)))
    throw unprocessable("The gateway base URL must not resolve to a private network address.");
}

/** Fixed provider endpoints; credentials are never sent to a caller-supplied
 * URL or through a redirect. OpenAI-compatible accounts name their own https
 * (or loopback http) gateway, which is re-checked here before any request. */
export async function validateAiApiKey(
  provider: AiProvider,
  key: string,
  request: typeof fetch = fetch,
  baseUrl?: string,
  lookup: AiGatewayDnsLookup = defaultAiGatewayDnsLookup,
) {
  const endpoints = {
    anthropic: "https://api.anthropic.com/v1/models?limit=1",
    openai: "https://api.openai.com/v1/models",
    openrouter: "https://openrouter.ai/api/v1/key",
    xai: "https://api.x.ai/v1/models",
  };
  if (provider === "openai_compatible") {
    if (!baseUrl || !isAiGatewayBaseUrl(baseUrl))
      throw unprocessable(
        "Reconnect this account with its gateway base URL. Try again.",
      );
    await assertSafeAiGatewayEndpoint(baseUrl, lookup);
  }
  const endpoint =
    provider === "openai_compatible"
      ? `${baseUrl!.replace(/\/+$/, "")}/models`
      : endpoints[provider];
  let response: Response;
  try {
    response = await request(endpoint, {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers:
        provider === "anthropic"
          ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
          : { Authorization: `Bearer ${key}` },
    });
  } catch {
    throw unprocessable("Could not verify the account. Try again.");
  }
  await response.body?.cancel();
  if (!response.ok)
    throw unprocessable(
      response.status === 401 || response.status === 403
        ? "The provider rejected this API key."
        : "The provider could not verify this account. Try again.",
    );
}

export function aiConnectionRoutes(db: Db, options: Parameters<typeof supportsLocalAiLogin>[0] = {}) {
  function assertLocalLoginAvailable() {
    if (!supportsLocalAiLogin(options)) throw unprocessable("Server-host subscription sign-in is unavailable on this hosted instance. Choose a supported sign-in environment or use an API key.");
  }
  const router = Router();
  const service = aiConnectionService(db);
  const localLogin = localAiLoginService(db);
  function assertLocalOperator(req: Request) {
    assertBoard(req);
    assertCompanyAccess(req, req.params.companyId as string);
    if (req.actor.source !== "local_implicit")
      throw forbidden("Only the local operator can connect this machine's CLI account.");
  }
  router.post("/companies/:companyId/ai-connections/local/attempts", validate(localAiLoginStartSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const { restart, ...intent } = localAiLoginStartSchema.parse(req.body);
    assertLocalLoginAvailable();
    const userId = await assertAiConnectionCreateAccess(db, req, companyId, intent);
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json(await localLogin.start(companyId, userId, intent, restart));
  });
  router.post("/companies/:companyId/ai-connections/local/check", validate(localAiConnectionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const { localSessionId, ...intent } = localAiConnectionSchema.parse(req.body);
    assertLocalLoginAvailable();
    // Only implicit local operators may inspect ambient Claude credentials.
    // Authenticated users sign in to their own company/user-scoped attempt.
    if (intent.provider === "anthropic" && !localSessionId) assertLocalOperator(req);
    const userId = await assertAiConnectionCreateAccess(db, req, companyId, intent);
    res.setHeader("Cache-Control", "no-store");
    res.json(await localLogin.check(companyId, userId, intent, localSessionId));
  });
  router.delete("/companies/:companyId/ai-connections/local/attempts/:sessionId", async (req, res) => {
    assertBoard(req);
    assertCompanyAccess(req, req.params.companyId as string);
    const id = z.string().uuid().parse(req.params.sessionId);
    await localLogin.cancel(req.params.companyId as string, getActorInfo(req).actorId, id);
    res.json({ ok: true });
  });
  router.get("/companies/:companyId/ai-connections", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const currentUserId = getActorInfo(req).actorId;
    res.setHeader("Cache-Control", "no-store");
    const agentId = req.query.agentId;
    if (agentId !== undefined && !z.string().uuid().safeParse(agentId).success)
      throw unprocessable("Invalid agent ID");
    res.json({
      currentUserId,
      connections: await service.list(
        companyId,
        currentUserId,
        agentId as string | undefined,
      ),
    });
  });
  router.get(
    "/companies/:companyId/ai-connections/:connectionId/active-runs",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      if (!z.string().uuid().safeParse(req.params.connectionId).success)
        throw unprocessable("Invalid connection ID");
      const [connection] = await db
        .select()
        .from(toolConnections)
        .where(
          and(
            eq(toolConnections.companyId, companyId),
            eq(toolConnections.id, req.params.connectionId as string),
            eq(toolConnections.connectionPurpose, "ai"),
          ),
        );
      if (!connection || !(await service.list(companyId, getActorInfo(req).actorId)).some(account => account.id === connection.id))
        throw notFound("AI connection not found");
      res.setHeader("Cache-Control", "no-store");
      res.json(
        await db
          .select({
            id: heartbeatRuns.id,
            agentId: agents.id,
            agentName: agents.name,
            status: heartbeatRuns.status,
          })
          .from(heartbeatRuns)
          .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              inArray(heartbeatRuns.status, ["queued", "running"]),
              sql`${heartbeatRuns.contextSnapshot}->'aiConnection'->>'connectionId' = ${connection.id}`,
            ),
          ),
      );
    },
  );
  router.post(
    "/companies/:companyId/ai-connections",
    validate(createAiConnectionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const input = createAiConnectionSchema.parse(req.body);
      const userId = await assertAiConnectionCreateAccess(
        db,
        req,
        companyId,
        input,
      );
      if (input.method !== "api_key")
        throw unprocessable(
          "Use the existing provider sign-in flow to connect a subscription",
        );
      const attemptStartedAt = new Date();
      await validateAiApiKey(input.provider, input.apiKey!, fetch, input.baseUrl);
      const result = await service.save(
        companyId,
        userId,
        input,
        input.apiKey!,
        undefined,
        attemptStartedAt,
      );
      res.status(201).json(result);
    },
  );
  router.post(
    "/companies/:companyId/ai-connections/local",
    validate(localAiConnectionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const { localSessionId, ...input } = localAiConnectionSchema.parse(req.body);
      assertLocalLoginAvailable();
      if (input.provider === "anthropic" && !localSessionId) assertLocalOperator(req);
      const userId = await assertAiConnectionCreateAccess(db, req, companyId, input);
      if (localSessionId || input.provider === "openai" || input.provider === "xai") {
        if (!localSessionId) throw unprocessable("Start a separate local sign-in for this connection before connecting.");
        res.status(201).json(await localLogin.complete(companyId, userId, localSessionId, input));
        return;
      }
      const attemptStartedAt = new Date();
      const credential = await readVerifiedLocalAiCredential(input.provider);
      res.status(201).json(await service.save(companyId, userId, input, credential, undefined, attemptStartedAt));
    },
  );
  router.put(
    "/companies/:companyId/ai-connections/default",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const userId = getActorInfo(req).actorId;
      if (
        req.actor.memberships?.some(
          (m) => m.companyId === companyId && m.membershipRole === "viewer",
        )
      )
        throw forbidden("Viewers cannot change defaults");
      if (!z.string().uuid().safeParse(req.body.grantId).success)
        throw unprocessable("Choose a personal connection");
      await service.setDefault(companyId, userId, req.body.grantId);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "ai_connection.default_changed",
        entityType: "connection_grant",
        entityId: req.body.grantId,
      });
      res.json({ ok: true });
    },
  );
  router.get(
    "/companies/:companyId/ai-connections/login/:sessionId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const [session] = await db
        .select({
          connectionId: adapterAuthSessions.connectionId,
          grantId: adapterAuthSessions.connectionGrantId,
        })
        .from(adapterAuthSessions)
        .where(
          and(
            eq(adapterAuthSessions.companyId, companyId),
            eq(adapterAuthSessions.startedByUserId, getActorInfo(req).actorId),
            eq(
              adapterAuthSessions.publicSessionId,
              req.params.sessionId as string,
            ),
          ),
        );
      if (!session?.connectionId)
        throw notFound("The login has not saved a connection");
      res.setHeader("Cache-Control", "no-store");
      res.json(session);
    },
  );
  return router;
}
