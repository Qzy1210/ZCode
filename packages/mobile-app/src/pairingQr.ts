/**
 * 配对二维码解析(Hermes 安全版):不依赖全局 URL / URLSearchParams —— 旧 Hermes
 * 未必提供,手动解析 origin 与 query 并做 decodeURIComponent(与 web 端 searchParams 语义一致)。
 */
export interface PairingQrPayload {
  sid: string;
  hash: string;
  appVersion: string;
  /** 桌面/relay 服务 origin(二维码 URL 的 scheme://host:port)。 */
  origin: string;
}

export function parsePairingQrPayload(raw: string): PairingQrPayload | null {
  const trimmed = raw.trim();
  const originMatch = /^(https?:\/\/[^/?#]+)/i.exec(trimmed);
  if (!originMatch || !originMatch[1]) return null;
  const queryIndex = trimmed.indexOf("?");
  if (queryIndex < 0) return null;

  try {
    const params = new Map<string, string>();
    for (const pair of trimmed.slice(queryIndex + 1).split("&")) {
      if (!pair) continue;
      const equalsIndex = pair.indexOf("=");
      const key = equalsIndex < 0 ? pair : pair.slice(0, equalsIndex);
      const value = equalsIndex < 0 ? "" : pair.slice(equalsIndex + 1);
      params.set(decodeURIComponent(key), decodeURIComponent(value));
    }
    const sid = params.get("sid") ?? "";
    const hash = params.get("hash") ?? "";
    if (!sid || !hash) return null;
    return {
      sid,
      hash,
      appVersion: params.get("app_version") ?? "",
      origin: originMatch[1],
    };
  } catch {
    return null;
  }
}
