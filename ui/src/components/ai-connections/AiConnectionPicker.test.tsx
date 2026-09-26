// @vitest-environment jsdom
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiConnectionPicker } from "./AiConnectionPicker";
import type { AiConnectionSummary } from "./model";

let root: Root | undefined;
afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

const requirement = { companyId: "company-1", provider: "openai_compatible" as const };
const connected: AiConnectionSummary = {
  ...requirement,
  method: "api_key",
  id: "connected",
  grantId: "grant-connected",
  name: "Live gateway",
  ownership: "shared",
  status: "connected",
  baseUrl: "https://gateway.example.com/v1",
};
const revoked: AiConnectionSummary = {
  ...connected,
  id: "revoked",
  grantId: "grant-revoked",
  name: "Removed gateway",
  status: "revoked",
};
const unavailable: AiConnectionSummary = {
  ...connected,
  id: "unavailable",
  grantId: "grant-unavailable",
  name: "Audience gateway",
  unavailableReason: "Not in the shared audience",
};

function mount(overrides: Partial<Parameters<typeof AiConnectionPicker>[0]> = {}) {
  const props: Parameters<typeof AiConnectionPicker>[0] = {
    requirement,
    connections: [connected, revoked, unavailable],
    value: undefined,
    currentUserId: "board",
    agentId: "agent-1",
    agentName: "Chief of Staff",
    onChange: vi.fn(),
    onConnect: vi.fn(),
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(<AiConnectionPicker {...props} />));
  return { props, container };
}

describe("AiConnectionPicker", () => {
  it("omits revoked accounts while keeping recoverable accounts visible", () => {
    const { container } = mount();
    const choices = [...container.querySelectorAll('[role="listitem"], [role="radio"], button')];
    expect(choices.some((choice) => choice.textContent?.includes("Live gateway"))).toBe(true);
    expect(choices.some((choice) => choice.textContent?.includes("Removed gateway"))).toBe(false);
    expect(choices.some((choice) => choice.textContent?.includes("Audience gateway"))).toBe(true);
  });
  it("keeps recovery messaging for a saved binding on a removed account", () => {
    const { container } = mount({
      value: { provider: "openai_compatible", method: "api_key", mode: "shared", connectionId: "revoked", grantId: "grant-revoked" },
    });
    expect(container.textContent).toContain("Revoked. Reconnect this account to continue.");
    // The removed account itself stays out of the choice list.
    expect(container.textContent).not.toContain("Removed gateway");
  });
});
