import { randomUUID } from "node:crypto";
import {
  MOBILE_PAIRING_CLIENT_TS_SKEW_MS,
  MOBILE_PAIRING_MAX_AUTH_FAILURES,
  MOBILE_PAIRING_NONCE_TTL_MS,
  MOBILE_PAIRING_TTL_MS,
  mobilePairingBase64Url,
  type MobilePairingErrorCode,
} from "@zcode/shared";
import {
  calculateMobilePairingProof,
  generateMobilePairingNonce,
  generateMobilePairingSecret,
  generateMobilePairingSid,
  verifyMobilePairingProof,
} from "@zcode/shared/mobilePairingCrypto";

/**
 * 移动端配对会话状态机(单一所有者,main 进程内存态)。
 *
 * 生命周期:generate() 签发 sid+secret → 手机 auth_init → challenge → response 校验 →
 * paired。secret 只在本模块内存与二维码中出现;日志只允许携带 sid 前 6 位。
 */
interface MobilePairingSession {
  sid: string;
  secret: Buffer;
  issuedAtMs: number;
  expiresAtMs: number;
  status: "pending" | "paired";
  authFailures: number;
  challenge: { nonce: string; expiresAtMs: number } | null;
}

export interface MobilePairingChallenge {
  nonce: string;
}

export type MobilePairingVerifyResult =
  | { ok: true; status: "paired" }
  | {
      ok: false;
      code: Extract<
        MobilePairingErrorCode,
        "auth_failed" | "auth_expired" | "pair_expired" | "pair_unknown" | "rate_limited"
      >;
    };

export type MobilePairingBeginAuthResult =
  | { ok: true; challenge: MobilePairingChallenge }
  | {
      ok: false;
      code: Extract<
        MobilePairingErrorCode,
        "pair_expired" | "pair_unknown" | "rate_limited"
      >;
    };

export interface MobilePairingManager {
  /** 签发新配对会话,返回二维码所需材料。旧会话被注销。 */
  createQrPayload(input: {
    deviceMid: string;
    hostname: string;
    appVersion: string;
  }): { sid: string; hash: string; t: number; mid: string; name: string; appVersion: string };
  /** 手机 auth_init:校验 sid 与时间窗,发一次性 nonce。 */
  beginAuth(sid: string): MobilePairingBeginAuthResult;
  /** 手机 auth_response:校验 proof。成功即 paired,并滑动续期。 */
  verifyAuth(input: {
    sid: string;
    proof: string;
    clientTs: number;
  }): MobilePairingVerifyResult;
  /**
   * 滑动续期:把会话有效期推到 now+TTL。
   * 由已配对会话在桥接存活期间周期性调用——手机页面被系统回收后重新加载时,
   * 只要它此前保持在线,就还能用同一链接重新认证,不必回到桌面重新扫码。
   */
  touch(sid: string): void;
  /** 会话是否已 paired(桥接前置条件)。 */
  isPaired(sid: string): boolean;
  /** 注销会话(手动关闭二维码、失败超限、桌面退出)。 */
  revoke(sid: string): void;
  disposeAll(): void;
}

interface MobilePairingManagerOptions {
  now?: () => number;
  ttlMs?: number;
  nonceTtlMs?: number;
  maxAuthFailures?: number;
}

export function createMobilePairingManager(
  options: MobilePairingManagerOptions = {},
): MobilePairingManager {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? MOBILE_PAIRING_TTL_MS;
  const nonceTtlMs = options.nonceTtlMs ?? MOBILE_PAIRING_NONCE_TTL_MS;
  const maxAuthFailures = options.maxAuthFailures ?? MOBILE_PAIRING_MAX_AUTH_FAILURES;
  const sessions = new Map<string, MobilePairingSession>();

  function pruneExpired(observedAt: number): void {
    for (const [sid, session] of sessions) {
      if (session.expiresAtMs <= observedAt) sessions.delete(sid);
    }
  }

  function revoke(sid: string): void {
    sessions.delete(sid);
  }

  return {
    createQrPayload({ deviceMid, hostname, appVersion }) {
      const observedAt = now();
      pruneExpired(observedAt);
      // 同一时间只保留一个待配对会话:重新生成二维码意味着旧码作废,
      // 防止屏幕上残留旧二维码被扫后配到过期会话。
      sessions.clear();
      const sid = generateMobilePairingSid();
      const secret = generateMobilePairingSecret();
      sessions.set(sid, {
        sid,
        secret,
        issuedAtMs: observedAt,
        expiresAtMs: observedAt + ttlMs,
        status: "pending",
        authFailures: 0,
        challenge: null,
      });
      return {
        sid,
        hash: mobilePairingBase64Url(secret),
        t: observedAt,
        mid: deviceMid,
        name: hostname,
        appVersion,
      };
    },
    beginAuth(sid) {
      const observedAt = now();
      const session = sessions.get(sid);
      if (!session) return { ok: false, code: "pair_unknown" };
      // 先判过期再谈其他:过期会话此前会被 prune 掉、误报 pair_unknown,
      // 手机端因此拿不到"链接已过期"的可操作提示。
      if (session.expiresAtMs <= observedAt) {
        revoke(sid);
        return { ok: false, code: "pair_expired" };
      }
      if (session.authFailures >= maxAuthFailures) {
        revoke(sid);
        return { ok: false, code: "rate_limited" };
      }
      // nonce 一次性:beginAuth 即覆盖旧 nonce,旧 challenge 自动失效。
      const nonce = generateMobilePairingNonce();
      session.challenge = { nonce, expiresAtMs: observedAt + nonceTtlMs };
      return { ok: true, challenge: { nonce } };
    },
    verifyAuth({ sid, proof, clientTs }) {
      const observedAt = now();
      const session = sessions.get(sid);
      if (!session) return { ok: false, code: "pair_unknown" };
      if (session.expiresAtMs <= observedAt) {
        revoke(sid);
        return { ok: false, code: "pair_expired" };
      }
      const challenge = session.challenge;
      if (!challenge || challenge.expiresAtMs <= observedAt) {
        return { ok: false, code: "auth_expired" };
      }
      // client_ts 偏差窗校验:防旧 proof 重放(nonce 一次性之外的第二道防线)。
      if (Math.abs(clientTs - observedAt) > MOBILE_PAIRING_CLIENT_TS_SKEW_MS) {
        return { ok: false, code: "auth_expired" };
      }
      const expected = calculateMobilePairingProof(
        mobilePairingBase64Url(session.secret),
        challenge.nonce,
        "terminal",
        sid,
      );
      // nonce 消费后立即失效,无论校验成败都不可重试同一 challenge。
      session.challenge = null;
      if (!verifyMobilePairingProof(expected, proof)) {
        session.authFailures += 1;
        if (session.authFailures >= maxAuthFailures) {
          revoke(sid);
          return { ok: false, code: "rate_limited" };
        }
        return { ok: false, code: "auth_failed" };
      }
      session.status = "paired";
      // 认证成功即续期:手机页面刷新(reload)会重走一次完整认证,
      // 只要在上次活动 +TTL 内,就能用同一链接恢复,无需重新扫码。
      session.expiresAtMs = observedAt + ttlMs;
      return { ok: true, status: "paired" };
    },
    touch(sid) {
      const observedAt = now();
      const session = sessions.get(sid);
      if (!session || session.expiresAtMs <= observedAt) return;
      session.expiresAtMs = observedAt + ttlMs;
    },
    isPaired(sid) {
      const observedAt = now();
      pruneExpired(observedAt);
      const session = sessions.get(sid);
      return session?.status === "paired";
    },
    revoke,
    disposeAll() {
      sessions.clear();
    },
  };
}

/** 桥接 attachmentId 前缀,便于日志中区分手机来源。 */
export function generateMobilePairingAttachmentId(): string {
  return `mob_${randomUUID()}`;
}
