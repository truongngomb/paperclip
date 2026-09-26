import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  aiConnectionBindingSchema,
  isAiConnectionCompatible,
  type AiConnectionBinding,
  type AiAuthMethod,
  type AiProvider,
} from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { AiConnectionPicker } from "./AiConnectionPicker";
import { AiConnectionLegacyNotice } from "./AiConnectionManagement";
import { AiConnectionCredentialStep } from "./AiConnectionCredentialStep";
import { AI_PROVIDERS, aiDefaultMethod } from "./model";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

/** Every connector an adapter can authenticate with; the first is the default. */
export function aiProvidersForAdapter(
  adapterType: string,
): readonly AiProvider[] | undefined {
  return (
    {
      claude_local: ["anthropic"],
      codex_local: ["openai", "openai_compatible"],
      opencode_local: ["openrouter"],
      grok_local: ["xai"],
    } as Record<string, readonly AiProvider[]>
  )[adapterType];
}
export function aiProviderForAdapter(
  adapterType: string,
): AiProvider | undefined {
  return aiProvidersForAdapter(adapterType)?.[0];
}
export function AiConnectionField({
  companyId,
  agentId,
  agentName,
  adapterType,
  model,
  value,
  onChange,
  environmentId,
  legacy = false,
  readOnly = false,
}: {
  companyId: string;
  agentId?: string;
  agentName: string;
  adapterType: string;
  model?: string;
  value?: AiConnectionBinding;
  onChange: (binding: AiConnectionBinding | null) => void;
  environmentId?: string;
  legacy?: boolean;
  readOnly?: boolean;
}) {
  const providers = aiProvidersForAdapter(adapterType);
  const [switchedProvider, setSwitchedProvider] = useState<AiProvider>();
  // Follow an existing binding's connector; otherwise the adapter default or
  // the connector the user last switched the picker to.
  const provider =
    value && providers?.includes(value.provider)
      ? value.provider
      : switchedProvider && providers?.includes(switchedProvider)
        ? switchedProvider
        : providers?.[0];
  const returnFocus = useRef<HTMLElement | null>(null);
  const restoreFocus = (event: Event) => { event.preventDefault(); returnFocus.current?.focus(); };
  const [adopting, setAdopting] = useState(false);
  const [pendingAdoption, setPendingAdoption] = useState<AiConnectionBinding>();
  const [connecting, setConnecting] = useState(false);
  const changeBinding = (next: AiConnectionBinding) => {
    if (legacy && !value) { if (!connecting) returnFocus.current = document.activeElement as HTMLElement; setPendingAdoption(next); }
    else onChange(next);
  };
  const client = useQueryClient();
  const accounts = useQuery({
    queryKey: ["ai-connections", companyId, agentId],
    queryFn: () => aiConnectionsApi.list(companyId, agentId),
    enabled: Boolean(provider),
  });
  const method: AiAuthMethod = (value?.mode !== "responsible_user" ? value?.method : undefined)
    ?? accounts.data?.connections.find((account) => account.provider === provider && account.isDefault)?.method
    ?? (provider ? aiDefaultMethod(provider) : "subscription");
  if (!provider) return null;
  if (legacy && !value && !adopting)
    return (
      <AiConnectionLegacyNotice
        readOnly={readOnly}
        onAdopt={() => setAdopting(true)}
      />
    );
  return (
    <div className="space-y-4">
      {value && (adapterType !== "opencode_local" || Boolean(model)) && !isAiConnectionCompatible(value, adapterType, model) && (
        <p role="alert" className="text-sm text-destructive">
          This connection does not support the current harness and model. Choose
          a compatible connection before saving.
        </p>
      )}
      <AiConnectionPicker
        requirement={{ companyId, provider: provider! }}
        providerChoices={
          providers && providers.length > 1
            ? providers.map((choice) => ({
                value: choice,
                label: AI_PROVIDERS[choice].name,
              }))
            : undefined
        }
        onSwitchProvider={(next) => {
          setSwitchedProvider(next);
          changeBinding({ provider: next, method: aiDefaultMethod(next), mode: "responsible_user" });
        }}
        connections={accounts.data?.connections ?? []}
        value={value}
        currentUserId={accounts.data?.currentUserId ?? ""}
        agentId={agentId ?? ""}
        agentName={agentName}
        readOnly={readOnly}
        loading={accounts.isPending}
        error={accounts.error?.message}
        onChange={(binding) =>
          changeBinding(aiConnectionBindingSchema.parse(binding))
        }
        onClear={value ? () => onChange(null) : undefined}
        onConnect={() => { returnFocus.current = document.activeElement as HTMLElement; setConnecting(true); }}
        onRetry={() => void accounts.refetch()}
      />
      <Dialog
        open={Boolean(pendingAdoption)}
        onOpenChange={(open) => {
          if (!open) setPendingAdoption(undefined);
        }}
      >
        <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-2xl" onCloseAutoFocus={restoreFocus}>
          <DialogHeader>
            <DialogTitle>Adopt Connections for {agentName}</DialogTitle>
            <DialogDescription>
              Saving tests this account in {agentName}’s environment before
              replacing its existing authentication. Other agents keep their
              current configuration.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm">
            {pendingAdoption?.mode === "responsible_user"
              ? `Responsible user’s default. For you: ${accounts.data?.connections.find((account) => account.isDefault && account.provider === (pendingAdoption?.provider ?? provider))?.name ?? "Not connected"}. Other users use their own default.`
              : accounts.data?.connections.find(
                  (account) => account.id === pendingAdoption?.connectionId,
                )?.name}
          </p>
          <p className="text-xs text-muted-foreground">
            After adoption, missing credentials block execution. Previous
            authentication will not be used as a fallback.
          </p>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPendingAdoption(undefined)}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (pendingAdoption) onChange(pendingAdoption);
                setPendingAdoption(undefined);
              }}
            >
              Use this binding when saved
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={connecting} onOpenChange={setConnecting}>
        <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-2xl" onCloseAutoFocus={restoreFocus}>
          <DialogHeader>
            <DialogTitle>Connect account</DialogTitle>
          </DialogHeader>
          <AiConnectionCredentialStep
            companyId={companyId}
            provider={provider!}
            initialMethod={method}
            name={`My ${AI_PROVIDERS[provider!].name} ${method === "subscription" ? "subscription" : "API"}`}
            ownership="personal"
            agentIds={agentId ? [agentId] : []}
            allAgents={false}
            environmentId={environmentId}
            onCancel={() => setConnecting(false)}
            onComplete={() => {
              void client.invalidateQueries({
                queryKey: ["ai-connections", companyId],
              });
              setConnecting(false);
              changeBinding({ provider: provider!, method, mode: "responsible_user" });
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
