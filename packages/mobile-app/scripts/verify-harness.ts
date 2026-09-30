/* 验证共享脚手架:最小合法值生成、断言记录、会话帧夹具、假 transport。
 * 用例分散在 verify-store.ts / verify-model.ts,避免单文件超行数门禁。
 */
import type {
  ConversationRow,
  ConversationSnapshot,
  ConversationTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import {
  conversationSnapshotSchema,
  pendingInteractionSchema,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  ConversationTransport,
  InteractionAnswer,
} from "../src/conversation/conversationTransport";

export const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

export function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` :: ${detail}` : ""}`);
}

export function finish(): void {
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

export function minimalValue(schema: unknown): unknown {
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

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function makeSnapshot(
  sessionId: string,
  seq: number,
  rows: ConversationRow[],
  overrides: Record<string, unknown> = {},
): ConversationSnapshot {
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
    ...overrides,
  });
}

export function permissionInteraction(interactionId: string) {
  return pendingInteractionSchema.parse({
    interactionId,
    kind: "permission",
    anchorRowId: 2,
    createdAt: Date.now(),
    payload: {
      kind: "permission",
      toolCallId: "tc-1",
      toolName: "Bash",
      summary: "运行 rm -rf build",
      detail: { command: "rm -rf build" },
      freeText: true,
      options: [
        { optionId: "allowOnce", label: "允许一次", kind: "allowOnce" },
        { optionId: "deny", label: "拒绝", kind: "deny" },
      ],
    },
  });
}

export function planInteraction(interactionId: string) {
  return pendingInteractionSchema.parse({
    interactionId,
    kind: "userInput",
    anchorRowId: 3,
    createdAt: Date.now(),
    payload: {
      kind: "userInput",
      prompt: "Review this implementation plan.",
      freeText: true,
      toolName: "ExitPlanMode",
      options: [{ optionId: "allowOnce", label: "Approve" }],
      questions: [
        {
          question: "Review this implementation plan.",
          header: "Plan",
          options: [{ value: "approve", label: "Approve" }],
        },
      ],
    },
  });
}

export function questionInteraction(interactionId: string) {
  return pendingInteractionSchema.parse({
    interactionId,
    kind: "userInput",
    anchorRowId: 4,
    createdAt: Date.now(),
    payload: {
      kind: "userInput",
      prompt: "请选择要启用的能力",
      freeText: false,
      toolName: "AskUserQuestion",
      questions: [
        {
          question: "选哪些?",
          header: "能力",
          multiSelect: true,
          options: [
            { value: "a", label: "缓存" },
            { value: "b", label: "压缩" },
          ],
        },
      ],
    },
  });
}

/**
 * hook review:手机不渲染(握手未声明 workspaceHookReviewUi),但必须验证它不阻塞其它交互。
 * 计数类字段由 schema superRefine 强校验,必须与 items 一致。
 */
export function hookReviewInteraction(interactionId: string) {
  return pendingInteractionSchema.parse({
    interactionId,
    kind: "workspaceHookReview",
    anchorRowId: null,
    createdAt: Date.now(),
    payload: {
      kind: "workspaceHookReview",
      reviewFlowId: "flow-1",
      generation: 1,
      interactionId,
      sessionId: "task-1",
      taskId: "task-1",
      runId: "run-1",
      workspaceIdentity: "repo",
      workspaceLabel: "repo",
      bundleDigest: "0".repeat(64),
      createdAt: Date.now(),
      deadlineAt: Date.now() + 60_000,
      sourceFiles: [],
      summary: { eventCount: 0, hookCount: 0, pendingCount: 0 },
      items: [],
      warningCode: "workspace_hooks_execute_code",
    },
  });
}

export function assistantRow(rowId: number, turnId: string, text: string, state: "streaming" | "complete"): ConversationRow {
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

export function userRow(rowId: number, turnId: string, text: string): ConversationRow {
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

export interface FakeTransport extends ConversationTransport {
  push(frame: ConversationTopicFrame): void;
  /** 模拟首帧先于订阅 ACK 到达(barrier 暂存,activate 时回放)。 */
  pushBeforeAck(frame: ConversationTopicFrame): void;
  responds: Array<{ interactionId: string; answer: InteractionAnswer }>;
  stops: Array<string | undefined>;
  /** 记录后台工作取消与队列操作(含每轮用的 baseRevision)。 */
  cancels: string[];
  /** 记录暂停倒计时的交互 id。 */
  snoozes: string[];
  queueCalls: Array<{ type: "sendQueuedNow" | "deleteQueueItem"; queueItemId: string; baseRevision: number }>;
  /** 队列命令的 ACK 序列(用于验证 stale → revisionAtDecision 重试)。 */
  setCasAcks(acks: Array<{ status: string; revisionAtDecision?: number; message?: string }>): void;
  setOlderPage(page: { rows: ConversationRow[]; hasMore: boolean }): void;
  setCommandAck(status: string): void;
  setSendAck(ack: { status: string; message?: string; reasonCode?: string }): void;
  calls: { resync: number; loadOlder: number; unsubscribe: number; activate: number; lastResyncBase: unknown };
}

export function createFakeTransport(): FakeTransport {
  const frameListeners = new Set<(frame: ConversationTopicFrame, deliveryKind: "initial" | "online" | "recovery") => void>();
  const issueListeners = new Set<(issue: { code: string; message: string }) => void>();
  const calls = { resync: 0, loadOlder: 0, unsubscribe: 0, activate: 0, lastResyncBase: undefined as unknown };
  let olderPage: { rows: ConversationRow[]; hasMore: boolean } = { rows: [], hasMore: false };
  let sendAck: { status: string; message?: string; reasonCode?: string } = { status: "accepted" };
  let commandAckStatus = "accepted";
  const responds: Array<{ interactionId: string; answer: InteractionAnswer }> = [];
  const stops: Array<string | undefined> = [];
  const cancels: string[] = [];
  const snoozes: string[] = [];
  const queueCalls: Array<{ type: "sendQueuedNow" | "deleteQueueItem"; queueItemId: string; baseRevision: number }> = [];
  let casAcks: Array<{ status: string; revisionAtDecision?: number; message?: string }> = [];
  /** ACK 前到达的暂存帧:只在 activate(ownership 就位后)回放,模拟 barrier 语义。 */
  let stagedFrames: ConversationTopicFrame[] = [];

  return {
    calls,
    setOlderPage(page) {
      olderPage = page;
    },
    setSendAck(ack) {
      sendAck = ack;
    },
    setCommandAck(status) {
      commandAckStatus = status;
    },
    /**
     * 模拟"首帧先于订阅 ACK 到达":帧进暂存,等 store 在 ownership 就位后调
     * activate 才回放(对应真实链路 barrier 的 begin→bind→activate 暂存回放;
     * 修复前 activate 发生在 ownership 写入之前,回放帧会被 applyFrame 丢弃)。
     */
    pushBeforeAck(frame) {
      stagedFrames.push(frame);
    },
    async subscribeSession(sessionId) {
      return {
        subscriptionId: `sub-${sessionId}`,
        topic: `conversation/${sessionId}`,
        mode: "snapshot" as const,
        logEpoch: "epoch-1",
      };
    },
    activate(subscriptionId) {
      calls.activate += 1;
      const replay = stagedFrames.filter((frame) => frame.subscriptionId === subscriptionId);
      stagedFrames = stagedFrames.filter((frame) => frame.subscriptionId !== subscriptionId);
      for (const frame of replay) {
        for (const listener of frameListeners) listener(frame, "initial");
      }
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
    responds,
    stops,
    cancels,
    snoozes,
    queueCalls,
    setCasAcks(next) {
      casAcks = next;
    },
    async resolveInteraction(_sessionId, interactionId, answer) {
      responds.push({ interactionId, answer });
      return { status: commandAckStatus } as never;
    },
    async stop(_sessionId, expectedForegroundExecutionId) {
      stops.push(expectedForegroundExecutionId);
      return { status: commandAckStatus } as never;
    },
    async cancelBackgroundWork(_sessionId, workId) {
      cancels.push(workId);
      return { status: commandAckStatus } as never;
    },
    async snoozeInteraction(_sessionId, interactionId) {
      snoozes.push(interactionId);
      return { status: "accepted" } as never;
    },
    async sendQueuedNow(_sessionId, queueItemId, baseRevision) {
      queueCalls.push({ type: "sendQueuedNow", queueItemId, baseRevision });
      return (casAcks.shift() ?? { status: commandAckStatus }) as never;
    },
    async removeQueuedItem(_sessionId, queueItemId, baseRevision) {
      queueCalls.push({ type: "deleteQueueItem", queueItemId, baseRevision });
      return (casAcks.shift() ?? { status: commandAckStatus }) as never;
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
