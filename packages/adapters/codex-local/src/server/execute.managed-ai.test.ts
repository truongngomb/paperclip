import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  executeCodexAcp,
  prepareCodexRuntimeConfig,
  readPaperclipRuntimeSkillEntries,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  tempCodexHome,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  executeCodexAcp: vi.fn(async () => {
    throw new Error('ACP disabled for test');
  }),
  prepareCodexRuntimeConfig: vi.fn(async () => ({ cleanup: vi.fn(async () => undefined), notes: [] })),
  readPaperclipRuntimeSkillEntries: vi.fn(async () => []),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "codex"),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "ok" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  tempCodexHome: "/tmp/paperclip-codex-managed-ai-test-home",
}));

vi.mock("./acp.js", () => ({
  createCodexAcpExecutor: () => executeCodexAcp,
  resolveCodexExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    readPaperclipRuntimeSkillEntries,
  };
});

vi.mock("./codex-home.js", async () => {
  const actual = await vi.importActual<typeof import("./codex-home.js")>("./codex-home.js");
  return {
    ...actual,
    evaluateCodexCredentialReadiness: vi.fn(async () => ({
      managed: true,
      authMode: "api",
      ready: true,
      effectiveHome: tempCodexHome,
      sharedSourceHome: tempCodexHome,
    })),
    // Simulate isManagedCodexHomePath: returns false for temp directories outside company tree
    isManagedCodexHomePath: vi.fn((_env, _companyId, homePath: string) =>
      homePath.startsWith("/company-tree/"),
    ),
    prepareManagedCodexHome: vi.fn(async () => ({ status: "seeded", home: tempCodexHome })),
    resolveManagedCodexHomeDir: vi.fn(() => tempCodexHome),
    seedManagedCodexHome: vi.fn(async () => ({ status: "seeded", home: tempCodexHome })),
  };
});

vi.mock("./runtime-config.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-config.js")>("./runtime-config.js");
  return {
    ...actual,
    prepareCodexRuntimeConfig,
  };
});

import { execute } from "./execute.js";

function buildContext(config: Record<string, unknown> = {}) {
  return {
    runId: "run-managed-ai",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Gateway Codex",
      adapterType: "codex_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      outputInactivityTimeoutMs: null,
      engine: "cli",
      env: {},
      ...config,
    },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("codex_local managed AI connection execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes codexHome to prepareCodexRuntimeConfig when managedAiConnection is set, even if CODEX_HOME is in temp", async () => {
    const tempHome = "/tmp/paperclip-ai-company-1-grant-1/provider";
    const ctx = buildContext({
      env: {
        CODEX_HOME: tempHome,
        PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({
          providers: {
            openai_compatible: {
              name: "Company gateway",
              base_url: "https://gateway.example.com/v1",
              env_key: "OPENAI_API_KEY",
              wire_api: "responses",
            },
          },
          model_provider: "openai_compatible",
        }),
      },
      managedAiConnection: {
        provider: "openai_compatible",
        method: "api_key",
        mode: "responsible_user",
        identity: "grant-1:user-1:hash",
      },
    });

    await execute(ctx as never);

    expect(prepareCodexRuntimeConfig).toHaveBeenCalledTimes(1);
    const mockCalls = (prepareCodexRuntimeConfig as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const firstCall = mockCalls[0] as [{ codexHome: string | null }] | undefined;
    expect(firstCall).toBeDefined();
    expect(path.resolve(firstCall![0].codexHome!)).toBe(path.resolve(tempHome));
  });

  it("skips provider merge (codexHome: null) for genuine user-configured CODEX_HOME without managedAiConnection", async () => {
    const userHome = "/user/custom/.codex";
    const ctx = buildContext({
      env: {
        CODEX_HOME: userHome,
        PAPERCLIP_CODEX_PROVIDERS: "{}",
      },
    });

    await execute(ctx as never);

    expect(prepareCodexRuntimeConfig).toHaveBeenCalledTimes(1);
    const mockCalls = (prepareCodexRuntimeConfig as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const firstCall = mockCalls[0] as [{ codexHome: string | null }] | undefined;
    expect(firstCall).toBeDefined();
    expect(firstCall![0].codexHome).toBeNull();
  });
});
