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

store.dispose();
check("dispose 退订当前订阅", transport.calls.unsubscribe === 1);

finish();
