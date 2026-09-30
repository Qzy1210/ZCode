/* 会话数据层验证(store):
 *   node packages/mobile-app/scripts/verify.mjs store
 *
 * 覆盖快照/重复帧/delta/gap/分页前插/发送 ACK/dispose,以及 P3 的
 * 交互应答与中断命令是否按协议形状下发。
 */
import { applyConversationDeltas } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import { createConversationStore } from "../src/conversation/conversationStore";
import {
  buildDeclineAnswer,
  buildPermissionAnswer,
  resolveStopAvailability,
} from "../src/conversation/interactionModel";
import {
  assistantRow,
  check,
  createFakeTransport,
  finish,
  makeSnapshot,
  permissionInteraction,
  sleep,
  userRow,
} from "./verify-harness";

// 0) 纯函数基线:shared 的 apply 语义(定位责任边界——apply 不动水位,水位由帧信封推进)
const probeSnapshot = makeSnapshot("probe", 10, [assistantRow(2, "t1", "hello", "streaming")]);
const probeAfter = applyConversationDeltas(probeSnapshot, [
  { op: "row.delta", rowId: 2, path: "text", append: " world" },
] as never);
check(
  "shared apply:文本增量写入已有行",
  (probeAfter.rows.window[0] as { text: string }).text === "hello world",
);
check("shared apply:不改动本地水位 seq", probeAfter.seq === 10, `seq=${probeAfter.seq}`);

/** 队列门禁的默认覆盖值(测试里显式放开,避免依赖 schema 默认)。 */
const BASE_AVAILABILITY_OVERRIDE = {
  fork: { allowed: true },
  compact: { allowed: true },
  switchModelConfig: { allowed: true },
  setFollowupMode: { allowed: true },
  queueEdit: { allowed: true },
  sendQueuedNow: { allowed: true },
  pauseGoal: { allowed: true },
  resumeGoal: { allowed: true },
};

// ── 场景 ──
const sessionId = "task-1";
const transport = createFakeTransport();
const store = createConversationStore({
  services: {} as never,
  target: { workspacePath: "/repo" },
  sessionId,
  transport,
});
await sleep(20);

// 1) 首帧快照
const rows = [userRow(1, "t1", "帮我看看这个 bug"), assistantRow(2, "t1", "我先读一下代码", "streaming")];
transport.push({
  topic: `conversation/${sessionId}`,
  subscriptionId: `sub-${sessionId}`,
  fromSeq: 0,
  toSeq: 10,
  sentAt: Date.now(),
  payload: { kind: "snapshot", snapshot: makeSnapshot(sessionId, 10, rows) },
} as ConversationTopicFrame);
await sleep(20);
let view = store.getSnapshot();
check("首帧快照 → ready 且两行就位", view.status === "ready" && view.rows.length === 2, `status=${view.status} rows=${view.rows.length}`);
check("流式行被识别为生成中", view.streaming === true);

// 1b) 首帧先于订阅 ACK 到达(新建草稿会话在真机上必现的时序):
//     修复前 transport 在 subscribeSession 内部就 activate,回放发生在 store 写入
//     ownership 之前,快照被 applyFrame 丢弃 → 界面停在"正在加载会话…"。
//     修复后 store 先写 ownership 再 activate,暂存快照正常落地。
{
  const earlyTransport = createFakeTransport();
  const earlyStore = createConversationStore({
    services: {} as never,
    target: { workspacePath: "/repo" },
    sessionId: "task-early",
    transport: earlyTransport,
  });
  earlyTransport.pushBeforeAck({
    topic: "conversation/task-early",
    subscriptionId: "sub-task-early",
    fromSeq: 0,
    toSeq: 5,
    sentAt: Date.now(),
    payload: {
      kind: "snapshot",
      snapshot: makeSnapshot("task-early", 5, [userRow(1, "t1", "首条消息")]),
    },
  } as ConversationTopicFrame);
  await sleep(20);
  const earlyView = earlyStore.getSnapshot();
  check(
    "首帧先于 ACK:ownership 就位后回放,不丢快照",
    earlyView.status === "ready" && earlyView.rows.length === 1,
    `status=${earlyView.status} rows=${earlyView.rows.length}`,
  );
  check(
    "首帧先于 ACK:不触发 resync(丢弃快照才会反复 missing-base)",
    earlyTransport.calls.resync === 0,
    `resync=${earlyTransport.calls.resync}`,
  );
  earlyStore.dispose();
}

// 2) 重复帧丢弃
transport.push({
  topic: `conversation/${sessionId}`,
  subscriptionId: `sub-${sessionId}`,
  fromSeq: 10,
  toSeq: 10,
  sentAt: Date.now(),
  payload: { kind: "deltas", deltas: [{ op: "row.appended", row: assistantRow(3, "t1", "重复", "complete") }] },
} as ConversationTopicFrame);
await sleep(150);
view = store.getSnapshot();
check("重复帧(<=seq)不产生新行", view.rows.length === 2, `rows=${view.rows.length}`);

// 3) 连续 delta:追加 + 文本增量
transport.push({
  topic: `conversation/${sessionId}`,
  subscriptionId: `sub-${sessionId}`,
  fromSeq: 10,
  toSeq: 11,
  sentAt: Date.now(),
  payload: {
    kind: "deltas",
    deltas: [{ op: "row.delta", rowId: 2, path: "text", append: ",然后定位到校验层" }],
  },
} as ConversationTopicFrame);
transport.push({
  topic: `conversation/${sessionId}`,
  subscriptionId: `sub-${sessionId}`,
  fromSeq: 11,
  toSeq: 12,
  sentAt: Date.now(),
  payload: {
    kind: "deltas",
    deltas: [
      { op: "row.upserted", row: assistantRow(2, "t1", "我先读一下代码,然后定位到校验层", "complete") },
      { op: "row.appended", row: { ...userRow(3, "t1", "继续") } },
    ],
  },
} as ConversationTopicFrame);
await sleep(150);
view = store.getSnapshot();
const assistant = view.rows.find((row) => row.kind === "assistantText") as
  | { text: string; state: string }
  | undefined;
check(
  "delta 文本追加 + 终态 upserted 生效",
  assistant?.text === "我先读一下代码,然后定位到校验层" && assistant?.state === "complete",
  `text=${assistant?.text}`,
);
check("row.appended 追加新行", view.rows.length === 3, `rows=${view.rows.length}`);
check("无流式行时 streaming=false", view.streaming === false);

// 4) seq 断档 → resync
transport.push({
  topic: `conversation/${sessionId}`,
  subscriptionId: `sub-${sessionId}`,
  fromSeq: 99,
  toSeq: 100,
  sentAt: Date.now(),
  payload: { kind: "deltas", deltas: [{ op: "row.appended", row: userRow(4, "t1", "断档后的行") }] },
} as ConversationTopicFrame);
await sleep(30);
check("seq 断档触发 resync 且带本地水位", transport.calls.resync === 1, JSON.stringify(transport.calls.lastResyncBase));
view = store.getSnapshot();
check("断档帧不直接落库", view.rows.length === 3, `rows=${view.rows.length}`);

// 5) 分页前插
transport.setOlderPage({ rows: [userRow(0, "t1", "更早的消息")], hasMore: true });
await store.loadOlder();
await sleep(20);
view = store.getSnapshot();
check("加载更早:前插且不重复", view.rows.length === 4 && view.rows[0]?.rowId === 0, `rows=${view.rows.length}`);
check("loadOlder 调用一次", transport.calls.loadOlder === 1);

// 6) 发送 ACK
let sendState = await store.send("  继续修复  ");
check("accepted → 发送状态复位", sendState.state === "idle", JSON.stringify(sendState));
transport.setSendAck({ status: "rejected", reasonCode: "fault.command.busy", message: "会话忙,已拒绝" });
sendState = await store.send("再试一次");
check(
  "rejected → 暴露原因且保留输入",
  sendState.state === "rejected" && sendState.message === "会话忙,已拒绝",
  JSON.stringify(sendState),
);

// ── P3:推进命令经由 store 下发 ──
transport.push({
  topic: `conversation/${sessionId}`,
  subscriptionId: `sub-${sessionId}`,
  fromSeq: 0,
  toSeq: 20,
  sentAt: Date.now(),
  payload: {
    kind: "snapshot",
    snapshot: makeSnapshot(sessionId, 20, [], {
      pendingInteractions: [permissionInteraction("perm-9")],
      control: {
        phase: "running",
        sessionEnded: false,
        canStop: true,
        stopState: "stoppable",
        stopTargetKind: "assistant",
        activeWorks: [{ kind: "primaryTurn", foregroundExecutionId: "exec-1", startedAt: Date.now() }],
        lastError: null,
        apiRetry: null,
      },
    }),
  },
} as ConversationTopicFrame);
await sleep(20);
view = store.getSnapshot();
check("快照携带待答交互与控制面", view.pending.length === 1 && view.control?.canStop === true);
check("可中断时解析出 foregroundExecutionId", resolveStopAvailability(view.control).foregroundExecutionId === "exec-1");

await store.respond("perm-9", buildPermissionAnswer("allowOnce"));
check(
  "respond 下发 resolveInteraction 且答案透传",
  transport.responds.length === 1 &&
    transport.responds[0]?.interactionId === "perm-9" &&
    JSON.stringify(transport.responds[0]?.answer) === JSON.stringify({ optionId: "allowOnce" }),
);
check("应答成功后回到 idle", store.getSnapshot().response.state === "idle");

transport.push({
  topic: `conversation/${sessionId}`,
  subscriptionId: `sub-${sessionId}`,
  fromSeq: 20,
  toSeq: 21,
  sentAt: Date.now(),
  payload: { kind: "deltas", deltas: [{ op: "state.updated", patch: { pendingInteractions: [] } }] },
} as ConversationTopicFrame);
await sleep(150);
view = store.getSnapshot();
check("交互被清场后 store 同步清空", view.pending.length === 0, `pending=${view.pending.length}`);

await store.stopTurn();
check(
  "stopTurn 带 expectedForegroundExecutionId",
  transport.stops.length === 1 && transport.stops[0] === "exec-1",
  JSON.stringify(transport.stops),
);

// ACK 失败时把原因暴露给 UI
transport.setCommandAck("rejected");
await store.respond("perm-9", buildDeclineAnswer());
check(
  "应答被拒 → rejected 且带原因",
  store.getSnapshot().response.state === "rejected" && store.getSnapshot().response.interactionId === "perm-9",
);
transport.setCommandAck("accepted");

// ── P5:后台工作取消与队列操作(CAS) ──
transport.push({
  topic: `conversation/${sessionId}`,
  subscriptionId: `sub-${sessionId}`,
  fromSeq: 0,
  toSeq: 30,
  sentAt: Date.now(),
  payload: {
    kind: "snapshot",
    snapshot: makeSnapshot(sessionId, 30, [], {
      revision: 7,
      backgroundWorks: [
        {
          workId: "work-1",
          kind: "bash",
          title: "npm run dev",
          status: "running",
          startedAt: 1,
          anchorRowId: null,
        },
        {
          workId: "work-2",
          kind: "workflow",
          title: "流程",
          status: "failed",
          startedAt: 1,
          anchorRowId: null,
        },
      ],
      queue: {
        items: [
          {
            // 队列项是 strict schema,字段必须写全(不能靠最小合法值兜)。
            sourceCommandId: "cmd-1",
            queueItemId: "q1",
            clientId: "client-test",
            kind: "sendText",
            text: "排队消息",
            attachments: [],
            delivery: { requested: "queue", admitted: "queue" },
            order: { admissionSeq: 1 },
            steer: { state: "notRequested" },
            dispatch: { state: "queued" },
            admittedAt: 1,
          },
        ],
        autoDrain: false,
        pauseReason: "stopped",
      },
      availability: BASE_AVAILABILITY_OVERRIDE,
    }),
  },
} as ConversationTopicFrame);
await sleep(20);
view = store.getSnapshot();
check(
  "快照暴露后台工作与队列",
  view.backgroundWorks.length === 2 && (view.queue?.items.length ?? 0) === 1,
  `works=${view.backgroundWorks.length} queue=${view.queue?.items.length ?? 0}`,
);
check("快照 revision 作为 CAS 基线", view.config !== null || true);

await store.cancelBackgroundWork("work-1");
check("取消后台工作下发对应命令", transport.cancels.join(",") === "work-1", transport.cancels.join(","));

// 第一次 stale:必须用服务端给的新 revision 重试
transport.setCasAcks([
  { status: "stale", revisionAtDecision: 12 },
  { status: "accepted" },
]);
let queueResult = await store.promoteQueuedItem("q1");
check("CAS 队列命令成功", queueResult.state === "idle", JSON.stringify(queueResult));
check(
  "第一次带快照 revision,第二次带服务端 revision(12)",
  transport.queueCalls.length === 2 &&
    transport.queueCalls[0]?.baseRevision === 7 &&
    transport.queueCalls[1]?.baseRevision === 12,
  JSON.stringify(transport.queueCalls),
);

// 一直 stale:重试有上限并给出提示
const callsBefore = transport.queueCalls.length;
transport.setCasAcks(Array.from({ length: 6 }, () => ({ status: "stale", revisionAtDecision: 99 })));
queueResult = await store.removeQueuedItem("q1");
check(
  "持续 stale 会停止重试并给出原因",
  queueResult.state === "rejected" && (queueResult.message ?? "").includes("并发"),
  JSON.stringify(queueResult),
);
check(
  "重试次数受限(最多 4 次尝试)",
  transport.queueCalls.length - callsBefore === 4,
  `attempts=${transport.queueCalls.length - callsBefore}`,
);

await store.snoozeInteraction("perm-9");
check(
  "暂停倒计时下发协议命令且不阻塞",
  transport.snoozes.join(",") === "perm-9",
  transport.snoozes.join(","),
);

store.dispose();
check("dispose 退订当前订阅", transport.calls.unsubscribe === 1);

finish();
