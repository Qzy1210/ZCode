/* 连接运行时验证(注入假 transport 与假时钟):
 *   node packages/mobile-app/scripts/verify.mjs runtime
 *
 * 覆盖"连上之后断线"的完整闭环:断线保留画面加横条、退避重连、连上后重建连接代际、
 * 终止态不再重连、凭证失效清库回扫码页。探针的 RPC 往返不在这里测(需要真实 host),
 * 由真机飞行模式场景覆盖;探针的判定规则在 policy 用例里。
 */
import { Event } from "@zcode/rpc";
import type { ISocket } from "@zcode/rpc";

import { createConnectionRuntime, type ConnectionRuntimeState } from "../src/connectionRuntime";
import type { DeviceCredential } from "../src/deviceCredential";
import type { PairingTransport, PairingTransportEvents } from "../src/pairingTransport";
import { check, finish, sleep } from "./verify-harness";

const CREDENTIAL: DeviceCredential = {
  relayOrigin: "https://relay.example",
  hostId: "host-1",
  deviceId: "dev-1",
  deviceSecret: "secret",
  deviceName: "Android 手机",
  createdAt: 1,
};

/** 假 transport:连接成功/失败可控,可手动触发断线与活动信号。 */
function createFakeTransport(options: { failWith?: string } = {}) {
  const phaseListeners = new Set<(event: PairingTransportEvents) => void>();
  const activityListeners = new Set<(at: number) => void>();
  let disposed = false;
  const socket = {
    onData: Event.None,
    onClose: Event.None,
    onEnd: Event.None,
    write: () => {},
    end: () => {},
    drain: () => Promise.resolve(),
    dispose: () => {},
  } as unknown as ISocket;
  const transport: PairingTransport = {
    socket,
    onPhaseChange(listener) {
      phaseListeners.add(listener);
      return () => phaseListeners.delete(listener);
    },
    onActivity(listener) {
      activityListeners.add(listener);
      return () => activityListeners.delete(listener);
    },
    async connect() {
      if (options.failWith) {
        const error = new Error(options.failWith) as Error & { code?: string };
        error.code = options.failWith;
        throw error;
      }
      return socket;
    },
    async requestDeviceCredential() {
      throw new Error("not used");
    },
    dispose() {
      disposed = true;
    },
  };
  return {
    transport,
    get disposed() {
      return disposed;
    },
    emitClose(event: PairingTransportEvents) {
      for (const listener of phaseListeners) listener(event);
    },
    emitActivity(at: number) {
      for (const listener of activityListeners) listener(at);
    },
  };
}

/** 假时钟:定时器排队手动触发,避免真实等待。 */
function createFakeClock() {
  let now = 1_000_000;
  const timers = new Map<number, { handler: () => void; at: number }>();
  let nextId = 1;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
    setTimeout(handler: () => void, ms: number) {
      const id = nextId++;
      timers.set(id, { handler, at: now + ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(handle: ReturnType<typeof setTimeout>) {
      timers.delete(handle as unknown as number);
    },
    setInterval() {
      return 0 as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval() {},
    /** 触发到期的定时器(按到期时间顺序)。 */
    runDue() {
      let ran = 0;
      for (const [id, timer] of timers) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.handler();
          ran += 1;
        }
      }
      return ran;
    },
    pendingCount() {
      return timers.size;
    },
  };
}

function createRuntimeWith(options: {
  credential: DeviceCredential | null;
  transports: Array<ReturnType<typeof createFakeTransport>>;
  clearCalls: number[];
}) {
  const clock = createFakeClock();
  let index = 0;
  const runtime = createConnectionRuntime({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    transportFactory: () => {
      const fake = options.transports[index] ?? options.transports[options.transports.length - 1]!;
      index += 1;
      return fake.transport;
    },
    credentialStore: {
      load: async () => options.credential,
      save: async () => {},
      clear: async () => {
        options.clearCalls.push(1);
      },
    },
  });
  return { runtime, clock, transportCount: () => index };
}

function stateOf(runtime: { getState(): ConnectionRuntimeState }): ConnectionRuntimeState {
  return runtime.getState();
}

/** services 是 Proxy 服务对象:直接 stringify 会触发真实 RPC,只描述安全字段。 */
function describeState(state: ConnectionRuntimeState): string {
  switch (state.kind) {
    case "ready":
      return `${state.kind}(gen=${state.generation}, banner=${state.banner ? state.banner.attempt : "null"})`;
    case "error":
      return `${state.kind}(${state.code}, retry=${state.canRetryAuto})`;
    case "connecting":
      return `${state.kind}(${state.label})`;
    default:
      return state.kind;
  }
}

// ── 1) 无凭证 → 扫码页 ──
{
  const { runtime } = createRuntimeWith({ credential: null, transports: [], clearCalls: [] });
  runtime.start();
  await sleep(10);
  check("无凭证启动进扫码页", stateOf(runtime).kind === "pair");
  runtime.dispose();
}

// ── 2) 有凭证 → 直连就绪;断线保留画面并退避重连 ──
{
  const first = createFakeTransport();
  const second = createFakeTransport();
  const { runtime, clock, transportCount } = createRuntimeWith({
    credential: CREDENTIAL,
    transports: [first, second],
    clearCalls: [],
  });
  runtime.start();
  await sleep(10);
  const ready = stateOf(runtime);
  check(
    "有凭证直接连上(免扫码)",
    ready.kind === "ready" && ready.banner === null && ready.mode === "device",
    ready.kind,
  );
  const firstGeneration = ready.kind === "ready" ? ready.generation : -1;

  // relay 以 host_disconnected 关闭:应保留画面 + 横条,而不是回到加载页
  first.emitClose({ phase: "closed", closeCode: 4000, closeReason: "host_disconnected" });
  await sleep(10);
  const reconnecting = stateOf(runtime);
  check(
    "断线后保留最后画面并显示重连横条",
    reconnecting.kind === "ready" && reconnecting.banner !== null,
    describeState(reconnecting),
  );
  check(
    "断线时旧连接代际不变(屏幕不重建,避免闪屏)",
    reconnecting.kind === "ready" && reconnecting.generation === firstGeneration,
  );
  check("断线时旧 transport 已被拆掉", first.disposed === true);
  check("已排入一次重连定时器", clock.pendingCount() === 1);

  // 触发重连:先推进假时钟让定时器到期,新的 transport 连上 → 代际自增、横条消失
  clock.advance(5_000);
  clock.runDue();
  await sleep(10);
  const reconnected = stateOf(runtime);
  check(
    "重连成功后横条消失",
    reconnected.kind === "ready" && reconnected.banner === null,
    describeState(reconnected),
  );
  check(
    "重连成功后连接代际自增(屏幕与订阅重建)",
    reconnected.kind === "ready" && reconnected.generation === firstGeneration + 1,
  );
  check("重连只用了第二条 transport", transportCount() === 2);
  runtime.dispose();
}

// ── 3) superseded 是终止态:不再重连 ──
{
  const first = createFakeTransport();
  const { runtime, clock, transportCount } = createRuntimeWith({
    credential: CREDENTIAL,
    transports: [first],
    clearCalls: [],
  });
  runtime.start();
  await sleep(10);
  first.emitClose({ phase: "closed", closeCode: 4000, closeReason: "superseded" });
  await sleep(10);
  const terminal = stateOf(runtime);
  check(
    "被另一台手机接管 → 停在错误页",
    terminal.kind === "error" && terminal.code === "connection_superseded",
    describeState(terminal),
  );
  check("终止态不排重连定时器", clock.pendingCount() === 0);
  clock.advance(60_000);
  clock.runDue();
  await sleep(5);
  check("终止态即使时间流逝也不会新建连接", transportCount() === 1);
  runtime.dispose();
}

// ── 4) 凭证失效:清库并回扫码页入口 ──
{
  const failing = createFakeTransport({ failWith: "device_revoked" });
  const clearCalls: number[] = [];
  const { runtime } = createRuntimeWith({
    credential: CREDENTIAL,
    transports: [failing],
    clearCalls,
  });
  runtime.start();
  await sleep(10);
  const invalid = stateOf(runtime);
  check(
    "凭证被吊销 → 报 device_revoked 且不做自动重试",
    invalid.kind === "error" && invalid.code === "device_revoked" && invalid.canRetryAuto === false,
    describeState(invalid),
  );
  check("凭证失效时清掉本地凭证", clearCalls.length === 1);
  runtime.dispose();
}

// ── 5) 用户放弃重连 ──
{
  const first = createFakeTransport();
  const { runtime, clock } = createRuntimeWith({
    credential: CREDENTIAL,
    transports: [first],
    clearCalls: [],
  });
  runtime.start();
  await sleep(10);
  first.emitClose({ phase: "closed", closeCode: 4000, closeReason: "host_disconnected" });
  await sleep(10);
  runtime.stopReconnect();
  const stopped = stateOf(runtime);
  check(
    "停止重连 → 错误页可手动重试",
    stopped.kind === "error" && stopped.code === "manual_stop",
    describeState(stopped),
  );
  check("停止重连清掉定时器", clock.pendingCount() === 0);
  runtime.dispose();
}

// ── 5.5) relay 重启后桌面端尚未重新注册:反复 pair_unknown 也要能收敛 ──
{
  const live = createFakeTransport();
  const notYet = createFakeTransport({ failWith: "pair_unknown" });
  const notYet2 = createFakeTransport({ failWith: "pair_unknown" });
  const recovered = createFakeTransport();
  const { runtime, clock, transportCount } = createRuntimeWith({
    credential: CREDENTIAL,
    transports: [live, notYet, notYet2, recovered],
    clearCalls: [],
  });
  runtime.start();
  await sleep(10);
  const ready = stateOf(runtime);
  const gen = ready.kind === "ready" ? ready.generation : -1;

  // relay 关闭手机连接
  live.emitClose({ phase: "closed", closeCode: 4000, closeReason: "relay_shutdown" });
  await sleep(10);
  const first = stateOf(runtime);
  check(
    "首次断线计数为 1(不是残留计数)",
    first.kind === "ready" && first.banner?.attempt === 1,
    first.kind === "ready" ? `attempt=${first.banner?.attempt}` : first.kind,
  );

  // 第一次重连失败(桌面端还没注册):计数递增、继续退避
  clock.advance(5_000);
  clock.runDue();
  await sleep(10);
  const second = stateOf(runtime);
  check(
    "重连失败(桌面端未注册)计数递增到 2",
    second.kind === "ready" && second.banner?.attempt === 2,
    second.kind === "ready" ? `attempt=${second.banner?.attempt}` : second.kind,
  );
  check(
    "失败尝试也暴露真实原因 pair_unknown",
    second.kind === "ready" && second.banner?.reason === "pair_unknown",
  );

  clock.advance(10_000);
  clock.runDue();
  await sleep(10);
  const third = stateOf(runtime);
  check("第二次失败后计数为 3", third.kind === "ready" && third.banner?.attempt === 3);

  // 桌面端注册完成:下一次重连成功,横条消失、代际自增、计数归零
  clock.advance(30_000);
  clock.runDue();
  await sleep(10);
  const final = stateOf(runtime);
  check(
    "桌面端恢复后自动连上并复位计数",
    final.kind === "ready" && final.banner === null && final.generation === gen + 1,
    describeState(final),
  );

  // 复位后再断一次:计数必须重新从 1 开始(而非接着 3)
  recovered.emitClose({ phase: "closed", closeCode: 4000, closeReason: "host_disconnected" });
  await sleep(10);
  const again = stateOf(runtime);
  check(
    "重连成功后计数归零(下次断线从 1 开始)",
    again.kind === "ready" && again.banner?.attempt === 1,
    again.kind === "ready" ? `attempt=${again.banner?.attempt}` : again.kind,
  );
  check("本轮共用了 4 个 transport", transportCount() === 4, `count=${transportCount()}`);
  runtime.dispose();
}

// ── 5.8) 回归:一次断线只能有一条重试链(此前会并发跑出 7 次失败) ──
{
  const live = createFakeTransport();
  const failing = createFakeTransport({ failWith: "pair_unknown" });
  const { runtime, clock, transportCount } = createRuntimeWith({
    credential: CREDENTIAL,
    transports: [live, failing],
    clearCalls: [],
  });
  runtime.start();
  await sleep(10);
  live.emitClose({ phase: "closed", closeCode: 4000, closeReason: "relay_shutdown" });
  await sleep(10);
  check("断线后只排一个定时器", clock.pendingCount() === 1, `pending=${clock.pendingCount()}`);

  // 失败一次后:计数为 2,且仍然只有一个定时器(不能并发出多条链)
  clock.advance(3_000);
  clock.runDue();
  await sleep(10);
  const afterFail = stateOf(runtime);
  check(
    "重试失败后计数准确递增(无并发链)",
    afterFail.kind === "ready" && afterFail.banner?.attempt === 2,
    afterFail.kind === "ready" ? `attempt=${afterFail.banner?.attempt}` : afterFail.kind,
  );
  check("失败后仍只有一个待触发定时器", clock.pendingCount() === 1, `pending=${clock.pendingCount()}`);
  check("两次失败尝试用掉两条 transport", transportCount() === 2, `count=${transportCount()}`);
  runtime.dispose();
}

// ── 5.9) 回归:迟到的定时器不得拆掉已恢复的连接 ──
{
  const live = createFakeTransport();
  const second = createFakeTransport();
  const { runtime, clock } = createRuntimeWith({
    credential: CREDENTIAL,
    transports: [live, second],
    clearCalls: [],
  });
  runtime.start();
  await sleep(10);
  live.emitClose({ phase: "closed", closeCode: 4000, closeReason: "host_disconnected" });
  await sleep(10);
  clock.advance(5_000);
  clock.runDue();
  await sleep(10);
  const recovered = stateOf(runtime);
  check("重连成功后处于 ready 无横条", recovered.kind === "ready" && recovered.banner === null);

  // 模拟"迟到的定时器":即使还有排队定时器,也不该再动健康连接
  second.emitClose({ phase: "closed", closeCode: 4000, closeReason: "host_disconnected" });
  await sleep(10);
  const beforeStale = stateOf(runtime);
  const genAfterRecovery = beforeStale.kind === "ready" ? beforeStale.generation : -1;
  check("再次断线后进入重连态", beforeStale.kind === "ready" && beforeStale.banner !== null);
  clock.advance(120_000);
  clock.runDue();
  clock.runDue();
  await sleep(10);
  const afterStale = stateOf(runtime);
  check(
    "多轮定时器触发不会产生额外连接代际(不重复拆建)",
    afterStale.kind === "ready" && afterStale.generation >= genAfterRecovery,
    describeState(afterStale),
  );
  runtime.dispose();
}

// ── 6) 重复的 close 事件不会叠加重连 ──
{
  const first = createFakeTransport();
  const { runtime, clock } = createRuntimeWith({
    credential: CREDENTIAL,
    transports: [first],
    clearCalls: [],
  });
  runtime.start();
  await sleep(10);
  first.emitClose({ phase: "closed", closeCode: 4000, closeReason: "host_disconnected" });
  first.emitClose({ phase: "closed", closeCode: 4000, closeReason: "host_disconnected" });
  await sleep(10);
  check("重复断线通知只排一次重连", clock.pendingCount() === 1, `pending=${clock.pendingCount()}`);
  runtime.dispose();
}

finish();
