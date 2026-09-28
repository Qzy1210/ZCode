import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { resolve } from "node:path";
import { buildMobilePairingQrUrl, ZCODE_VERSION, type MobilePairingManager } from "@zcode/shared";
import type { MobilePairingRelayClientHandle } from "./mobilePairingRelayClient.js";
import { createMobilePairingRelayClient } from "./mobilePairingRelayClient.js";
import type { MobilePairingServerHandle } from "./mobilePairingServer.js";
import { createMobilePairingServer } from "./mobilePairingServer.js";
import { createMobilePairingManager } from "./mobilePairingManager.js";

/**
 * 移动端配对控制器(main 进程,双模式)。
 *
 * - LAN 模式(默认):main 监听局域网端口,二维码指向 http://<lan-ip>:<port>/remote。
 * - relay 模式(配置后):main 不监听,出站连接公网 relay,二维码指向
 *   https://<relay-origin>/remote;认证仍在本地 pairingManager 校验(relay 哑管道)。
 *
 * 配置来源(优先级):env ZCODE_MOBILE_RELAY_URL/ZCODE_MOBILE_RELAY_TOKEN >
 * ~/.zcode/mobile-relay.json { relayUrl, hostToken }。两者都缺省时走 LAN。
 * 二维码生成逻辑两条路径复用,每次生成作废旧配对会话。
 */

/** relay 配置文件路径。 */
const MOBILE_RELAY_CONFIG_PATH = resolve(homedir(), ".zcode", "mobile-relay.json");

export interface MobileRelayConfig {
  relayUrl: string;
  hostToken: string;
}

/** 解析 relay 配置;未配置返回 null(走 LAN 模式)。 */
export function resolveMobileRelayConfig(): MobileRelayConfig | null {
  const envUrl = process.env.ZCODE_MOBILE_RELAY_URL?.trim();
  const envToken = process.env.ZCODE_MOBILE_RELAY_TOKEN?.trim();
  if (envUrl && envToken) {
    return { relayUrl: envUrl, hostToken: envToken };
  }
  try {
    if (!existsSync(MOBILE_RELAY_CONFIG_PATH)) return null;
    const parsed = JSON.parse(readFileSync(MOBILE_RELAY_CONFIG_PATH, "utf8")) as {
      relayUrl?: unknown;
      hostToken?: unknown;
    };
    const relayUrl = typeof parsed.relayUrl === "string" ? parsed.relayUrl.trim() : "";
    const hostToken = typeof parsed.hostToken === "string" ? parsed.hostToken.trim() : "";
    if (relayUrl && hostToken) return { relayUrl, hostToken };
    return null;
  } catch {
    return null;
  }
}

export interface MobilePairingController {
  /** 启动(如未运行)并生成新二维码 URL(附模式信息供 UI 呈现)。 */
  createQrUrl(): Promise<
    ({ url: string } & { mode: "lan" | "relay" }) | { error: string }
  >;
  /** 停止服务并注销所有配对会话。幂等。 */
  stop(): Promise<void>;
  /** 当前模式与 relay 状态(供 UI 展示)。 */
  describe(): { mode: "lan" | "relay"; relayRegistered: boolean; relayOrigin?: string };
  /** 服务是否在运行。 */
  isRunning(): boolean;
}

export interface CreateMobilePairingControllerOptions {
  deviceMid: string;
  resolveBridgeHost: () => ElectronUtilityProcess | null;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

export function createMobilePairingController(
  options: CreateMobilePairingControllerOptions,
): MobilePairingController {
  const { deviceMid, resolveBridgeHost, logger } = options;
  const relayConfig = resolveMobileRelayConfig();

  let lanServer: MobilePairingServerHandle | null = null;
  let lanStarting: Promise<MobilePairingServerHandle> | null = null;
  let relayClient: MobilePairingRelayClientHandle | null = null;
  let pairingManager: MobilePairingManager | null = null;
  let relayRegistered = false;

  /** 构建二维码 URL(两模式共用):payload 由 pairingManager 签发。 */
  function buildQrUrl(
    origin: string,
    payload: ReturnType<MobilePairingManager["createQrPayload"]>,
  ): string {
    return buildMobilePairingQrUrl(origin, {
      sid: payload.sid,
      hash: payload.hash,
      t: payload.t,
      mid: payload.mid,
      name: payload.name,
      appVersion: payload.appVersion,
    });
  }

  function ensurePairingManager(): MobilePairingManager {
    if (!pairingManager) {
      // LAN 模式复用 server 内置 manager(保持二维码与验证同源);relay 模式独立持有。
      pairingManager =
        lanServer?.pairingManager ?? createMobilePairingManager();
    }
    return pairingManager;
  }

  async function createQrUrlViaLan(): Promise<
    ({ url: string } & { mode: "lan" | "relay" }) | { error: string }
  > {
    if (!lanServer) {
      if (!lanStarting) {
        // 手机页面静态资源:优先显式 env,其次 dev 布局下的 packages/web/dist。
        const webDistDir =
          process.env.ZCODE_MOBILE_REMOTE_WEB_DIST?.trim() ||
          (existsSync(resolve("packages/web/dist"))
            ? resolve("packages/web/dist")
            : existsSync(resolve("../../packages/web/dist"))
              ? resolve("../../packages/web/dist")
              : undefined);
        lanStarting = createMobilePairingServer({
          deviceMid,
          resolveBridgeHost,
          logger,
          ...(webDistDir ? { webDistDir } : {}),
        })
          .then((handle) => {
            lanServer = handle;
            pairingManager = handle.pairingManager;
            return handle;
          })
          .finally(() => {
            lanStarting = null;
          });
      }
      try {
        await lanStarting;
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (!lanServer) return { error: "mobile pairing server unavailable" };
    return { url: lanServer.createQrUrl(), mode: "lan" };
  }

  async function createQrUrlViaRelay(): Promise<
    ({ url: string } & { mode: "lan" | "relay" }) | { error: string }
  > {
    if (!relayConfig) return { error: "mobile relay is not configured" };
    const manager = ensurePairingManager();
    const payload = manager.createQrPayload({
      deviceMid,
      hostname: osHostname(),
      appVersion: ZCODE_VERSION,
    });
    if (!relayClient) {
      relayClient = createMobilePairingRelayClient(
        { relayOrigin: relayConfig.relayUrl, hostToken: relayConfig.hostToken },
        {
          pairingManager: manager,
          resolveBridgeHost,
          logger,
          onStatusChange: (status) => {
            relayRegistered = status.kind === "registered";
          },
        },
      );
    }
    relayClient.registerSid(payload.sid);
    return { url: buildQrUrl(relayConfig.relayUrl, payload), mode: "relay" };
  }

  return {
    async createQrUrl() {
      try {
        return relayConfig ? await createQrUrlViaRelay() : await createQrUrlViaLan();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[mobile-pairing] create qr failed: ${message}`);
        return { error: message };
      }
    },
    async stop() {
      const lanTarget = lanServer;
      lanServer = null;
      if (lanTarget) {
        await lanTarget.dispose();
        logger.info("[mobile-pairing] lan server stopped");
      }
      if (relayClient) {
        await relayClient.dispose();
        relayClient = null;
        relayRegistered = false;
        logger.info("[mobile-pairing] relay client stopped");
      }
      pairingManager?.disposeAll();
      pairingManager = null;
    },
    describe() {
      return relayConfig
        ? { mode: "relay", relayRegistered, relayOrigin: relayConfig.relayUrl }
        : { mode: "lan", relayRegistered: false };
    },
    isRunning() {
      return lanServer !== null || relayClient !== null;
    },
  };
}
