import { AppLogo } from "@/pages/apps/AppLogo";
import { ConnectionChoiceList } from "@/features/connections/ConnectionChoiceList";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AI_PROVIDERS,
  aiConnectionProblem,
  aiDefaultMethod,
  aiGatewayHost,
  aiMethodLabel,
  bindingProblem,
  matchesAiRequirement,
  personalAiDefault,
  type AiConnectionBinding,
  type AiConnectionRequirement,
  type AiConnectionSummary,
  type AiProvider,
} from "./model";

export interface AiConnectionPickerProps {
  requirement: AiConnectionRequirement;
  /** Adapters that accept several connectors offer a switcher between them. */
  providerChoices?: { value: AiProvider; label: string }[];
  onSwitchProvider?: (provider: AiProvider) => void;
  connections: AiConnectionSummary[];
  value?: AiConnectionBinding;
  currentUserId: string;
  agentId: string;
  agentName: string;
  loading?: boolean;
  error?: string;
  readOnly?: boolean;
  onChange: (binding: AiConnectionBinding) => void;
  onClear?: () => void;
  onConnect: () => void;
  onRetry?: () => void;
}

export function AiConnectionPicker({
  requirement,
  providerChoices,
  onSwitchProvider,
  connections,
  value,
  currentUserId,
  agentId,
  loading,
  error,
  readOnly,
  onChange,
  onClear,
  onConnect,
  onRetry,
}: AiConnectionPickerProps) {
  const compatible = connections.filter((connection) =>
    matchesAiRequirement(connection, requirement),
  );
  // Deleted accounts stay out of the choice list; the full list is still used
  // below so a saved binding on a removed account keeps its recovery message.
  // Recoverable accounts remain visible but disabled, so they can direct the
  // user to reconnect rather than silently disappearing.
  const selectable = compatible.filter(
    (connection) => connection.status !== "revoked",
  );
  const personalDefault = personalAiDefault(
    connections,
    requirement,
    currentUserId,
  );
  const problem = value ? bindingProblem(
    value,
    requirement,
    connections,
    currentUserId,
    agentId,
  ) : undefined;
  const select = (
    mode: "shared",
    connection: AiConnectionSummary,
  ) =>
    onChange({
      // A shared choice carries its own connector: the same adapter may offer
      // several (OpenAI and an OpenAI-compatible gateway).
      provider: connection.provider,
      method: connection.method,
      mode,
      connectionId: connection.id,
      grantId: connection.grantId,
    });
  return (
    <section className="flex flex-col gap-4" aria-label="AI connection">
      <div className="flex items-center gap-3">
        <AppLogo
          name={AI_PROVIDERS[requirement.provider].name}
          brandKey={requirement.provider}
          logoUrl={AI_PROVIDERS[requirement.provider].logo}
          darkLogoUrl={requirement.provider === "xai" ? "/brands/adapters/grok-dark.svg" : undefined}
          size={32}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h3 className="text-sm font-semibold">AI connection</h3>
        <p className="text-xs text-muted-foreground">
          {AI_PROVIDERS[requirement.provider].name}
          {value && value.mode !== "responsible_user" && ` · ${aiMethodLabel(value.provider, value.method)}`}
        </p>
        </div>
        {providerChoices && providerChoices.length > 1 && onSwitchProvider && !readOnly && (
          <Select
            value={requirement.provider}
            onValueChange={(next) => onSwitchProvider(next as AiProvider)}
          >
            <SelectTrigger aria-label="Connector" className="h-8 w-fit max-w-44 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {providerChoices.map((choice) => (
                <SelectItem key={choice.value} value={choice.value}>{choice.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {loading ? (
        <div role="status" aria-label="Loading AI connections">
          <Skeleton className="h-24 w-full" />
        </div>
      ) : error ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          {onRetry && (
            <Button type="button" variant="outline" onClick={onRetry}>
              Retry connections
            </Button>
          )}
        </div>
      ) : (
        <>
          <ConnectionChoiceList
            disabled={readOnly}
            selectedId={value?.mode === "responsible_user" ? "responsible_user" : value?.connectionId}
            choices={[
              { id: "responsible_user", name: "Responsible user’s connection", description: <>
                <span className="block">For you: {personalDefault?.name ?? "Not connected"}</span>
                <span className="block">Other users’ tasks use their own {AI_PROVIDERS[requirement.provider].name} connection.</span>
              </> },
              ...selectable.filter((connection) => connection.ownership === "shared").map((connection) => ({
                id: connection.id, name: connection.name,
                disabled: Boolean(aiConnectionProblem(connection)),
                description: <>Company shared · {aiMethodLabel(connection.provider, connection.method)}{connection.baseUrl ? ` · ${aiGatewayHost(connection.baseUrl)}` : ""}{connection.accountLabel ? ` · ${connection.accountLabel}` : ""}{aiConnectionProblem(connection) ? ` · ${aiConnectionProblem(connection)}` : ""}</>,
              })),
            ]}
            onSelect={(id) => {
              if (id === "responsible_user") onChange({provider: requirement.provider, method: personalDefault?.method ?? requirement.method ?? aiDefaultMethod(requirement.provider), mode: "responsible_user"});
              else { const connection = selectable.find((item) => item.id === id)!; select("shared", connection); }
            }}
          />
          {problem && (
            <p role="status" className="text-sm text-destructive">
              {problem}
            </p>
          )}
          {!readOnly && (
            <div className="flex flex-wrap justify-end gap-2">
              {value && onClear && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={onClear}
                >
                  Use existing authentication instead
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={onConnect}
              >
                Connect another account
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
