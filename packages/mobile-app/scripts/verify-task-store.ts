/* 任务列表数据层验证(tasks):
 *   node packages/mobile-app/scripts/verify.mjs tasks
 *
 * 覆盖 taskStore 的快照落地、项目卡排序(最近任务时间倒序/无任务沉底/同层字母序)、
 * delta 实时重排、归档任务不参与排序。
 */
import {
  CONTROLLER_TASKS_INDEX_TOPIC,
  CONTROLLER_WORKSPACES_TOPIC,
  type WindowHostControllerTaskFrame,
  type WindowHostControllerTaskRow,
  type WindowHostControllerWorkspaceFact,
  type WindowHostControllerWorkspaceFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { createTaskStore } from "../src/taskStore";
import { check, finish, sleep } from "./verify-harness";

/** 假 controller 服务:只实现 taskStore 用到的四个方法,帧由用例手动推。 */
function createFakeController() {
  const listeners = new Set<(frame: unknown) => void>();
  let nextId = 0;
  const service = {
    onDynamicControllerFrame: () => (listener: (frame: unknown) => void) => {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    },
    subscribeControllerV4: async () => ({ ack: { subscriptionId: `sub-${++nextId}` } }),
    unsubscribeControllerV4: async () => {},
    resyncControllerV4: async () => ({}),
  };
  return {
    service,
    push: (frame: unknown) => {
      for (const listener of listeners) listener(frame);
    },
  };
}

function workspaceFact(workspacePath: string): WindowHostControllerWorkspaceFact {
  return { workspacePath, sourceAvailability: "online", connectionState: "online" };
}

function taskRow(
  workspacePath: string,
  taskId: string,
  updatedAt: number,
  archived = false,
): WindowHostControllerTaskRow {
  return {
    address: { workspacePath, taskId },
    meta: {
      taskId,
      traceId: `trace-${taskId}`,
      title: `任务 ${taskId}`,
      workspacePath,
      createdAt: updatedAt - 10,
      updatedAt,
      mode: "auto",
    },
    membership: { pinned: false, archived, active: !archived },
    sourceAvailability: "online",
    liveStatus: "idle",
  };
}

/**
 * 帧序号统一推进:delta 的 fromSeq 必须严格衔接上一帧 toSeq,
 * 否则被 isWindowHostControllerFrameGap 判 gap 走 resync(用例要测的是排序,不是 gap)。
 */
function makeFrameSequencer() {
  const seqBySubscription = new Map<string, number>();
  return function frame(
    subscriptionId: string,
    build: (fromSeq: number, toSeq: number) => Record<string, unknown>,
  ): Record<string, unknown> {
    const fromSeq = seqBySubscription.get(subscriptionId) ?? 0;
    const toSeq = fromSeq + 1;
    seqBySubscription.set(subscriptionId, toSeq);
    return {
      subscriptionId,
      fromSeq,
      toSeq,
      logEpoch: "epoch-1",
      sentAt: Date.now(),
      ...build(fromSeq, toSeq),
    };
  };
}

const { service: controller, push } = createFakeController();
const store = createTaskStore({ windowControllerService: controller } as never);
const sequence = makeFrameSequencer();
const workspaceOrder = () =>
  store
    .getSnapshot()
    .workspaces.map((fact) => fact.workspacePath)
    .join(",");

function pushWorkspaceFrame(payload: Record<string, unknown>): void {
  push(
    sequence("sub-ws", () => ({
      topic: CONTROLLER_WORKSPACES_TOPIC,
      payload,
    })) as unknown as WindowHostControllerWorkspaceFrame,
  );
}

function pushTaskFrame(payload: Record<string, unknown>): void {
  push(
    sequence("sub-tasks", () => ({
      topic: CONTROLLER_TASKS_INDEX_TOPIC,
      payload,
    })) as unknown as WindowHostControllerTaskFrame,
  );
}

await sleep(20);

// 1) 首帧快照:项目卡按最近任务时间倒序,无任务的项目沉底
pushWorkspaceFrame({
  kind: "snapshot",
  snapshot: {
    protocolVersion: 1,
    logEpoch: "epoch-1",
    workspaces: [workspaceFact("/ws/a"), workspaceFact("/ws/b"), workspaceFact("/ws/c")],
  },
});
pushTaskFrame({
  kind: "snapshot",
  snapshot: {
    protocolVersion: 1,
    logEpoch: "epoch-1",
    tasks: [taskRow("/ws/a", "t1", 100), taskRow("/ws/b", "t2", 200)],
  },
});
await sleep(20);
let snapshot = store.getSnapshot();
check(
  "快照 → ready 且项目按最近任务时间倒序(b200 > a100),无任务的 c 沉底",
  snapshot.status === "ready" && workspaceOrder() === "/ws/b,/ws/a,/ws/c",
  `status=${snapshot.status} order=${workspaceOrder()}`,
);
check("任务按 updatedAt 倒序", snapshot.tasks.map((row) => row.meta.taskId).join(",") === "t2,t1");

// 2) delta 实时重排:c 收到新任务(300)后跳到最前
pushTaskFrame({
  kind: "deltas",
  deltas: [{ op: "task.upserted", task: taskRow("/ws/c", "t3", 300) }],
});
await sleep(20);
check(
  "delta 后实时重排:c(300) 跳到最前",
  workspaceOrder() === "/ws/c,/ws/b,/ws/a",
  `order=${workspaceOrder()}`,
);

// 3) 同层字母序:新增 d,最近任务时间与 c 相同(300) → c 在 d 前
pushWorkspaceFrame({
  kind: "deltas",
  deltas: [{ op: "workspace.upserted", workspace: workspaceFact("/ws/d") }],
});
pushTaskFrame({
  kind: "deltas",
  deltas: [{ op: "task.upserted", task: taskRow("/ws/d", "t4", 300) }],
});
await sleep(20);
check(
  "同层按 key 字母序:c(300) 与 d(300) 并列时 c 在前",
  workspaceOrder() === "/ws/c,/ws/d,/ws/b,/ws/a",
  `order=${workspaceOrder()}`,
);

// 4) 归档任务不参与排序:a 的唯一任务归档后沉到无任务层(与卡片「更新于」同源)
pushTaskFrame({
  kind: "deltas",
  deltas: [{ op: "task.upserted", task: taskRow("/ws/a", "t1", 100, true) }],
});
await sleep(20);
snapshot = store.getSnapshot();
check(
  "归档任务不参与排序:a 沉底且快照里无归档任务",
  workspaceOrder() === "/ws/c,/ws/d,/ws/b,/ws/a" &&
    snapshot.tasks.every((row) => !row.membership.archived),
  `order=${workspaceOrder()}`,
);

store.dispose();
finish();
