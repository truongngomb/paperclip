import { useCallback, useEffect, useState } from "react";
import { Download, History, Trash2 } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { PageTabBar } from "@/components/PageTabBar";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useNavigate, useSearchParams } from "@/lib/router";
import { Costs } from "@/pages/Costs";
import { Timeline } from "@/pages/Timeline";
import { AuditFeed, type AuditFeedActions, type AuditFeedMode } from "./AuditFeed";
import { AuditRuns } from "./AuditRuns";
import { RoutineAuditActivity } from "./RoutineAuditActivity";
import {
  AUDIT_SECTIONS,
  auditScopeFromSearchParams,
  auditSectionHref,
  type AuditSection,
} from "./audit-navigation";

export function AuditHub({ section }: { section: AuditSection }) {
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activityActions, setActivityActions] = useState<AuditFeedActions | null>(null);
  const scope = auditScopeFromSearchParams(searchParams);
  const mode: AuditFeedMode = scope.mode === "agents" ? "agents" : "all";
  const routineId = scope.entityType === "routine" ? scope.entityId ?? undefined : undefined;
  const actionParam = searchParams.get("action");
  const actionDomain = [
    "issue.",
    "agent.",
    "heartbeat.",
    "approval.",
    "project.",
    "goal.",
    "tool_",
    "cost.",
    "company.",
  ].includes(actionParam ?? "") ? actionParam! : "__all";

  useEffect(() => {
    const current = AUDIT_SECTIONS.find((candidate) => candidate.value === section);
    setBreadcrumbs([
      { label: "Audit", href: section === "activity" ? undefined : "/activity" },
      ...(section === "activity" || !current ? [] : [{ label: current.label }]),
    ]);
  }, [section, setBreadcrumbs]);

  const handleModeChange = useCallback(
    (next: AuditFeedMode) => {
      setSearchParams(
        (current) => {
          const params = new URLSearchParams(current);
          if (next === "agents") params.set("mode", "agents");
          else params.delete("mode");
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const handleActionDomainChange = useCallback(
    (next: string) => {
      setSearchParams(
        (current) => {
          const params = new URLSearchParams(current);
          if (next === "__all") params.delete("action");
          else params.set("action", next);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={History} message="Select an organization to view Audit." />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Audit</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            Review what happened, inspect agent runs, and understand the costs and budget controls
            behind your organization.
          </p>
        </div>
        {section === "activity" && activityActions && (activityActions.canExport || activityActions.canErase) ? (
          <div className="flex flex-wrap gap-2">
            {activityActions.canExport ? (
              <Button
                variant="outline"
                size="sm"
                onClick={activityActions.exportCsv}
                disabled={activityActions.exporting}
              >
                <Download className="mr-1.5 h-4 w-4" />
                {activityActions.exporting ? "Exporting…" : "Export CSV"}
              </Button>
            ) : null}
            {activityActions.canErase ? (
              <Button
                variant="destructive"
                size="sm"
                onClick={activityActions.eraseAuditLogs}
                disabled={activityActions.erasing}
              >
                <Trash2 className="mr-1.5 h-4 w-4" />
                {activityActions.erasing ? "Erasing…" : "Erase audit logs"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <Tabs
        value={section}
        onValueChange={(value) => {
          const next = value as AuditSection;
          navigate(auditSectionHref(next, scope));
        }}
      >
        <PageTabBar items={AUDIT_SECTIONS} value={section} align="start" />
      </Tabs>

      {section === "activity" && routineId ? (
        <RoutineAuditActivity companyId={selectedCompanyId} routineId={routineId} />
      ) : section === "activity" ? (
        <AuditFeed
          companyId={selectedCompanyId}
          hideHeader
          mode={mode}
          onModeChange={handleModeChange}
          actionDomain={actionDomain}
          onActionDomainChange={handleActionDomainChange}
          onActionsChange={setActivityActions}
          lockedAgentId={scope.agentId ?? undefined}
          lockedRunId={scope.runId ?? undefined}
          lockedEntity={
            scope.entityType && scope.entityId
              ? { type: scope.entityType, id: scope.entityId }
              : undefined
          }
        />
      ) : section === "runs" ? (
        <AuditRuns companyId={selectedCompanyId} routineId={routineId} />
      ) : section === "budgets" ? (
        <Costs embedded initialTab="budgets" lockTab />
      ) : section === "timeline" ? (
        <Timeline embedded />
      ) : (
        <Costs embedded initialTab="overview" hideBudgetsTab />
      )}
    </div>
  );
}
