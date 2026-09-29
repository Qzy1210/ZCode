/* 连接策略验证(纯函数):
 *   node packages/mobile-app/scripts/verify.mjs policy
 *
 * 这里覆盖的是"断线之后该怎么处置"的判定表——判错的后果是手机在死连接上永久
 * 假在线,或两台手机互踢,所以每种 close 原因都单独立断言。
 */
import {
  PROBE_IDLE_MS,
  PROBE_MIN_INTERVAL_MS,
  PROBE_TIMEOUT_MS,
  RECONNECT_FAST_CAP_MS,
  RECONNECT_MAX_DELAY_MS,
  classifyDisconnect,
  reconnectDelayForReason,
  describeReconnectBanner,
  reconnectDelayMs,
  shouldSendProbe,
  withTimeout,
} from "../src/connectionPolicy";
import { check, finish } from "./verify-harness";

// ── 断线分类 ──
const superseded = classifyDisconnect({ closeCode: 4000, closeReason: "superseded", attempt: 1 });
check(
  "superseded 是终止态(继续重连会两台互踢)",
  superseded.kind === "terminal",
  JSON.stringify(superseded),
);

for (const reason of [
  "host_disconnected",
  "relay_shutdown",
  "closed_by_host",
  "pair_unknown",
  "auth_required",
  "probe_timeout",
]) {
  const action = classifyDisconnect({ closeCode: 4000, closeReason: reason, attempt: 1 });
  check(`4000/${reason} 可重连`, action.kind === "retry", JSON.stringify(action));
}

check(
  "异常关闭(1006,无 reason)可重连",
  classifyDisconnect({ closeCode: 1006, attempt: 1 }).kind === "retry",
);
check(
  "无 code/reason 时按探活超时处理并给出原因",
  (() => {
    const action = classifyDisconnect({ attempt: 1 });
    return action.kind === "retry" && action.reason === "probe_timeout";
  })(),
);

// ── 退避序列 ──
const delays = [1, 2, 3, 4, 5, 6, 7, 20].map((attempt) => reconnectDelayMs(attempt));
check(
  "退避 1s→2s→4s→8s→15s→30s 后封顶",
  JSON.stringify(delays) === JSON.stringify([1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000]),
  JSON.stringify(delays),
);
check("退避上限常量与序列一致", reconnectDelayMs(99) === RECONNECT_MAX_DELAY_MS);
check("重连是无限的:第 100 次仍有正延迟", reconnectDelayMs(100) > 0);
check(
  "对端瞬时不可用(桌面端未注册)时上限收紧到 10s",
  reconnectDelayForReason("pair_unknown", 99) === RECONNECT_FAST_CAP_MS,
  String(reconnectDelayForReason("pair_unknown", 99)),
);
check(
  "网络类原因保持 30s 上限(避免手机反复重连耗电)",
  reconnectDelayForReason("probe_timeout", 99) === RECONNECT_MAX_DELAY_MS,
);
check(
  "快恢复不影响早期退避序列",
  reconnectDelayForReason("pair_unknown", 2) === 2_000 &&
    reconnectDelayForReason("pair_unknown", 3) === 4_000,
);

// ── 探活判定 ──
const base = { now: 1_000_000, lastInboundAt: 0, lastProbeAt: 0, appActive: true };
check("从未收到帧时不探活(连接还没建立)", shouldSendProbe(base) === false);
check(
  "空闲未到阈值不探活",
  shouldSendProbe({ ...base, lastInboundAt: base.now - (PROBE_IDLE_MS - 1) }) === false,
);
check(
  "前台空闲达到阈值才探活",
  shouldSendProbe({ ...base, lastInboundAt: base.now - PROBE_IDLE_MS }) === true,
);
check(
  "后台不探活(省电,也避免系统回收造成假断线)",
  shouldSendProbe({ ...base, lastInboundAt: base.now - PROBE_IDLE_MS, appActive: false }) === false,
);
check(
  "距上次探针过近不重复探",
  shouldSendProbe({
    ...base,
    lastInboundAt: base.now - PROBE_IDLE_MS,
    lastProbeAt: base.now - (PROBE_MIN_INTERVAL_MS - 1),
  }) === false,
);

// ── 探针超时包装 ──
const neverSettles = new Promise<never>(() => {});
let timeoutHit = false;
try {
  await withTimeout(neverSettles, 20, "probe timeout");
} catch (error) {
  timeoutHit = error instanceof Error && error.message === "probe timeout";
}
check("死连接上的 RPC 不会自己 reject,必须显式超时", timeoutHit);
check(
  "正常返回不受影响",
  (await withTimeout(Promise.resolve("ok"), PROBE_TIMEOUT_MS)) === "ok",
);

const banner = describeReconnectBanner({ attempt: 3, reason: "host_disconnected", nextRetryMs: 4_000 });
check(
  "重连横条含原因/倒计时/次数",
  banner.includes("桌面端已离线") && banner.includes("4 秒后重试") && banner.includes("第 3 次"),
  banner,
);
check(
  "未知原因直接显示原文,不吞信息",
  describeReconnectBanner({ attempt: 1, reason: "weird_reason" }).includes("weird_reason"),
);
check(
  "省略倒计时时不出现秒数",
  !describeReconnectBanner({ attempt: 2 }).includes("秒后重试"),
  describeReconnectBanner({ attempt: 2 }),
);

finish();
