/* 移动端配对协议的 Node crypto 部分。经 "@zcode/shared/mobilePairingCrypto" 子入口导出,
   不进根入口,保持根入口浏览器安全(与 workspace-hook-digest 同惯例)。
   桌面 main 侧专用:随机数生成与 HMAC proof 计算/校验。 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  MOBILE_PAIRING_NONCE_BYTES,
  MOBILE_PAIRING_SECRET_BYTES,
  mobilePairingBase64Url,
} from "./mobilePairing.js";

/** 配对会话 ID:`d_` + 22 位 URL-safe nanoid(与官方 sid 格式一致)。 */
export function generateMobilePairingSid(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(22);
  let sid = "d_";
  for (let index = 0; index < 22; index += 1) {
    const byte = bytes[index];
    if (byte === undefined) break;
    sid += alphabet[byte % alphabet.length] ?? "0";
  }
  return sid;
}

/** 32 字节随机 secret。只存在于桌面内存与二维码中,不落盘、不进日志。 */
export function generateMobilePairingSecret(): Buffer {
  return randomBytes(MOBILE_PAIRING_SECRET_BYTES);
}

/** 32 字节随机 nonce(base64url)。 */
export function generateMobilePairingNonce(): string {
  return mobilePairingBase64Url(randomBytes(MOBILE_PAIRING_NONCE_BYTES));
}

/**
 * proof = base64url(HMAC-SHA256(K, `${nonce}|${role}|${deviceSid}`))。
 * K = hash 字符串(base64url)的 UTF-8 字节——与官方 remote/v4 bundle 的
 * calculateProof(H2t)逐字一致,key 是字符串本身而非解码后的原始 secret。
 */
export function calculateMobilePairingProof(
  secretHash: string,
  nonce: string,
  role: string,
  deviceSid: string,
): string {
  const hmac = createHmac("sha256", Buffer.from(secretHash, "utf8"));
  hmac.update(`${nonce}|${role}|${deviceSid}`);
  return mobilePairingBase64Url(hmac.digest());
}

/** 恒时比较两个 base64url proof,防时序侧信道。 */
export function verifyMobilePairingProof(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
