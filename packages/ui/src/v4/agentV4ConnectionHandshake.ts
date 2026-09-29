// 握手序列已下沉到 @zcode/shared/v4-client;这里只补 renderer 侧取 clientId 与
// clientKind 的适配(desktop-continuous 归 "desktop",其余归 "web")。
import type { IZCodeAgentService } from "@zcode/services";
import type { HelloMessage } from "@zcode/shared/zcode-protocol-v4";
import { ensureAgentV4ClientHandshake } from "@zcode/shared/v4-client";
import { getV4ClientId } from "@/v4/commandFactory.js";

export function ensureAgentV4ConnectionHandshake(
  service: Pick<IZCodeAgentService, "helloConversationV4" | "initializeConversationV4">,
): Promise<HelloMessage> {
  return ensureAgentV4ClientHandshake(service, {
    // 曾经 handshake 与 commandFactory 各生成一套页面 clientId,facade 无法验证
    // command envelope 是否属于已绑定客户端。统一复用持久化 V4 clientId。
    clientId: getV4ClientId(),
    clientKind: (hello) => (hello.clientMode === "desktop-continuous" ? "desktop" : "web"),
    appVersion: "unknown",
    capabilities: { workspaceHookReviewUi: true },
  });
}
