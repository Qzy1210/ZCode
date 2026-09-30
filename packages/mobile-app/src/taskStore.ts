/* App 侧任务数据层:订阅 Host 控制器的 workspaces / tasks-index 两个 topic。
 * 与 packages/web/src/remote/mobileControllerTaskStore.ts 同源协议;
 * P1 再抽成共享包,当前为 P0 验证先直接复制。
 */
import type { RemoteServiceAccess } from "@zcode/client";

import { withTimeout } from "./connectionPolicy";
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
  /** 手动重试:重新订阅 controller(错误态下的唯一出口)。 */
  retry(): void;
  dispose(): void;
}

/**
 * 订阅超时:订阅 RPC 在"已死但尚未判定"的连接上会永久 pending,界面会永远停在
 * "正在同步项目与任务…"且没有任何出口,所以这里必须有超时。
 */
const SUBSCRIBE_TIMEOUT_MS = 10_000;

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
          // 此前这里吞掉错误:resync 一旦失败,水位永不前进,后续每帧都被判成 gap
          // 丢弃,列表静默停更且无法自愈。失败必须走整体重订阅。
          .catch(() => repair());
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

  const TOPICS = [CONTROLLER_WORKSPACES_TOPIC, CONTROLLER_TASKS_INDEX_TOPIC];
  let subscribing = false;
  let repairing = false;

  async function unsubscribeAll(): Promise<void> {
    const ids = Array.from(subscriptionIds);
    subscriptionIds.clear();
    for (const subscriptionId of ids) {
      await controller.unsubscribeControllerV4({ subscriptionId }).catch(() => {});
    }
  }

  async function subscribeAll(): Promise<void> {
    if (disposed || subscribing) return;
    subscribing = true;
    try {
      const results = await withTimeout(
        Promise.all(
          TOPICS.map((topic) => controller.subscribeControllerV4({ topic, visibility: "foreground" })),
        ),
        SUBSCRIBE_TIMEOUT_MS,
        "controller subscribe timeout",
      );
      if (disposed) {
        for (const result of results) {
          await controller
            .unsubscribeControllerV4({ subscriptionId: result.ack.subscriptionId })
            .catch(() => {});
        }
        return;
      }
      for (const result of results) subscriptionIds.add(result.ack.subscriptionId);
    } catch {
      if (disposed) return;
      // 超时或订阅失败:给出可重试的错误态(此前是永久 loading)。
      status = "error";
      notify();
    } finally {
      subscribing = false;
    }
  }

  /** 订阅失效后的整体恢复:退订 → 清水位 → 重新订阅(比逐帧 resync 更彻底)。 */
  async function repair(): Promise<void> {
    if (disposed || repairing) return;
    repairing = true;
    try {
      await unsubscribeAll();
      cursors.clear();
      status = "loading";
      notify();
      await subscribeAll();
    } finally {
      repairing = false;
    }
  }

  void subscribeAll();

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
    retry() {
      void repair();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      frameDisposable.dispose();
      void unsubscribeAll();
      listeners.clear();
      cursors.clear();
    },
  };
}
