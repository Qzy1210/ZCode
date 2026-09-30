/* 会话命令下发层:发送、交互应答、中断、取消后台工作、队列操作。
 *
 * 从 conversationStore 抽出:这些方法的共同点是"发命令 + 维护 sending/rejected 操作态",
 * 与"帧聚合"是两件事;抽开后 store 只保留状态与所有权,单文件也不至于超行数上限。
 *
 * 约定:
 * - 所有命令都经 conversationTransport → agentCommandClient(连接级 clientId + 握手);
 * - CAS 命令(队列编辑)带当前 revision,stale 时用 `ack.revisionAtDecision` 重试;
 * - 操作态由调用方(store)持有,这里只通过 setAction 上报。
 */
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";

import {
  CAS_MAX_ATTEMPTS,
  nextCasRevision,
} from "./runtimeActions";
import type {
  ConversationTransport,
  InteractionAnswer,
  SendTextOptions,
} from "./conversationTransport";

export interface CommandActionState {
  state: "idle" | "sending" | "rejected";
  message?: string;
  /** 应答专用:正在应答/刚被拒的交互 id。 */
  interactionId?: string;
}

export type CommandSlot = "send" | "response" | "stop";

export interface SessionCommands {
  send(text: string, options?: SendTextOptions): Promise<CommandActionState>;
  respond(interactionId: string, answer: InteractionAnswer): Promise<CommandActionState>;
  stopTurn(expectedForegroundExecutionId?: string): Promise<CommandActionState>;
  cancelBackgroundWork(workId: string): Promise<CommandActionState>;
  promoteQueuedItem(queueItemId: string): Promise<CommandActionState>;
  removeQueuedItem(queueItemId: string): Promise<CommandActionState>;
}

export interface SessionCommandsContext {
  transport: ConversationTransport;
  sessionId: string;
  /** 当前快照 revision(CAS 命令的 baseRevision)。 */
  getRevision(): number;
  isDisposed(): boolean;
  setAction(slot: CommandSlot, state: CommandActionState): void;
}

/** 命令被接受/幂等重复/无操作都算成功;stale/rejected/failed 才需要提示用户。 */
export function isCommandAccepted(ack: CommandAck): boolean {
  return ack.status === "accepted" || ack.status === "duplicate" || ack.status === "noop";
}

export function describeCommandFailure(ack: CommandAck): string {
  return ack.message ?? ack.reasonCode ?? `命令被拒绝(${ack.status})`;
}

function describeError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  if (typeof code === "string" && code.length > 0) return code;
  return error instanceof Error ? error.message : String(error);
}

export function createSessionCommands(ctx: SessionCommandsContext): SessionCommands {
  const { transport, sessionId } = ctx;

  /** 单个命令的统一收口:置 sending → 判定 ACK → 失败给原因。 */
  async function run(
    slot: CommandSlot,
    execute: () => Promise<CommandAck>,
    extra?: Partial<CommandActionState>,
  ): Promise<CommandActionState> {
    if (ctx.isDisposed()) return { state: "idle" };
    let next: CommandActionState = { state: "sending", ...extra };
    ctx.setAction(slot, next);
    try {
      const ack = await execute();
      if (ctx.isDisposed()) return next;
      next = isCommandAccepted(ack)
        ? { state: "idle" }
        : { state: "rejected", message: describeCommandFailure(ack), ...extra };
    } catch (error) {
      next = { state: "rejected", message: describeError(error), ...extra };
    }
    ctx.setAction(slot, next);
    return next;
  }

  async function runQueue(
    type: "sendQueuedNow" | "deleteQueueItem",
    queueItemId: string,
  ): Promise<CommandActionState> {
    if (ctx.isDisposed()) return { state: "idle" };
    ctx.setAction("response", { state: "sending" });
    let revision = ctx.getRevision();
    for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt += 1) {
      try {
        const ack =
          type === "sendQueuedNow"
            ? await transport.sendQueuedNow(sessionId, queueItemId, revision)
            : await transport.removeQueuedItem(sessionId, queueItemId, revision);
        if (ctx.isDisposed()) return { state: "idle" };
        if (isCommandAccepted(ack)) {
          ctx.setAction("response", { state: "idle" });
          return { state: "idle" };
        }
        const nextRevision = nextCasRevision(ack);
        if (nextRevision === undefined) {
          const rejected: CommandActionState = {
            state: "rejected",
            message: describeCommandFailure(ack),
          };
          ctx.setAction("response", rejected);
          return rejected;
        }
        revision = nextRevision;
      } catch (error) {
        const rejected: CommandActionState = { state: "rejected", message: describeError(error) };
        ctx.setAction("response", rejected);
        return rejected;
      }
    }
    const exhausted: CommandActionState = { state: "rejected", message: "队列已被并发修改,请重试" };
    ctx.setAction("response", exhausted);
    return exhausted;
  }

  return {
    send(text, options) {
      return run("send", () => transport.sendText(sessionId, text, options));
    },
    respond(interactionId, answer) {
      return run("response", () => transport.resolveInteraction(sessionId, interactionId, answer), {
        interactionId,
      });
    },
    stopTurn(expectedForegroundExecutionId) {
      return run("stop", () => transport.stop(sessionId, expectedForegroundExecutionId));
    },
    cancelBackgroundWork(workId) {
      return run("stop", () => transport.cancelBackgroundWork(sessionId, workId));
    },
    promoteQueuedItem(queueItemId) {
      return runQueue("sendQueuedNow", queueItemId);
    },
    removeQueuedItem(queueItemId) {
      return runQueue("deleteQueueItem", queueItemId);
    },
  };
}
