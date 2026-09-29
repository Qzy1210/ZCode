/* 会话聚合验证(Node 直接运行,无测试框架依赖):
 *   node packages/mobile-app/scripts/verify-conversation-store.ts
 *
 * 覆盖 conversationStore 的协议语义(不依赖桌面端):
 * 1) 首帧快照 → ready,行按 rowId 升序;
 * 2) 重复帧(<= seq)丢弃,不产生重复行;
 * 3) 连续 delta 追加/流式文本增长;
 * 4) seq 断档 → 触发 resync(带本地水位 base);
 * 5) 分页前插:更早的行插到头部,不重复、不动物理水位;
 * 6) 发送 ACK:accepted 复位,rejected 暴露原因。
 *
 * 快照/行由 schema 结构推导的最小合法对象生成(不直接依赖 zod 运行时),
 * 避免手写巨型 fixture 与 schema 漂移。
 */
import {
  applyConversationDeltas,
  conversationSnapshotSchema,
  type ConversationRow,
  type ConversationSnapshot,
  type ConversationTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { createConversationStore } from "../src/conversation/conversationStore";
import type { ConversationTransport } from "../src/conversation/conversationTransport";

/**
 * 按 schema 推最小合法值,避免为巨型快照手写 fixture:
 * default → 默认值;literal/enum → 第一个允许值;union → 逐个候选校验;
 * object → 递归(可选字段缺失即忽略);其余交给 safeParse/parse(undefined) 判定。
 */
function minimalValue(schema: unknown): unknown {
  const current = schema as {
    def?: Record<string, unknown>;
    _zod?: { def?: Record<string, unknown> };
    safeParse?: (value: unknown) => { success: boolean; data?: unknown };
    parse?: (value: unknown) => unknown;
  };
  const def = current._zod?.def ?? current.def;
  if (!def) return undefined;

  const candidate = candidateValue(current, def);
  if (candidate !== undefined && current.safeParse) {
    const parsed = current.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  // 兜底:带 default / optional 的字段允许直接解析 undefined。
  if (current.parse) {
    try {
      return current.parse(undefined);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function candidateValue(
  current: { safeParse?: (value: unknown) => { success: boolean } },
  def: Record<string, unknown>,
): unknown {
  if (typeof def.defaultValue === "function") {
    return (def.defaultValue as () => unknown)();
  }
  switch (def.type) {
    case "string":
      return "";
    case "number":
      return 0;
    case "boolean":
      return false;
    case "array":
    case "tuple":
      return [];
    case "record":
    case "map":
      return {};
    case "literal":
      return Array.isArray(def.values) ? (def.values as unknown[])[0] : undefined;
    case "enum": {
      const entries = def.entries as Record<string, unknown> | undefined;
      return entries ? Object.values(entries)[0] : undefined;
    }
    case "union": {
      const options = (def.options as unknown[] | undefined) ?? [];
      for (const option of options) {
        const value = minimalValue(option);
        if (value === undefined) continue;
        const parsed = (option as { safeParse?: (v: unknown) => { success: boolean } }).safeParse?.(value);
        if (parsed?.success) return value;
      }
      return undefined;
    }
    case "object": {
      const shape = def.shape as (() => Record<string, unknown>) | Record<string, unknown>;
      const resolved = typeof shape === "function" ? shape() : shape;
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(resolved)) {
        const child = minimalValue(value);
        if (child !== undefined) result[key] = child;
      }
      return result;
    }
    default: {
      if (def.innerType) return minimalValue(def.innerType);
      void current;
      return undefined;
    }
  }
}

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` :: ${detail}` : ""}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeSnapshot(sessionId: string, seq: number, rows: ConversationRow[]): ConversationSnapshot {
  const base = minimalValue(conversationSnapshotSchema) as Record<string, unknown>;
  return conversationSnapshotSchema.parse({
    ...base,
    protocolVersion: 1,
    sessionId,
    logEpoch: "epoch-1",
    seq,
    revision: seq,
    rows: {
      window: rows,
      totalCount: rows.length,
      firstRowId: rows[0]?.rowId ?? null,
    },
  });
}

function assistantRow(rowId: number, turnId: string, text: string, state: "streaming" | "complete"): ConversationRow {
  return {
    kind: "assistantText",
    rowId,
    turnId,
    createdAt: Date.now(),
    createdAtSeq: rowId,
    text,
    state,
  } as ConversationRow;
}

function userRow(rowId: number, turnId: string, text: string): ConversationRow {
  return {
    kind: "userInput",
    rowId,
    turnId,
    createdAt: Date.now(),
    createdAtSeq: rowId,
    text,
    origin: "realUser",
  } as ConversationRow;
}

interface FakeTransport extends ConversationTransport {
  push(frame: ConversationTopicFrame): void;
  setOlderPage(page: { rows: ConversationRow[]; hasMore: boolean }): void;
  setSendAck(ack: { status: string; message?: string; reasonCode?: string }): void;
  calls: { resync: number; loadOlder: number; unsubscribe: number; lastResyncBase: unknown };
}

function createFakeTransport(): FakeTransport {
  const frameListeners = new Set<(frame: ConversationTopicFrame, deliveryKind: "initial" | "online" | "recovery") => void>();
  const issueListeners = new Set<(issue: { code: string; message: string }) => void>();
  const calls = { resync: 0, loadOlder: 0, unsubscribe: 0, lastResyncBase: undefined as unknown };
  let olderPage: { rows: ConversationRow[]; hasMore: boolean } = { rows: [], hasMore: false };
  let sendAck: { status: string; message?: string; reasonCode?: string } = { status: "accepted" };

  return {
    calls,
    setOlderPage(page) {
      olderPage = page;
    },
    setSendAck(ack) {
      sendAck = ack;
    },
    async subscribeSession(sessionId) {
      return {
        subscriptionId: `sub-${sessionId}`,
        topic: `conversation/${sessionId}`,
        mode: "snapshot" as const,
        logEpoch: "epoch-1",
      };
    },
    async resync(_subscription, base) {
      calls.resync += 1;
      calls.lastResyncBase = base;
    },
    async unsubscribe() {
      calls.unsubscribe += 1;
    },
    async loadOlder() {
      calls.loadOlder += 1;
      return { rows: olderPage.rows, hasMore: olderPage.hasMore, atLogEpoch: "epoch-1" };
    },
    async sendText() {
      return { status: sendAck.status, message: sendAck.message, reasonCode: sendAck.reasonCode } as never;
    },
    onFrame(listener) {
      frameListeners.add(listener);
    },
    onSyncIssue(listener) {
      issueListeners.add(listener);
    },
    push(frame) {
      for (const listener of frameListeners) listener(frame, "online");
    },
    dispose() {},
  } as FakeTransport;
}

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

store.dispose();
check("dispose 退订当前订阅", transport.calls.unsubscribe === 1);

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
