/* v4 连接握手(客户端侧,唯一实现)。
 *
 * 每个 RPC service proxy 对应一个 attachment;hello/clientHello 只做一次,
 * 同一 attachment 上的所有 conversation / sessions-index 订阅共享同一个 Promise,
 * 避免并发首订阅重复握手(桌面侧 facade 也会拒绝二次绑定不同 clientId)。
 *
 * 声明纪律(照抄协议约束,不要"顺手"加字段):
 * - `capabilities.workflowRunDeltas` 是**单向**声明:只有 Host 在 hello 里先宣告,
 *   客户端才能回带。capabilities 是 `.strict()`,向老 Host 发它不认识的键会让整条
 *   clientHello 解析失败、连接握不上手——这不是降级,是会话面板整体打不开。
 * - 仅当调用方确实渲染 hook review UI 时才声明 `workspaceHookReviewUi`。
 */
import {
  V4_WIRE_PROTOCOL_VERSION,
  helloMessageSchema,
  hostSupportsWorkflowRunDeltas,
  type ClientHello,
  type HelloMessage,
} from "@zcode/shared/zcode-protocol-v4";

/** 只依赖握手的两个方法,避免本模块绑定具体服务实现的类型面。 */
export interface AgentV4HandshakeService {
  helloConversationV4(): Promise<unknown>;
  initializeConversationV4(clientHello: ClientHello): Promise<void>;
}

type ClientKind = NonNullable<ClientHello["clientKind"]>;

export interface AgentV4ClientHandshakeOptions {
  /** 同一连接内稳定即可;命令信封必须复用同一值(facade 会校验绑定)。 */
  clientId: string;
  /** 常量,或按 Host 的 hello 推导(例如 desktop-continuous → "desktop")。 */
  clientKind: ClientKind | ((hello: HelloMessage) => ClientKind);
  appVersion: string;
  /** 客户端能力声明;不传则不声明任何可选能力。 */
  capabilities?: ClientHello["capabilities"];
}

const handshakes = new WeakMap<object, Promise<HelloMessage>>();

export function ensureAgentV4ClientHandshake(
  service: AgentV4HandshakeService,
  options: AgentV4ClientHandshakeOptions,
): Promise<HelloMessage> {
  const key = service as object;
  const existing = handshakes.get(key);
  if (existing) return existing;

  const handshake = (async () => {
    const hello = helloMessageSchema.parse(await service.helloConversationV4());
    const { workflowRunDeltas, workspaceHookReviewUi } = options.capabilities ?? {};
    const capabilities: NonNullable<ClientHello["capabilities"]> = {
      ...(workspaceHookReviewUi !== undefined ? { workspaceHookReviewUi } : {}),
      ...(workflowRunDeltas === true && hostSupportsWorkflowRunDeltas(hello.capabilities)
        ? { workflowRunDeltas: true }
        : {}),
    };
    const clientKind =
      typeof options.clientKind === "function" ? options.clientKind(hello) : options.clientKind;
    await service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      clientId: options.clientId,
      clientKind,
      appVersion: options.appVersion,
      ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
    });
    return hello;
  })();
  handshakes.set(key, handshake);
  void handshake.catch(() => {
    if (handshakes.get(key) === handshake) handshakes.delete(key);
  });
  return handshake;
}
