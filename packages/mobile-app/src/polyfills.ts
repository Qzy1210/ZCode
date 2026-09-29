/**
 * Hermes 各版本对 Web 标准 API 的支持不一致,而 @zcode/shared 的纯 JS
 * HMAC / base64url 依赖 TextEncoder 与 btoa。启动时兜底注入最小实现。
 */
function encodeUtf8ToBytes(input: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    let codePoint = input.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < input.length) {
      const next = input.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = (codePoint - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000;
        index += 1;
      }
    }
    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function encodeBase64(input: string): string {
  const bytes = encodeUtf8ToBytes(input);
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = index + 1 < bytes.length ? (bytes[index + 1] ?? 0) : undefined;
    const third = index + 2 < bytes.length ? (bytes[index + 2] ?? 0) : undefined;
    output += BASE64_ALPHABET[first >> 2] ?? "";
    output += BASE64_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)] ?? "";
    output +=
      second === undefined
        ? "="
        : (BASE64_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)] ?? "");
    output += third === undefined ? "=" : (BASE64_ALPHABET[third & 0x3f] ?? "");
  }
  return output;
}

export function ensureRuntimePolyfills(): void {
  const scope = globalThis as unknown as Record<string, unknown>;
  if (typeof scope.TextEncoder === "undefined") {
    scope.TextEncoder = class {
      encode(input: string): Uint8Array {
        return encodeUtf8ToBytes(input);
      }
    };
  }
  if (typeof scope.btoa === "undefined") {
    scope.btoa = (input: string) => encodeBase64(input);
  }
}
