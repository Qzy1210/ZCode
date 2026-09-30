/* 手机侧 v4 命令客户端:握手 + 信封构造的唯一实现。
 *
 * 为什么要单独一层:建连流程(会话屏)与"新建任务"(还没有会话)都需要"先握手、
 * 再用连接级 clientId 发命令";两处各写一遍必然漂移,尤其 clientId 一旦不一致,
 * 桌面 facade 会以 fault.command.clientMismatch 拒掉命令(表现为点了没反应)。
 */
import type { RemoteServiceAccess } from "@zcode/client";
import { uuidv7 } from "@zcode/shared";
import type {
  CommandAck,
  CommandPayloadMap,
  CommandType,
} from "@zcode/shared/zcode-protocol-v4";
import { ensureAgentV4ClientHandshake } from "@zcode/shared/v4-client";

/** 与 app.json 的 version 保持一致;仅用于握手元数据。 */
export const MOBILE_APP_VERSION = "0.1.0";

export interface AgentCommandWorkspace {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface AgentCommandClient {
  /** 幂等:同一连接内只握手一次(共享实现按 service 身份缓存)。 */
  ensureReady(): Promise<void>;
  /** sessionId 为 null 仅用于 createSession。 */
  send<T extends CommandType>(
    type: T,
    payload: CommandPayloadMap[T],
    sessionId: string | null,
    /** CAS 命令(switchModelConfig/队列编辑等)必须带 baseRevision。 */
    options?: { baseRevision?: number },
  ): Promise<CommandAck>;
}

export function createAgentCommandClient(params: {
  services: RemoteServiceAccess;
  /** 连接级稳定 clientId(由 connectionRuntime 下发)。 */
  clientId: string;
  workspace: AgentCommandWorkspace;
}): AgentCommandClient {
  const { services, clientId, workspace } = params;
  const agent = services.zcodeAgentService;
  const target = {
    workspacePath: workspace.workspacePath,
    ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
  };

  return {
    async ensureReady() {
      await ensureAgentV4ClientHandshake(agent, {
        clientId,
        clientKind: "mobileApp",
        appVersion: MOBILE_APP_VERSION,
        // App 无 hook review UI,故不声明 workspaceHookReviewUi;
        // workflowRunDeltas 由共享实现按"Host 先声明"的单向规则决定。
      });
    },
    send(type, payload, sessionId, options) {
      return agent.sendConversationCommandV4({
        ...target,
        envelope: {
          commandId: uuidv7(),
          clientId,
          sessionId,
          type,
          payload,
          issuedAt: Date.now(),
          ...(options?.baseRevision !== undefined ? { baseRevision: options.baseRevision } : {}),
        },
      });
    },
  };
}

/** 命令是否成功(ack 六态里 accepted/duplicate/noop 都算成功)。 */
export function isCommandAccepted(ack: CommandAck): boolean {
  return ack.status === "accepted" || ack.status === "duplicate" || ack.status === "noop";
}

/** 命令失败时给用户看的原因。 */
export function describeCommandFailure(ack: CommandAck): string {
  return ack.message ?? ack.reasonCode ?? `命令被拒绝(${ack.status})`;
}
