import { describe, expect, it } from "vitest";
import {
  AI_CONNECTION_CAPABILITIES,
  aiProviderAppSlug,
  createAiConnectionSchema,
  isAiGatewayBaseUrl,
} from "./ai-connections.js";

describe("OpenAI-compatible connections", () => {
  it("accepts only https (or loopback http) gateway base URLs without credentials", () => {
    expect(isAiGatewayBaseUrl("https://gateway.example.com/v1")).toBe(true);
    expect(isAiGatewayBaseUrl("http://127.0.0.1:8000/v1")).toBe(true);
    expect(isAiGatewayBaseUrl("http://localhost:8000")).toBe(true);
    expect(isAiGatewayBaseUrl("http://[::1]:8000")).toBe(true);
    expect(isAiGatewayBaseUrl("http://gateway.example.com/v1")).toBe(false);
    expect(isAiGatewayBaseUrl("https://user:pass@gateway.example.com")).toBe(false);
    expect(isAiGatewayBaseUrl("https://gateway.example.com/v1#fragment")).toBe(false);
    expect(isAiGatewayBaseUrl("not-a-url")).toBe(false);
  });
  it("gates the gateway fields on the provider", () => {
    const base = { name: "Gateway", ownership: "personal" as const, apiKey: "fixture", agentIds: [], allAgents: false };
    expect(createAiConnectionSchema.safeParse({
      ...base,
      provider: "openai_compatible",
      method: "api_key",
      baseUrl: "https://gateway.example.com/v1",
      wireApi: "responses",
    }).success).toBe(true);
    expect(createAiConnectionSchema.safeParse({
      ...base,
      provider: "openai_compatible",
      method: "api_key",
    }).success).toBe(false);
    expect(createAiConnectionSchema.safeParse({
      ...base,
      provider: "openai_compatible",
      method: "api_key",
      baseUrl: "https://gateway.example.com/v1",
    }).success).toBe(false);
    expect(createAiConnectionSchema.safeParse({
      ...base,
      provider: "openai_compatible",
      method: "api_key",
      baseUrl: "http://gateway.example.com/v1",
      wireApi: "responses",
    }).success).toBe(false);
    expect(createAiConnectionSchema.safeParse({
      ...base,
      provider: "openrouter",
      method: "api_key",
      baseUrl: "https://gateway.example.com/v1",
    }).success).toBe(false);
    expect(createAiConnectionSchema.safeParse({
      ...base,
      provider: "openai_compatible",
      method: "subscription",
      loginSessionId: "fixture",
    }).success).toBe(false);
    expect(AI_CONNECTION_CAPABILITIES.openai_compatible.methods.api_key?.adapters).toContain("codex_local");
    expect(aiProviderAppSlug("openai_compatible")).toBe("openai-compatible");
    expect(aiProviderAppSlug("openai")).toBe("openai");
  });
});
