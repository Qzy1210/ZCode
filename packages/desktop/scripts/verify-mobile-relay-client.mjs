/* 回归:常驻启动不依赖二维码也要连上 relay;无 sid 注册回执不得崩溃。
 *   node packages/desktop/scripts/verify-mobile-relay-client.mjs
 *
 * 源码只有 electron 的 MessageChannelMain 是运行期依赖,Node 里用桩替代;
 * relay 用本地 ws 服务器模拟(只断言 host_register 帧与状态机)。
 */
import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { WebSocketServer } from "ws";

const here = fileURLToPath(new URL(".", import.meta.url));
const workDir = mkdtempSync(join(tmpdir(), "zcode-relay-verify-"));
// ws 是 CJS,打成 CJS 产物再用 require 加载,避免 ESM 下的 dynamic require 失败。
const bundlePath = join(workDir, "relayClient.cjs");
const electronStubPath = join(workDir, "electronStub.mjs");

let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
try {
  writeFileSync(
    electronStubPath,
    "export class MessageChannelMain { constructor() { this.port1 = null; this.port2 = null; } }\n",
  );
  await build({
    entryPoints: [join(here, "../src/main/mobilePairingRelayClient.ts")],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    logLevel: "warning",
    alias: { electron: electronStubPath },
  });

  // 服务器在 esbuild 构建前创建,listening 可能已经发生过。
  if (!server.address()) await once(server, "listening");
  const port = server.address().port;
  const registrations = [];
  server.on("connection", (ws) => {
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      const frame = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
      if (frame.type !== "host_register") return;
      registrations.push(frame);
      // 与真实 relay 一致:无 sid 时回执 sid=null。
      ws.send(JSON.stringify({ type: "host_registered", sid: frame.sid ?? null }));
    });
  });

  const { createMobilePairingRelayClient } = createRequire(import.meta.url)(bundlePath);
  const statuses = [];
  const client = createMobilePairingRelayClient(
    {
      relayOrigin: `http://127.0.0.1:${port}`,
      hostToken: "test-token",
      hostId: "host-1",
    },
    {
      // 本用例只走 host 注册与会话状态,认证管理器不会被调用。
      pairingManager: {},
      deviceRegistry: {},
      resolveBridgeHost: () => null,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      onStatusChange: (status) => statuses.push(status),
    },
  );

  client.connect();
  check(
    "启动连接后立即注册 hostId(不依赖二维码)",
    (await waitFor(() => registrations.length === 1)) &&
      registrations[0].hostId === "host-1" &&
      registrations[0].token === "test-token" &&
      registrations[0].sid === undefined,
  );
  check(
    "无 sid 回执不崩溃,状态为 registered 且 sid 为 null",
    (await waitFor(() => client.getStatus().kind === "registered")) &&
      client.getStatus().sid === null,
  );

  client.registerSid("sid_123456");
  check(
    "生成二维码后在同一条连接补注册 sid",
    (await waitFor(() => registrations.length === 2)) &&
      registrations[1].sid === "sid_123456" &&
      registrations[1].hostId === "host-1",
  );
  check(
    "状态事件包含 connecting → registered",
    statuses.some((status) => status.kind === "connecting") &&
      statuses.some((status) => status.kind === "registered"),
  );

  await client.dispose();
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(failed === 0 ? 0 : 1);
