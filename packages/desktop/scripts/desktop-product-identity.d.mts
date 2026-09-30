/**
 * 类型声明:该脚本同时被 desktop main 进程复用(按 flavor 解析 Windows AppUserModelId、
 * 产品身份与预览通道判定)。脚本本身是 .mjs,这里只声明 main 侧实际用到的导出。
 */
export declare const ZCODE_PREVIEW_IDENTITY_ENV: string;
export declare const desktopProductIdentities: Readonly<Record<string, { appId: string }>>;
export declare function isPreviewIdentityRequested(env?: NodeJS.ProcessEnv): boolean;
export declare function resolveDesktopProductFlavor(env?: NodeJS.ProcessEnv): string;
export declare function resolveDesktopProductIdentity(env?: NodeJS.ProcessEnv): unknown;
export declare function resolveWindowsAppUserModelIdForFlavor(
  flavor: string,
  runtime?: { isPackaged: boolean },
): string;
export declare function resolveWindowsAppUserModelId(
  env?: NodeJS.ProcessEnv,
  runtime?: { isPackaged: boolean },
): string;
