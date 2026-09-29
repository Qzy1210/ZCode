/* 设备凭证的安全存储:Android 走 Keystore 加密的 SecureStore。
 * 免扫码自动连接的核心状态——首次扫码配对成功后由桌面签发并落盘。 */
import * as SecureStore from "expo-secure-store";

const CREDENTIAL_KEY = "zcode.mobile.credential.v1";

export interface DeviceCredential {
  /** relay/桌面服务 origin(二维码 URL 的 scheme://host:port)。 */
  relayOrigin: string;
  /** 桌面持久身份(relay 路由用)。 */
  hostId: string;
  deviceId: string;
  deviceSecret: string;
  deviceName: string;
  createdAt: number;
}

export async function loadDeviceCredential(): Promise<DeviceCredential | null> {
  try {
    const raw = await SecureStore.getItemAsync(CREDENTIAL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DeviceCredential>;
    if (
      typeof parsed.relayOrigin !== "string" ||
      typeof parsed.hostId !== "string" ||
      typeof parsed.deviceId !== "string" ||
      typeof parsed.deviceSecret !== "string"
    ) {
      return null;
    }
    return {
      relayOrigin: parsed.relayOrigin,
      hostId: parsed.hostId,
      deviceId: parsed.deviceId,
      deviceSecret: parsed.deviceSecret,
      deviceName: typeof parsed.deviceName === "string" ? parsed.deviceName : "手机 App",
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export async function saveDeviceCredential(credential: DeviceCredential): Promise<void> {
  await SecureStore.setItemAsync(CREDENTIAL_KEY, JSON.stringify(credential));
}

export async function clearDeviceCredential(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(CREDENTIAL_KEY);
  } catch {
    // 清除失败不阻塞流程:下次连接失败时会再次走清除路径。
  }
}
