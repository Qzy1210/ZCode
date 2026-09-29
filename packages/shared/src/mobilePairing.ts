/* eslint-disable max-lines -- 移动端局域网直连配对协议的浏览器安全部分(常量/URL/schema)
   集中在这里,桌面 main 与手机 Web 两侧共用同一份定义,避免帧格式漂移。
   Node crypto 相关(calculateProof/随机数)在 mobilePairingCrypto.ts,经
   "@zcode/shared/mobilePairingCrypto" 子入口导出,保持根入口浏览器安全。 */
import { z } from "zod";

/** 配对二维码有效期。 */
export const MOBILE_PAIRING_TTL_MS = 10 * 60 * 1000;
/** auth_challenge nonce 的有效期。 */
export const MOBILE_PAIRING_NONCE_TTL_MS = 90 * 1000;
/** 同一 sid 认证失败次数上限,达到即注销配对会话。 */
export const MOBILE_PAIRING_MAX_AUTH_FAILURES = 3;
/** auth_response.client_ts 与桌面时钟允许的最大偏差。 */
export const MOBILE_PAIRING_CLIENT_TS_SKEW_MS = 5 * 60 * 1000;
/** secret 字节数(32B = 256bit,base64url 后 43 字符)。 */
export const MOBILE_PAIRING_SECRET_BYTES = 32;
/** nonce 字节数。 */
export const MOBILE_PAIRING_NONCE_BYTES = 32;

const nonEmptyString = z.string().min(1);

/** 手机认证角色。与官方协议一致,手机 Web 固定 terminal。 */
export const MOBILE_PAIRING_AUTH_ROLE = "terminal" as const;

/** 配对会话 ID:`d_` + 22 位 URL-safe nanoid。 */
export const MOBILE_PAIRING_SID_PATTERN = /^d_[A-Za-z0-9]{22}$/;

/** base64url 编码(与官方 H2t 的 V2t 一致:标准 base64 去填充,+/→-_)。纯 JS,浏览器安全。 */
export function mobilePairingBase64Url(input: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < input.length; index += 1) {
    const byte = input[index];
    if (byte === undefined) break;
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface MobilePairingQrPayload {
  sid: string;
  hash: string;
  t: number;
  mid: string;
  name: string;
  appVersion: string;
}

/** 构造二维码 URL(参数名与官方一致,方便对照抓包)。 */
export function buildMobilePairingQrUrl(
  origin: string,
  payload: MobilePairingQrPayload,
): string {
  const url = new URL(`${origin.replace(/\/+$/, "")}/remote`);
  url.searchParams.set("sid", payload.sid);
  url.searchParams.set("hash", payload.hash);
  url.searchParams.set("t", String(payload.t));
  url.searchParams.set("mid", payload.mid);
  url.searchParams.set("name", payload.name);
  url.searchParams.set("app_version", payload.appVersion);
  return url.toString();
}

/** 手机端解析二维码 URL。缺失必需参数返回 null,由页面渲染错误态。 */
export function parseMobilePairingQrUrl(url: string): MobilePairingQrPayload | null {
  try {
    const parsed = new URL(url);
    const sid = parsed.searchParams.get("sid")?.trim();
    const hash = parsed.searchParams.get("hash")?.trim();
    const t = Number(parsed.searchParams.get("t"));
    const mid = parsed.searchParams.get("mid")?.trim();
    const name = parsed.searchParams.get("name")?.trim();
    const appVersion = parsed.searchParams.get("app_version")?.trim() ?? "";
    if (!sid || !hash || !Number.isFinite(t) || t <= 0 || !mid) return null;
    return { sid, hash, t, mid, name: name ?? "", appVersion };
  } catch {
    return null;
  }
}

/** 校验二维码时间窗(宽松于 challenge,签发后 TTL 内可发起认证)。 */
export function isMobilePairingQrFresh(issuedAtMs: number, nowMs: number): boolean {
  return nowMs >= issuedAtMs && nowMs - issuedAtMs <= MOBILE_PAIRING_TTL_MS;
}

/* ---------------------------------- WS 帧 ---------------------------------- */

export const mobilePairingAuthInitSchema = z
  .object({
    type: z.literal("auth_init"),
    role: z.literal(MOBILE_PAIRING_AUTH_ROLE),
    device_sid: nonEmptyString,
    meta: z
      .object({
        platform: z.string().max(64),
        version: z.string().max(64),
        name: z.string().max(128),
      })
      .partial()
      .optional(),
  })
  .strict();
export type MobilePairingAuthInit = z.infer<typeof mobilePairingAuthInitSchema>;

export const mobilePairingAuthChallengeSchema = z
  .object({
    type: z.literal("auth_challenge"),
    nonce: nonEmptyString,
  })
  .strict();
export type MobilePairingAuthChallenge = z.infer<typeof mobilePairingAuthChallengeSchema>;

export const mobilePairingAuthResponseSchema = z
  .object({
    type: z.literal("auth_response"),
    device_sid: nonEmptyString,
    proof: nonEmptyString,
    client_ts: z.number().int().positive(),
  })
  .strict();
export type MobilePairingAuthResponse = z.infer<typeof mobilePairingAuthResponseSchema>;

export const MOBILE_PAIRING_ERROR_CODES = [
  "auth_failed",
  "auth_expired",
  "pair_expired",
  "pair_unknown",
  "device_unknown",
  "device_revoked",
  "rate_limited",
  "workspace_unavailable",
  "bridge_failed",
  "internal_error",
] as const;
export type MobilePairingErrorCode = (typeof MOBILE_PAIRING_ERROR_CODES)[number];

export const mobilePairingErrorFrameSchema = z
  .object({
    type: z.literal("error"),
    code: z.enum(MOBILE_PAIRING_ERROR_CODES),
    message: z.string().max(512).optional(),
  })
  .strict();
export type MobilePairingErrorFrame = z.infer<typeof mobilePairingErrorFrameSchema>;

export const mobilePairingAuthAckFrameSchema = z
  .object({
    type: z.literal("auth_ack"),
    pair_status: z.literal("paired"),
  })
  .strict();
export type MobilePairingAuthAckFrame = z.infer<typeof mobilePairingAuthAckFrameSchema>;

/** 认证后业务帧:直接透传 rpc-frame(JSON 字符串),server 不解析。 */
export const mobilePairingDataFrameSchema = z
  .object({
    type: z.literal("data"),
    payload: z.string().min(1),
  })
  .strict();
export type MobilePairingDataFrame = z.infer<typeof mobilePairingDataFrameSchema>;

/** 手机请求桥接到指定工作区。认证后首条业务帧。 */
export const mobilePairingBridgeRequestFrameSchema = z
  .object({
    type: z.literal("bridge_request"),
    workspaceKey: nonEmptyString,
  })
  .strict();
export type MobilePairingBridgeRequestFrame = z.infer<
  typeof mobilePairingBridgeRequestFrameSchema
>;

export const mobilePairingBridgeReadyFrameSchema = z
  .object({
    type: z.literal("bridge_ready"),
    workspaceKey: nonEmptyString,
  })
  .strict();
export type MobilePairingBridgeReadyFrame = z.infer<typeof mobilePairingBridgeReadyFrameSchema>;

/* ------------------------- 持久设备凭证(App 模式) ------------------------- */
/*
 * 首次经二维码配对、会话认证通过后,App 可请求签发长期设备凭证;
 * 之后每次启动免扫码:app_auth_init(hostId 供 relay 路由,deviceId 供桌面校验)
 * → 挑战应答(HMAC,role="app")→ 桥接。凭证只在签发时下发一次。
 */

/** 设备认证角色(与扫码会话的 terminal 区分,proof 域隔离)。 */
export const MOBILE_APP_AUTH_ROLE = "app" as const;

/** App → 桌面:请求签发长期凭证(仅允许在已认证会话上)。 */
export const mobileAppRegisterRequestSchema = z
  .object({
    type: z.literal("app_register_request"),
    deviceName: z.string().min(1).max(64),
  })
  .strict();
export type MobileAppRegisterRequest = z.infer<typeof mobileAppRegisterRequestSchema>;

/** 桌面 → App:签发凭证(secret 仅此一次下发,桌面落盘保存)。 */
export const mobileAppRegisterGrantedSchema = z
  .object({
    type: z.literal("device_registered"),
    hostId: nonEmptyString,
    deviceId: nonEmptyString,
    deviceSecret: nonEmptyString,
  })
  .strict();
export type MobileAppRegisterGranted = z.infer<typeof mobileAppRegisterGrantedSchema>;

/** App → 桌面:免扫码连接发起。 */
export const mobileAppAuthInitSchema = z
  .object({
    type: z.literal("app_auth_init"),
    hostId: nonEmptyString,
    deviceId: nonEmptyString,
  })
  .strict();
export type MobileAppAuthInit = z.infer<typeof mobileAppAuthInitSchema>;

/** 桌面 → App:设备认证挑战。 */
export const mobileAppAuthChallengeSchema = z
  .object({
    type: z.literal("app_auth_challenge"),
    nonce: nonEmptyString,
  })
  .strict();
export type MobileAppAuthChallenge = z.infer<typeof mobileAppAuthChallengeSchema>;

/** App → 桌面:设备认证应答(proof 见 calculateMobilePairingProofPure,role="app",id=deviceId)。 */
export const mobileAppAuthResponseSchema = z
  .object({
    type: z.literal("app_auth_response"),
    deviceId: nonEmptyString,
    proof: nonEmptyString,
    client_ts: z.number().int().positive(),
  })
  .strict();
export type MobileAppAuthResponse = z.infer<typeof mobileAppAuthResponseSchema>;

/** 桌面 → App:设备认证通过。 */
export const mobileAppAuthAckSchema = z
  .object({
    type: z.literal("app_auth_ack"),
    pair_status: z.literal("paired"),
  })
  .strict();
export type MobileAppAuthAck = z.infer<typeof mobileAppAuthAckSchema>;

/** 手机 → 桌面所有可能帧。 */
export const mobilePairingClientFrameSchema = z.discriminatedUnion("type", [
  mobilePairingAuthInitSchema,
  mobilePairingAuthResponseSchema,
  mobileAppAuthInitSchema,
  mobileAppAuthResponseSchema,
  mobileAppRegisterRequestSchema,
  mobilePairingBridgeRequestFrameSchema,
  mobilePairingDataFrameSchema,
]);
export type MobilePairingClientFrame = z.infer<typeof mobilePairingClientFrameSchema>;

/** 桌面 → 手机所有可能帧。 */
export const mobilePairingServerFrameSchema = z.discriminatedUnion("type", [
  mobilePairingAuthChallengeSchema,
  mobilePairingAuthAckFrameSchema,
  mobileAppAuthChallengeSchema,
  mobileAppAuthAckSchema,
  mobileAppRegisterGrantedSchema,
  mobilePairingBridgeReadyFrameSchema,
  mobilePairingErrorFrameSchema,
  mobilePairingDataFrameSchema,
]);
export type MobilePairingServerFrame = z.infer<typeof mobilePairingServerFrameSchema>;

/* ---------------------- 纯 JS HMAC-SHA256(浏览器安全) ---------------------- */
/*
 * 手机页面可能经 relay 以裸 IP + HTTP 提供(非安全上下文),crypto.subtle 为
 * undefined,WebCrypto 不可用;这里提供与 mobilePairingCrypto.ts(桌面,Node
 * crypto)输出完全一致的纯 JS 实现。正确性由与 Node crypto 互算验证保证。
 */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** 安全读取 Uint32Array(长度已知非空,undefined 兜底 0 满足严格索引检查)。 */
function at(list: Uint32Array, index: number): number {
  return list[index] ?? 0;
}

function sha256Pure(message: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  // 填充:0x80 + zeros + 8 字节大端位长度,总长为 64 的倍数。
  const padded = new Uint8Array(((message.length + 8) >> 6) * 64 + 64);
  padded.set(message);
  padded[message.length] = 0x80;
  const bitLength = message.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bitLength >>> 0, false);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000), false);

  const w = new Uint32Array(64);
  const rr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const wi15 = at(w, i - 15);
      const wi2 = at(w, i - 2);
      const s0 = rr(wi15, 7) ^ rr(wi15, 18) ^ (wi15 >>> 3);
      const s1 = rr(wi2, 17) ^ rr(wi2, 19) ^ (wi2 >>> 10);
      w[i] = (at(w, i - 16) + s0 + at(w, i - 7) + s1) >>> 0;
    }
    let a = at(h, 0), b = at(h, 1), c = at(h, 2), d = at(h, 3);
    let e = at(h, 4), f = at(h, 5), g = at(h, 6), hh = at(h, 7);
    for (let i = 0; i < 64; i += 1) {
      const s1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + at(SHA256_K, i) + at(w, i)) >>> 0;
      const s0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (at(h, 0) + a) >>> 0; h[1] = (at(h, 1) + b) >>> 0;
    h[2] = (at(h, 2) + c) >>> 0; h[3] = (at(h, 3) + d) >>> 0;
    h[4] = (at(h, 4) + e) >>> 0; h[5] = (at(h, 5) + f) >>> 0;
    h[6] = (at(h, 6) + g) >>> 0; h[7] = (at(h, 7) + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, at(h, i), false);
  return out;
}

function hmacSha256Pure(key: Uint8Array, message: Uint8Array): Uint8Array {
  const blockSize = 64;
  const normalizedKey = key.length > blockSize ? sha256Pure(key) : key;
  const inner = new Uint8Array(blockSize + message.length);
  const outer = new Uint8Array(blockSize + 32);
  for (let i = 0; i < blockSize; i += 1) {
    const byte = normalizedKey[i] ?? 0;
    inner[i] = byte ^ 0x36;
    outer[i] = byte ^ 0x5c;
  }
  inner.set(message, blockSize);
  outer.set(sha256Pure(inner), blockSize);
  return sha256Pure(outer);
}

/**
 * 纯 JS 版 proof(与桌面 mobilePairingCrypto.calculateMobilePairingProof 同公式):
 * base64url(HMAC-SHA256(utf8(secretHash), utf8(`${nonce}|${role}|${deviceSid}`)))。
 * 供浏览器非安全上下文使用;桌面端仍用 Node crypto 实现。
 */
export function calculateMobilePairingProofPure(
  secretHash: string,
  nonce: string,
  role: string,
  deviceSid: string,
): string {
  const encoder = new TextEncoder();
  const signature = hmacSha256Pure(
    encoder.encode(secretHash),
    encoder.encode(`${nonce}|${role}|${deviceSid}`),
  );
  return mobilePairingBase64Url(signature);
}
