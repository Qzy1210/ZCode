/* 手机远控首页:桌面窗口的工作区 + 任务列表。
 *
 * 数据来自 mobileControllerTaskStore(订阅 Host 控制器帧);
 * 交互对齐官方移动端:按项目分组可折叠 / 按时间线平铺,可切换排序;
 * 点任务进入会话(root 渲染,见 MobileRemotePage)。
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { RemoteServiceAccess } from "@zcode/client";
import type {
  WindowHostControllerTaskRow,
  WindowHostControllerWorkspaceFact,
} from "@zcode/shared/zcode-protocol-v4";
import { useZCodeIntl } from "@zcode/ui";
import {
  createMobileControllerTaskStore,
  mobileWorkspaceKeyOf,
  type MobileHomeSnapshot,
} from "./mobileControllerTaskStore.js";

export interface MobileOpenTaskTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

type TaskSortBy = "updated" | "created";
type TaskViewMode = "workspace" | "timeline";

/** liveStatus → 状态点颜色(与桌面任务列表语义对齐)。 */
const STATUS_DOT_CLASS: Record<WindowHostControllerTaskRow["liveStatus"], string> = {
  running: "bg-sky-500",
  waiting: "bg-amber-500",
  completed: "bg-emerald-500",
  error: "bg-red-500",
  idle: "bg-foreground/25",
};

function lastPathSegment(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

export function MobileHomePage({
  services,
  onOpenTask,
}: {
  services: RemoteServiceAccess;
  onOpenTask: (target: MobileOpenTaskTarget) => void;
}) {
  const { intl } = useZCodeIntl();
  const [retryVersion, setRetryVersion] = useState(0);
  const [viewMode, setViewMode] = useState<TaskViewMode>("workspace");
  const [sortBy, setSortBy] = useState<TaskSortBy>("updated");
  const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string>>(new Set());

  const store = useMemo(
    () => createMobileControllerTaskStore(services),
    [services, retryVersion],
  );
  useEffect(() => () => store.dispose(), [store]);
  const snapshot: MobileHomeSnapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  // 首个快照迟迟不来时给出可诊断提示(桌面窗口可能已关或 Host 正忙)。
  const [slowLoad, setSlowLoad] = useState(false);
  useEffect(() => {
    if (snapshot.status !== "loading") return;
    const timer = setTimeout(() => setSlowLoad(true), 8_000);
    return () => clearTimeout(timer);
  }, [snapshot.status, retryVersion]);

  const sortedTasks = useMemo(() => {
    const pick = (row: WindowHostControllerTaskRow) =>
      sortBy === "updated" ? row.meta.updatedAt : row.meta.createdAt;
    return [...snapshot.tasks].sort(
      (left, right) => pick(right) - pick(left) || left.meta.taskId.localeCompare(right.meta.taskId),
    );
  }, [snapshot.tasks, sortBy]);

  const tasksByWorkspaceKey = useMemo(() => {
    const grouped = new Map<string, WindowHostControllerTaskRow[]>();
    for (const row of sortedTasks) {
      const key = mobileWorkspaceKeyOf(row.meta);
      const bucket = grouped.get(key);
      if (bucket) bucket.push(row);
      else grouped.set(key, [row]);
    }
    return grouped;
  }, [sortedTasks]);

  function formatRelativeTime(timestamp: number): string {
    const diff = Date.now() - timestamp;
    if (diff < 60_000) return intl.formatMessage({ id: "mobileRemote.justNow" });
    if (diff < 3_600_000) {
      return intl.formatMessage({ id: "mobileRemote.minutesAgo" }, { count: Math.floor(diff / 60_000) });
    }
    if (diff < 86_400_000) {
      return intl.formatMessage({ id: "mobileRemote.hoursAgo" }, { count: Math.floor(diff / 3_600_000) });
    }
    if (diff < 7 * 86_400_000) {
      return intl.formatMessage({ id: "mobileRemote.daysAgo" }, { count: Math.floor(diff / 86_400_000) });
    }
    return new Date(timestamp).toLocaleDateString();
  }

  function resolveWorkspaceKindLabel(
    workspace: WindowHostControllerWorkspaceFact,
    tasks: WindowHostControllerTaskRow[] | undefined,
  ): string {
    if (workspace.remoteSessionId) return intl.formatMessage({ id: "mobileRemote.kind.remote" });
    if (tasks?.some((row) => row.meta.workspacePurpose === "conversation")) {
      return intl.formatMessage({ id: "mobileRemote.kind.conversation" });
    }
    return intl.formatMessage({ id: "mobileRemote.kind.local" });
  }

  function renderTaskRow(row: WindowHostControllerTaskRow) {
    const title = row.meta.title.trim() || intl.formatMessage({ id: "mobileRemote.unnamedTask" });
    return (
      <button
        key={`${mobileWorkspaceKeyOf(row.meta)}\0${row.meta.taskId}`}
        type="button"
        className="flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors active:bg-surface-hover"
        onClick={() =>
          onOpenTask({
            workspacePath: row.meta.workspacePath,
            workspaceIdentity: row.meta.workspaceIdentity,
            taskId: row.meta.taskId,
          })
        }
      >
        <span
          className={`mt-1.5 size-2 shrink-0 rounded-full ${STATUS_DOT_CLASS[row.liveStatus]}`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 block text-ui-base/relaxed text-foreground">{title}</span>
          <span className="mt-0.5 block text-ui-xs text-foreground-subtle">
            {formatRelativeTime(row.meta.updatedAt)}
          </span>
        </span>
      </button>
    );
  }

  const allWorkspaceKeys = snapshot.workspaces.map((workspace) => mobileWorkspaceKeyOf(workspace));
  const hasAnyTask = sortedTasks.length > 0;

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="shrink-0 border-b border-border bg-background/95 px-4 pb-3 pt-4 backdrop-blur">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-ui-lg font-medium">{intl.formatMessage({ id: "mobileRemote.title" })}</h1>
          <span className="inline-flex items-center gap-1.5 text-ui-xs text-foreground-subtle">
            <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
            {intl.formatMessage({ id: "mobileRemote.connected" })}
          </span>
        </div>
        <p className="mt-1 text-ui-xs text-foreground-subtle">
          {intl.formatMessage(
            { id: "mobileRemote.summary" },
            { workspaceCount: snapshot.workspaces.length, taskCount: snapshot.tasks.length },
          )}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-lg border border-border">
            {(["workspace", "timeline"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`px-2.5 py-1 text-ui-xs transition-colors ${
                  viewMode === mode ? "bg-surface-hover text-foreground" : "text-foreground-subtle"
                }`}
                onClick={() => setViewMode(mode)}
              >
                {intl.formatMessage({
                  id: mode === "workspace" ? "mobileRemote.view.workspace" : "mobileRemote.view.timeline",
                })}
              </button>
            ))}
          </div>
          <div className="flex overflow-hidden rounded-lg border border-border">
            {(["updated", "created"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`px-2.5 py-1 text-ui-xs transition-colors ${
                  sortBy === mode ? "bg-surface-hover text-foreground" : "text-foreground-subtle"
                }`}
                onClick={() => setSortBy(mode)}
              >
                {intl.formatMessage({
                  id: mode === "updated" ? "mobileRemote.sort.updated" : "mobileRemote.sort.created",
                })}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="ml-auto px-2 py-1 text-ui-xs text-foreground-subtle"
            onClick={() =>
              setCollapsedKeys(
                collapsedKeys.size > 0 ? new Set() : new Set(allWorkspaceKeys),
              )
            }
          >
            {intl.formatMessage({
              id: collapsedKeys.size > 0 ? "mobileRemote.expandAll" : "mobileRemote.collapseAll",
            })}
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-10 pt-2">
        {snapshot.status === "loading" ? (
          <div className="flex flex-col items-center gap-3 py-16">
            <div className="size-8 animate-spin rounded-full border-2 border-border border-t-primary" />
            <p className="text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "mobileRemote.loading" })}
            </p>
            {slowLoad ? (
              <p className="max-w-xs text-center text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: "mobileRemote.slowLoad" })}
              </p>
            ) : null}
          </div>
        ) : snapshot.status === "error" ? (
          <div className="flex flex-col items-center gap-3 py-16">
            <p className="text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "mobileRemote.loadFailed" })}
            </p>
            <button
              type="button"
              className="rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-xs text-foreground-subtle active:bg-surface-hover"
              onClick={() => setRetryVersion((value) => value + 1)}
            >
              {intl.formatMessage({ id: "mobileRemote.retry" })}
            </button>
          </div>
        ) : viewMode === "timeline" ? (
          hasAnyTask ? (
            <div className="flex flex-col">{sortedTasks.map(renderTaskRow)}</div>
          ) : (
            <p className="py-16 text-center text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "mobileRemote.emptyTasks" })}
            </p>
          )
        ) : snapshot.workspaces.length === 0 ? (
          <p className="py-16 text-center text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "mobileRemote.emptyWorkspaces" })}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {snapshot.workspaces.map((workspace) => {
              const key = mobileWorkspaceKeyOf(workspace);
              const workspaceTasks = tasksByWorkspaceKey.get(key) ?? [];
              const collapsed = collapsedKeys.has(key);
              return (
                <section key={key} className="rounded-xl border border-border bg-card">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
                    onClick={() => {
                      const next = new Set(collapsedKeys);
                      if (collapsed) next.delete(key);
                      else next.add(key);
                      setCollapsedKeys(next);
                    }}
                  >
                    <span
                      className={`text-foreground-subtle transition-transform ${collapsed ? "" : "rotate-90"}`}
                      aria-hidden="true"
                    >
                      ›
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-ui-base font-medium text-foreground">
                          {lastPathSegment(workspace.workspacePath)}
                        </span>
                        <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] leading-none text-foreground-subtle">
                          {resolveWorkspaceKindLabel(workspace, workspaceTasks)}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-ui-xs text-foreground-subtle">
                        {workspace.workspacePath}
                      </span>
                    </span>
                    <span className="shrink-0 text-ui-xs text-foreground-subtle">
                      {intl.formatMessage({ id: "mobileRemote.taskCount" }, { count: workspaceTasks.length })}
                    </span>
                  </button>
                  {!collapsed ? (
                    workspaceTasks.length > 0 ? (
                      <div className="border-t border-border/60 px-0.5 py-0.5">
                        {workspaceTasks.map(renderTaskRow)}
                      </div>
                    ) : (
                      <p className="border-t border-border/60 px-3 py-3 text-ui-xs text-foreground-subtle">
                        {intl.formatMessage({ id: "mobileRemote.emptyTasks" })}
                      </p>
                    )
                  ) : null}
                </section>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
