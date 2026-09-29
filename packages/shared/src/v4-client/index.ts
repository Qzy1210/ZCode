/* v4 客户端协议运行时:renderer(web/桌面)与原生 App 共用的连接级基础设施。
 *
 * 与 `zcode-protocol-v4` 的分工:那边只放 schema 与纯函数(apply/coalesce),
 * 这里放"必须与传输时序绑定"的客户端运行时——握手序列与订阅 ACK 屏障。
 * 放在 shared 而不是某个 UI 包,是为了让 RN App 复用同一实现,避免两套协议语义。
 */
export * from "./subscriptionBarrier.js";
export * from "./clientHandshake.js";
export * from "./topicWireDecoder.js";
