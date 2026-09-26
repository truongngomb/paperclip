import { z } from "zod";

/** Runtime authentication is a separate transport, never a tool or channel. */
export const connectionPurposeTransportSchema = z.discriminatedUnion(
  "connectionPurpose",
  [
    z.object({
      connectionPurpose: z.literal("tool"),
      transport: z.enum(["mcp_remote", "rest_api", "local_stdio"]),
    }),
    z.object({
      connectionPurpose: z.literal("channel"),
      transport: z.enum(["chat_sdk", "rest_api"]),
      config: z.object({ provider: z.string().optional() }).passthrough().optional(),
    }).refine(
      (connection) => connection.transport === "chat_sdk" || connection.config?.provider === "agentmail",
      { message: "REST channel connections require the AgentMail provider", path: ["config", "provider"] },
    ),
    z.object({
      connectionPurpose: z.literal("ai"),
      transport: z.literal("runtime_auth"),
    }),
  ],
);
export type ConnectionPurposeTransport = z.infer<
  typeof connectionPurposeTransportSchema
>;

export const AI_PROVIDERS = [
  "anthropic",
  "openai",
  "openai_compatible",
  "openrouter",
  "xai",
] as const;
export const aiProviderSchema = z.enum(AI_PROVIDERS);
export const aiAuthMethodSchema = z.enum(["subscription", "api_key"]);
export type AiProvider = z.infer<typeof aiProviderSchema>;
export type AiAuthMethod = z.infer<typeof aiAuthMethodSchema>;

/** App catalog slugs are kebab-case, whereas runtime provider IDs retain
 * their adapter-compatible underscore form. Keep this translation centralized
 * for gallery links, recovery intents, and stored application provenance. */
export function aiProviderAppSlug(provider: AiProvider): string {
  return provider === "openai_compatible" ? "openai-compatible" : provider;
}

const requirement = { provider: aiProviderSchema, method: aiAuthMethodSchema };
export const aiConnectionBindingSchema = z.discriminatedUnion("mode", [
  z.object({
    provider: aiProviderSchema,
    // Retained on the wire for older servers during rolling upgrades. The
    // responsible user's provider default determines the actual run method.
    method: aiAuthMethodSchema,
    mode: z.literal("responsible_user"),
  }).strict(),
  z
    .object({
      ...requirement,
      mode: z.literal("shared"),
      connectionId: z.string().uuid(),
      grantId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      ...requirement,
      // Legacy wire format only; human access still applies. New UI never creates it.
      mode: z.literal("delegated"),
      connectionId: z.string().uuid(),
      grantId: z.string().uuid(),
    })
    .strict(),
]);
export type AiConnectionBinding = z.infer<typeof aiConnectionBindingSchema>;
export const aiConnectionMetadataSchema = z.object(requirement).strict();
export type AiConnectionMetadata = z.infer<typeof aiConnectionMetadataSchema>;

export const aiGatewayWireApiSchema = z.enum(["chat", "responses"]);
export type AiGatewayWireApi = z.infer<typeof aiGatewayWireApiSchema>;
/** Gateway routing stored beside the AI metadata for OpenAI-compatible accounts. */
export const aiGatewayConfigSchema = z
  .object({
    baseUrl: z.string().trim().min(1).max(2048),
    wireApi: aiGatewayWireApiSchema,
  })
  .strict();
export type AiGatewayConfig = z.infer<typeof aiGatewayConfigSchema>;

/** The gateway endpoint is company-chosen, so restrict it to https (loopback
 * http allowed for local model servers) and reject embedded credentials. */
export function isAiGatewayBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" &&
      // URL.hostname keeps the brackets on IPv6 literals.
      ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname))
  );
}

/** Existing integrations only. This table describes compatibility, never routing. */
export const AI_CONNECTION_CAPABILITIES: Record<
  AiProvider,
  {
    name: string;
    methods: Partial<
      Record<AiAuthMethod, { adapters: readonly string[]; envKey: string }>
    >;
  }
> = {
  anthropic: {
    name: "Claude",
    methods: {
      subscription: {
        adapters: ["claude_local"],
        envKey: "CLAUDE_CODE_OAUTH_TOKEN",
      },
      api_key: { adapters: ["claude_local"], envKey: "ANTHROPIC_API_KEY" },
    },
  },
  openai: {
    name: "OpenAI",
    methods: {
      subscription: { adapters: ["codex_local"], envKey: "CODEX_HOME" },
      api_key: { adapters: ["codex_local"], envKey: "OPENAI_API_KEY" },
    },
  },
  openai_compatible: {
    name: "OpenAI-compatible",
    methods: {
      // The gateway credential rides OPENAI_API_KEY; codex reads the endpoint
      // from the merged model_providers config (PAPERCLIP_CODEX_PROVIDERS).
      api_key: { adapters: ["codex_local"], envKey: "OPENAI_API_KEY" },
    },
  },
  openrouter: {
    name: "OpenRouter",
    methods: {
      api_key: { adapters: ["opencode_local"], envKey: "OPENROUTER_API_KEY" },
    },
  },
  xai: {
    name: "Grok",
    methods: {
      subscription: { adapters: ["grok_local"], envKey: "GROK_HOME" },
      api_key: { adapters: ["grok_local"], envKey: "XAI_API_KEY" },
    },
  },
};
export function isAiConnectionCompatible(
  requirement: AiConnectionMetadata | AiConnectionBinding,
  adapterType: string,
  model?: unknown,
  runnerProvider?: unknown,
  acpxAgent?: unknown,
): boolean {
  if (adapterType === "paperclip_runner")
    adapterType =
      runnerProvider === "claude" ||
      (runnerProvider === "acpx" && acpxAgent === "claude")
        ? "claude_local"
        : runnerProvider === "codex"
          ? "codex_local"
          : runnerProvider === "opencode"
            ? "opencode_local"
            : "unsupported";
  const methods = AI_CONNECTION_CAPABILITIES[requirement.provider].methods;
  const candidates = "mode" in requirement && requirement.mode === "responsible_user"
    ? Object.values(methods)
    : requirement.method ? [methods[requirement.method]] : [];
  return (
    candidates.some((method) => method?.adapters.includes(adapterType)) &&
    (requirement.provider !== "openrouter" ||
      (typeof model === "string" && model.startsWith("openrouter/")))
  );
}
export type AiConnectionUnavailableReason =
  | "responsible_user_missing"
  | "membership_missing"
  | "default_missing"
  | "connection_missing"
  | "connection_unavailable"
  | "incompatible"
  | "access_denied"
  | "credential_missing";
export interface AiConnectionAttribution {
  connectionId: string;
  grantId: string;
  provider: AiProvider;
  method: AiAuthMethod;
  mode: AiConnectionBinding["mode"];
  responsibleUserId: string | null;
}
export type AiConnectionResolution =
  | { ok: true; attribution: AiConnectionAttribution }
  | { ok: false; reason: AiConnectionUnavailableReason; message: string };

export interface AiManagedConnectionSummary {
  id: string;
  grantId: string;
  companyId: string;
  provider: AiProvider;
  method: AiAuthMethod;
  name: string;
  accountLabel?: string;
  baseUrl?: string;
  wireApi?: AiGatewayWireApi;
  ownership: "personal" | "shared";
  ownerUserId?: string;
  ownerName?: string;
  isDefault: boolean;
  status: "connected" | "needs_attention" | "expired" | "revoked";
  unavailableReason?: string;
}
export const createAiConnectionSchema = z
  .object({
    ...requirement,
    name: z.string().trim().min(1).max(160),
    ownership: z.enum(["personal", "shared"]),
    apiKey: z.string().trim().min(1).max(32768).optional(),
    loginSessionId: z.string().max(128).optional(),
    connectionId: z.string().uuid().optional(),
    baseUrl: z.string().trim().min(1).max(2048).optional(),
    wireApi: aiGatewayWireApiSchema.optional(),
    agentIds: z.array(z.string().uuid()).max(1000).default([]),
    allAgents: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!AI_CONNECTION_CAPABILITIES[v.provider].methods[v.method])
      ctx.addIssue({ code: "custom", message: "Unsupported sign-in method" });
    if (
      v.method === "api_key"
        ? !v.apiKey || Boolean(v.loginSessionId)
        : !v.loginSessionId || Boolean(v.apiKey)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Provide exactly the credential for the selected sign-in method",
      });
    }
    if (v.provider === "openai_compatible") {
      if (!v.baseUrl || !isAiGatewayBaseUrl(v.baseUrl))
        ctx.addIssue({
          code: "custom",
          path: ["baseUrl"],
          message:
            "Enter the gateway's https base URL (http is allowed for localhost only)",
        });
      if (!v.wireApi)
        ctx.addIssue({
          code: "custom",
          path: ["wireApi"],
          message: "Choose the gateway protocol",
        });
    } else if (v.baseUrl || v.wireApi) {
      ctx.addIssue({
        code: "custom",
        message: "Only OpenAI-compatible connections take a gateway base URL",
      });
    }
  });
export type CreateAiConnection = z.infer<typeof createAiConnectionSchema>;

export const aiConnectionLoginIntentSchema = z
  .object({
    provider: aiProviderSchema,
    method: z.literal("subscription"),
    name: z.string().trim().min(1).max(160),
    ownership: z.enum(["personal", "shared"]),
    connectionId: z.string().uuid().optional(),
    agentIds: z.array(z.string().uuid()).max(1000).default([]),
    allAgents: z.boolean().default(false),
  })
  .strict();
export type AiConnectionLoginIntent = z.infer<
  typeof aiConnectionLoginIntentSchema
>;

export const localAiConnectionSchema = aiConnectionLoginIntentSchema.extend({
  localSessionId: z.string().uuid().optional(),
});
export const localAiLoginStartSchema = aiConnectionLoginIntentSchema.extend({ restart: z.boolean().optional() });
export interface LocalAiLoginStatus {
  status: "ready" | "sign_in_required" | "expired";
}
export interface LocalAiLoginAttempt {
  sessionId: string;
  command: string;
  expiresAt: string;
}

/** Preview-era copies of rotating local credentials must be reconnected. */
export function aiSubscriptionNeedsIsolatedLogin(config: Record<string, unknown> | undefined): boolean {
  const metadata = aiConnectionMetadataSchema.safeParse(config?.ai);
  return metadata.success && metadata.data.method === "subscription" &&
    (metadata.data.provider === "openai" || metadata.data.provider === "xai") &&
    config?.aiIsolatedSubscription !== true;
}
