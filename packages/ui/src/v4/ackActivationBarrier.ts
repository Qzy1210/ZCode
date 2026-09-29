// 实现已下沉到 @zcode/shared/v4-client(renderer 与 RN App 共用同一份时序逻辑),
// 这里保留原路径导出,避免 UI 侧大量调用点改动。
export {
  createAckActivationBarrier,
  type AckActivationBarrier,
} from "@zcode/shared/v4-client";
