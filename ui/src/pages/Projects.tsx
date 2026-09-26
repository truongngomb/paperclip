import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EntityRow } from "../components/EntityRow";
import { ProjectTile } from "../components/ProjectTile";
import { StatusBadge } from "../components/StatusBadge";
import { MembershipAction } from "../components/MembershipAction";
import { StarToggle } from "../components/StarToggle";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { formatDate, formatNumber, formatProjectBudget, projectUrl } from "../lib/utils";
import {
  isStarred,
  resourceMembershipState,
  useResourceMembershipMutation,
  useResourceMemberships,
} from "../hooks/useResourceMemberships";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tabs } from "@/components/ui/tabs";
import { PageTabBar } from "../components/PageTabBar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ArchiveRestore, ArrowUpDown, Check, Hexagon, Plus, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { useToastActions } from "../context/ToastContext";

type ProjectSortField = "name" | "updated" | "created" | "targetDate";
type ProjectSortDir = "asc" | "desc";

const PROJECT_SORT_OPTIONS: Array<{ field: ProjectSortField; label: string }> = [
  { field: "name", label: "Name" },
  { field: "updated", label: "Updated" },
  { field: "created", label: "Created" },
  { field: "targetDate", label: "Target date" },
];

function compareProjectNames(left: Project, right: Project) {
  const nameDiff = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  return nameDiff !== 0 ? nameDiff : left.id.localeCompare(right.id);
}

function projectTime(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function compareOptionalTime(
  left: Date | string | null | undefined,
  right: Date | string | null | undefined,
  sortDir: ProjectSortDir,
) {
  const leftTime = projectTime(left);
  const rightTime = projectTime(right);
  if (leftTime === null && rightTime === null) return 0;
  if (leftTime === null) return 1;
  if (rightTime === null) return -1;
  return sortDir === "asc" ? leftTime - rightTime : rightTime - leftTime;
}

function sortProjects(projects: Project[], sortField: ProjectSortField, sortDir: ProjectSortDir) {
  return [...projects].sort((left, right) => {
    let comparison = 0;
    if (sortField === "name") {
      comparison = compareProjectNames(left, right);
      return sortDir === "asc" ? comparison : -comparison;
    }

    if (sortField === "updated") comparison = compareOptionalTime(left.updatedAt, right.updatedAt, sortDir);
    else if (sortField === "created") comparison = compareOptionalTime(left.createdAt, right.createdAt, sortDir);
    else comparison = compareOptionalTime(left.targetDate, right.targetDate, sortDir);

    if (comparison === 0) comparison = compareProjectNames(left, right);
    return comparison;
  });
}

export function Projects() {
  const { selectedCompanyId } = useCompany();
  const { openNewProject } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"active" | "archived">("active");
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const [sortField, setSortField] = useState<ProjectSortField>("name");
  const [sortDir, setSortDir] = useState<ProjectSortDir>("asc");

  useEffect(() => {
    setBreadcrumbs([{ label: "Projects" }]);
  }, [setBreadcrumbs]);

  const { data: allProjects, isLoading, error } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!, { includeArchived: tab === "archived" }),
    queryFn: () => projectsApi.list(selectedCompanyId!, { includeArchived: tab === "archived" }),
    enabled: !!selectedCompanyId,
  });
  const membershipsQuery = useResourceMemberships(selectedCompanyId);
  const membershipMutation = useResourceMembershipMutation(selectedCompanyId);
  const unarchiveProject = useMutation({
    mutationFn: (projectId: string) => projectsApi.update(projectId, { archivedAt: null }, selectedCompanyId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all(selectedCompanyId!) });
      pushToast({ title: "Project has been unarchived", tone: "success" });
    },
    onError: () => pushToast({ title: "Failed to unarchive project", tone: "error" }),
  });
  const deleteProject = useMutation({
    mutationFn: (projectId: string) => projectsApi.remove(projectId, selectedCompanyId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all(selectedCompanyId!) });
      setProjectToDelete(null);
      pushToast({ title: "Project has been permanently deleted", tone: "success" });
    },
    onError: (err: any) => pushToast({ title: err?.message || "Failed to delete project", tone: "error" }),
  });
  const projects = useMemo(
    () => (allProjects ?? []).filter((project) => tab === "archived" ? Boolean(project.archivedAt) : !project.archivedAt),
    [allProjects, tab],
  );
  const sortedProjects = useMemo(
    () => sortProjects(projects, sortField, sortDir),
    [projects, sortDir, sortField],
  );
  const groupedProjects = useMemo(() => {
    const groups = {
      mine: [] as typeof sortedProjects,
      other: [] as typeof sortedProjects,
    };

    for (const project of sortedProjects) {
      const state = resourceMembershipState(membershipsQuery.data, "project", project.id);
      if (state === "left") groups.other.push(project);
      else groups.mine.push(project);
    }

    return groups;
  }, [membershipsQuery.data, sortedProjects]);
  const sortLabel = PROJECT_SORT_OPTIONS.find((option) => option.field === sortField)?.label ?? "Name";

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message="Select an organization to view projects." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={tab} onValueChange={(value) => setTab(value as "active" | "archived")}>
          <PageTabBar
            items={[
              { value: "active", label: "Active" },
              { value: "archived", label: "Archived" },
            ]}
            value={tab}
            onValueChange={(value) => setTab(value as "active" | "archived")}
          />
        </Tabs>
        <div className="flex items-center gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="w-fit text-xs" title="Sort">
                <ArrowUpDown className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
                <span>Sort: {sortLabel}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-44 p-0">
              <div className="p-2 space-y-0.5">
                {PROJECT_SORT_OPTIONS.map((option) => (
                  <button
                    key={option.field}
                    type="button"
                    className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm ${
                      sortField === option.field
                        ? "bg-accent/50 text-foreground"
                        : "text-muted-foreground hover:bg-accent/50"
                    }`}
                    onClick={() => {
                      if (sortField === option.field) {
                        setSortDir((current) => (current === "asc" ? "desc" : "asc"));
                        return;
                      }
                      setSortField(option.field);
                      setSortDir(option.field === "name" || option.field === "targetDate" ? "asc" : "desc");
                    }}
                  >
                    <span>{option.label}</span>
                    {sortField === option.field ? (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Check className="h-3 w-3" />
                        {sortDir === "asc" ? "Asc" : "Desc"}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          {tab === "active" && (
            <Button size="sm" variant="outline" onClick={openNewProject}>
              <Plus className="h-4 w-4 mr-1" />
              Add Project
            </Button>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {!isLoading && projects.length === 0 && (
        <EmptyState
          icon={Hexagon}
          message={tab === "archived" ? "No archived projects." : "No projects yet."}
          {...(tab === "active" ? { action: "Add Project", onAction: openNewProject } : {})}
        />
      )}

      {projects.length > 0 && (
        <div className="space-y-6">
          {([
            ["My Projects", groupedProjects.mine],
            ["Other Projects", groupedProjects.other],
          ] as const).map(([label, sectionProjects]) => {
            if (sectionProjects.length === 0) return null;

            return (
              <section key={label} className="space-y-2">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-medium">{label}</h2>
                  <span className="text-xs text-muted-foreground">
                    {sectionProjects.length} project{sectionProjects.length === 1 ? "" : "s"}
                  </span>
                </div>
                <Card className="block py-0 overflow-hidden divide-y divide-border">
                  {sectionProjects.map((project) => {
                    const state = resourceMembershipState(membershipsQuery.data, "project", project.id);
                    const pending = membershipMutation.isPending &&
                      membershipMutation.variables?.resourceType === "project" &&
                      membershipMutation.variables.resourceId === project.id;
                    const starPending = pending && membershipMutation.variables?.starred !== undefined;
                    const joinLeavePending = pending && membershipMutation.variables?.starred === undefined;
                    const starred = isStarred(membershipsQuery.data, "project", project.id);
                    return (
                      <EntityRow
                        key={project.id}
                        leading={<ProjectTile color={project.color ?? null} icon={project.icon ?? null} size="sm" />}
                        title={project.name}
                        subtitle={project.description ?? undefined}
                        reserveSubtitleSpace
                        secondaryRow={tab === "archived" ? (
                          <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400">
                            Archived
                          </Badge>
                        ) : undefined}
                        to={projectUrl(project)}
                        className={state === "left" ? "group text-foreground/55" : "group"}
                        trailing={
                          <div className="flex items-center gap-3">
                            <span
                              className="hidden text-xs text-muted-foreground tabular-nums sm:inline"
                              title={`${formatNumber(project.taskCount ?? 0)} task${(project.taskCount ?? 0) === 1 ? "" : "s"}`}
                            >
                              {formatNumber(project.taskCount ?? 0)} task{(project.taskCount ?? 0) === 1 ? "" : "s"}
                            </span>
                            {project.budget && (
                              <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">
                                {formatProjectBudget(project.budget)}
                              </span>
                            )}
                            {project.targetDate && (
                              <span className="hidden text-xs text-muted-foreground md:inline">
                                {formatDate(project.targetDate)}
                              </span>
                            )}
                            <StatusBadge status={project.status} />
                            {tab === "archived" && (
                              <>
                                <Button
                                  size="xs"
                                  variant="outline"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    unarchiveProject.mutate(project.id);
                                  }}
                                  disabled={unarchiveProject.isPending}
                                >
                                  <ArchiveRestore className="h-3 w-3 mr-1" />
                                  Unarchive
                                </Button>
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  className="text-destructive hover:text-destructive"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setProjectToDelete(project);
                                  }}
                                  disabled={deleteProject.isPending}
                                >
                                  <Trash2 className="h-3 w-3 mr-1" />
                                  Delete
                                </Button>
                              </>
                            )}
                            <MembershipAction
                              state={state}
                              pending={joinLeavePending}
                              pendingState={joinLeavePending ? membershipMutation.variables?.state : null}
                              resourceName={project.name}
                              onJoin={() => membershipMutation.mutate({
                                resourceType: "project",
                                resourceId: project.id,
                                resourceName: project.name,
                                state: "joined",
                              })}
                              onLeave={() => membershipMutation.mutate({
                                resourceType: "project",
                                resourceId: project.id,
                                resourceName: project.name,
                                state: "left",
                              })}
                            />
                            <StarToggle
                              size="row"
                              starred={starred}
                              pending={starPending}
                              resourceName={project.name}
                              onToggle={(next) => membershipMutation.mutate({
                                resourceType: "project",
                                resourceId: project.id,
                                resourceName: project.name,
                                starred: next,
                              })}
                            />
                          </div>
                        }
                      />
                    );
                  })}
                </Card>
              </section>
            );
          })}
        </div>
      )}

      <AlertDialog
        open={projectToDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleteProject.isPending) setProjectToDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to permanently delete &ldquo;{projectToDelete?.name}&rdquo; and all of its tasks? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteProject.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteProject.isPending || !projectToDelete}
              onClick={(event) => {
                event.preventDefault();
                if (projectToDelete) deleteProject.mutate(projectToDelete.id);
              }}
            >
              {deleteProject.isPending ? "Deleting..." : "Delete project"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
