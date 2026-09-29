import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MOBILE_APP_AUTH_ROLE } from "@zcode/shared";
import {
  calculateMobilePairingProof,
  verifyMobilePairingProof,
} from "@zcode/shared/mobilePairingCrypto";

/**
 * 手机 App 的持久设备登记表(桌面 main 进程,单一所有者)。
 *
 * 用途:首次扫码配对成功后为 App 签发长期凭证,之后 App 免扫码自动连接。
 * - hostId:桌面持久身份(relay 按 hostId 路由 App 连接,应用重启不变);
 * - deviceSecret:签发时一次性下发 App;桌面留存用于校验 HMAC 挑战应答
 *   (对称证明必须持有密钥才能验证;文件 0600,与 credentials.json 同级信任域)。
 *
 * 文件:`~/.zcode/v2/mobile-app-devices.json`(与 telemetry-state.json 同目录约定)。
 * 读写策略:低频操作使用同步 IO + tmp/rename 原子替换;损坏则从空表重建,
 * 绝不因登记表异常阻塞配对主链路。
 */

const REGISTRY_FILE_NAME = "mobile-app-devices.json";
export const MOBILE_APP_CLIENT_TS_SKEW_MS = 5 * 60 * 1000;

interface StoredDevice {
  deviceId: string;
  name: string;
  secret: string;
  createdAt: number;
  lastSeenAt: number;
}

interface RegistryFile {
  version: 1;
  hostId: string;
  devices: StoredDevice[];
}

export interface MobileAppDeviceSummary {
  deviceId: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

export type MobileAppDeviceVerifyResult =
  | { ok: true }
  | { ok: false; code: "device_unknown" | "auth_failed" | "auth_expired" };

export interface MobileAppDeviceRegistry {
  /** 桌面持久身份(relay 路由用),首次访问时生成并落盘。 */
  getHostId(): string;
  listDevices(): MobileAppDeviceSummary[];
  /** 签发新设备凭证(secret 仅此一次返回给 App)。 */
  registerDevice(name: string): { deviceId: string; deviceSecret: string };
  /** 校验设备挑战应答;成功即刷新 lastSeenAt。 */
  verifyDevice(input: {
    deviceId: string;
    nonce: string;
    proof: string;
    clientTs: number;
  }): MobileAppDeviceVerifyResult;
  /** 吊销设备(删除登记;App 端下次连接收到 device_unknown,应清除本地凭证)。 */
  revokeDevice(deviceId: string): boolean;
  /** 桥接存活期间的活跃度刷新。 */
  touchDevice(deviceId: string): void;
}

function resolveRegistryPath(): string {
  const zcodeHome = process.env.ZCODE_HOME?.trim();
  const base = zcodeHome && zcodeHome.length > 0 ? zcodeHome : join(homedir(), ".zcode");
  return join(base, "v2", REGISTRY_FILE_NAME);
}

export function createMobileAppDeviceRegistry(options?: {
  filePath?: string;
  now?: () => number;
}): MobileAppDeviceRegistry {
  const filePath = options?.filePath ?? resolveRegistryPath();
  const now = options?.now ?? Date.now;

  function readRegistry(): RegistryFile {
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      const record = parsed as Partial<RegistryFile> | null;
      if (
        !record ||
        record.version !== 1 ||
        typeof record.hostId !== "string" ||
        !Array.isArray(record.devices)
      ) {
        throw new Error("unexpected registry shape");
      }
      const devices = record.devices.filter(
        (device): device is StoredDevice =>
          typeof device === "object" &&
          device !== null &&
          typeof (device as StoredDevice).deviceId === "string" &&
          typeof (device as StoredDevice).secret === "string",
      );
      return { version: 1, hostId: record.hostId, devices };
    } catch {
      // 缺失/损坏:从空表重建(hostId 重新生成后,已配对 App 需重新扫码配对)。
      return { version: 1, hostId: "", devices: [] };
    }
  }

  function writeRegistry(registry: RegistryFile): void {
    mkdirSync(dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    // 0600:设备凭证等同长期令牌,仅当前用户可读。
    writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, filePath);
  }

  return {
    getHostId() {
      const registry = readRegistry();
      if (registry.hostId) return registry.hostId;
      registry.hostId = randomUUID();
      try {
        writeRegistry(registry);
      } catch {
        // 落盘失败仍返回内存值:本次会话可用,下次启动重新生成。
      }
      return registry.hostId;
    },
    listDevices() {
      return readRegistry().devices.map((device) => ({
        deviceId: device.deviceId,
        name: device.name,
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt,
      }));
    },
    registerDevice(name) {
      const registry = readRegistry();
      if (!registry.hostId) registry.hostId = randomUUID();
      const deviceId = randomUUID();
      const deviceSecret = randomUUID().replaceAll("-", "");
      const observedAt = now();
      registry.devices.push({
        deviceId,
        name: name.slice(0, 64),
        secret: deviceSecret,
        createdAt: observedAt,
        lastSeenAt: observedAt,
      });
      writeRegistry(registry);
      return { deviceId, deviceSecret };
    },
    verifyDevice({ deviceId, nonce, proof, clientTs }) {
      const registry = readRegistry();
      const device = registry.devices.find((candidate) => candidate.deviceId === deviceId);
      if (!device) return { ok: false, code: "device_unknown" };
      if (Math.abs(clientTs - now()) > MOBILE_APP_CLIENT_TS_SKEW_MS) {
        return { ok: false, code: "auth_expired" };
      }
      // 与 App 端 calculateMobilePairingProofPure(role="app")同公式,已互算验证一致。
      const expected = calculateMobilePairingProof(
        device.secret,
        nonce,
        MOBILE_APP_AUTH_ROLE,
        deviceId,
      );
      if (!verifyMobilePairingProof(expected, proof)) {
        return { ok: false, code: "auth_failed" };
      }
      device.lastSeenAt = now();
      try {
        writeRegistry(registry);
      } catch {
        // 刷新失败不影响本次认证。
      }
      return { ok: true };
    },
    revokeDevice(deviceId) {
      const registry = readRegistry();
      const next = registry.devices.filter((device) => device.deviceId !== deviceId);
      if (next.length === registry.devices.length) return false;
      registry.devices = next;
      writeRegistry(registry);
      return true;
    },
    touchDevice(deviceId) {
      const registry = readRegistry();
      const device = registry.devices.find((candidate) => candidate.deviceId === deviceId);
      if (!device) return;
      device.lastSeenAt = now();
      try {
        writeRegistry(registry);
      } catch {
        // 活跃度刷新失败可忽略。
      }
    },
  };
}
