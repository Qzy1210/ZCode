/* App 侧任务数据层:订阅 Host 控制器的 workspaces / tasks-index 两个 topic。
 * 与 packages/web/src/remote/mobileControllerTaskStore.ts 同源协议;
 * P1 再抽成共享包,当前为 P0 验证先直接复制。
 */
import type { RemoteServiceAccess } from "@zcode/client";
import {
  CONTROLLER_TASKS_INDEX_TOPIC,
  CONTROLLER_WORKSPACES_TOPIC,
  isWindowHostControllerFrameGap,
  type WindowHostControllerCursor,
  type WindowHostControllerTaskFrame,
  type WindowHostControllerTaskRow,
  type WindowHostControllerWorkspaceFact,
  type WindowHostControllerWorkspaceFrame,
} from "@zcode/shared/zcode-protocol-v4";

export type TaskStoreStatus = "loading" | "ready" | "error";

export interface TaskStoreSnapshot {
  status: TaskStoreStatus;
  /** 当前桌面窗口 Host 的全部工作区(含离线远程)。 */
  workspaces: WindowHostControllerWorkspaceFact[];
  /** 非归档任务(含 pinned),按地址去重。 */
  tasks: WindowHostControllerTaskRow[];
}

export interface TaskStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): TaskStoreSnapshot;
  dispose(): void;
}

/** 身份隔离键:identity ?? path(与仓库 workspaceIdentity 规则一致)。 */
export function workspaceKeyOf(scope: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  return scope.workspaceIdentity?.trim() || scope.workspacePath;
}

function taskAddressKey(address: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}): string {
  return `${workspaceKeyOf(address)}\0${address.taskId}`;
}

export function createTaskStore(services: RemoteServiceAccess): TaskStore {
  const controller = services.windowControllerService;
  const workspaces = new Map<string, WindowHostControllerWorkspaceFact>();
  const tasks = new Map<string, WindowHostControllerTaskRow>();
  const listeners = new Set<() => void>();
  const cursors = new Map<string, WindowHostControllerCursor>();
  const subscriptionIds = new Set<string>();
  let status: TaskStoreStatus = "loading";
  let disposed = false;
  let snapshot: TaskStoreSnapshot = { status, workspaces: [], tasks: [] };

  function rebuildSnapshot(): void {
    const nextTasks = Array.from(tasks.values())
      .filter((row) => !row.membership.archived)
      .sort(
        (left, right) =>
          right.meta.updatedAt - left.meta.updatedAt ||
          left.meta.taskId.localeCompare(right.meta.taskId),
      );
    const nextWorkspaces = Array.from(workspaces.values()).sort((left, right) =>
      workspaceKeyOf(left).localeCompare(workspaceKeyOf(right)),
    );
    snapshot = { status, workspaces: nextWorkspaces, tasks: nextTasks };
  }

  function notify(): void {
    rebuildSnapshot();
    for (const listener of listeners) listener();
  }

  function applyFrame(
    frame: WindowHostControllerTaskFrame | WindowHostControllerWorkspaceFrame,
  ): void {
    if (frame.topic === CONTROLLER_WORKSPACES_TOPIC) {
      const workspaceFrame = frame as WindowHostControllerWorkspaceFrame;
      if (workspaceFrame.payload.kind === "snapshot") {
        workspaces.clear();
        for (const fact of workspaceFrame.payload.snapshot.workspaces) {
          workspaces.set(workspaceKeyOf(fact), fact);
        }
      } else {
        for (const delta of workspaceFrame.payload.deltas) {
          if (delta.op === "workspace.upserted") {
            workspaces.set(workspaceKeyOf(delta.workspace), delta.workspace);
          } else {
            workspaces.delete(workspaceKeyOf(delta));
          }
        }
      }
      return;
    }
    const taskFrame = frame as WindowHostControllerTaskFrame;
    if (taskFrame.payload.kind === "snapshot") {
      tasks.clear();
      for (const row of taskFrame.payload.snapshot.tasks) {
        tasks.set(taskAddressKey(row.address), row);
      }
    } else {
      for (const delta of taskFrame.payload.deltas) {
        if (delta.op === "task.upserted") {
          tasks.set(taskAddressKey(delta.task.address), delta.task);
        } else {
          tasks.delete(taskAddressKey(delta.address));
        }
      }
    }
  }

  // 先挂帧监听再订阅,避免 ack 与首个 snapshot 之间丢帧(与 web 端同序)。
  const frameDisposable = controller.onDynamicControllerFrame()(
    (frame: WindowHostControllerTaskFrame | WindowHostControllerWorkspaceFrame) => {
      if (disposed) return;
      const cursor = cursors.get(frame.subscriptionId);
      if (
        cursor &&
        frame.payload.kind !== "snapshot" &&
        isWindowHostControllerFrameGap(cursor, frame)
      ) {
        void controller
          .resyncControllerV4({
            subscriptionId: frame.subscriptionId,
            base: { logEpoch: cursor.logEpoch, seq: cursor.seq },
            forceSnapshot: true,
          })
          .catch(() => {});
        return;
      }
      cursors.set(frame.subscriptionId, {
        subscriptionId: frame.subscriptionId,
        logEpoch: frame.logEpoch,
        seq: frame.toSeq,
      });
      applyFrame(frame);
      if (status === "loading") status = "ready";
      notify();
    },
  );

  void Promise.all(
    [CONTROLLER_WORKSPACES_TOPIC, CONTROLLER_TASKS_INDEX_TOPIC].map(async (topic) => {
      const result = await controller.subscribeControllerV4({
        topic,
        visibility: "foreground",
      });
      if (disposed) {
        await controller.unsubscribeControllerV4({
          subscriptionId: result.ack.subscriptionId,
        });
        return;
      }
      subscriptionIds.add(result.ack.subscriptionId);
    }),
  ).catch(() => {
    if (disposed) return;
    status = "error";
    notify();
  });

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return snapshot;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      frameDisposable.dispose();
      const ids = Array.from(subscriptionIds);
      subscriptionIds.clear();
      for (const subscriptionId of ids) {
        void controller.unsubscribeControllerV4({ subscriptionId }).catch(() => {});
      }
      listeners.clear();
      cursors.clear();
    },
  };
}
