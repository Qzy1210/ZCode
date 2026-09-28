/* 手机远控页:解析二维码 URL → WS 握手 → 桥接 → 移动端首页(工作区/任务列表)
 * → 点任务进入会话(root,web-remote-replayable)。
 *
 * 路由:/remote?sid=...&hash=...&t=...&mid=...&name=...&app_version=...
 * 页面 origin 即桌面配对服务 origin(扫码 URL 的 host),无需额外发现。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppErrorBoundary,
  Root,
  ZCodeIntlProvider,
  generateMobileDeviceFingerprint,
  setStreamClientId,
  useZCodeIntl,
} from "@zcode/ui";
import { ChannelClient } from "@zcode/rpc";
import { RemoteServiceAccess } from "@zcode/client";
import { parseMobilePairingQrUrl } from "@zcode/shared";
import { connectMobilePairingTransport } from "./mobilePairingTransport.js";
import type { MobilePairingTransportPhase } from "./mobilePairingTransport.js";
import { MobileHomePage, type MobileOpenTaskTarget } from "./MobileHomePage.js";

type PageState =
  | { kind: "connecting" }
  | { kind: "phase"; phase: MobilePairingTransportPhase; detail?: string }
  | { kind: "error"; code: string; message?: string }
  | { kind: "ready"; services: RemoteServiceAccess };

const PHASE_COPY: Record<string, string> = {
  connecting: "正在连接桌面…",
  authenticating: "正在验证配对…",
  bridging: "正在同步工作区…",
  ready: "已连接",
  closed: "连接已断开",
};

export function MobileRemotePage() {
  const [state, setState] = useState<PageState>({ kind: "connecting" });
  const [openTask, setOpenTask] = useState<MobileOpenTaskTarget | null>(null);

  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const qr = parseMobilePairingQrUrl(window.location.href);
    if (!qr) {
      setState({ kind: "error", code: "invalid_qr", message: "二维码链接无效或已损坏" });
      return;
    }
    // 页面 origin 就是桌面服务(二维码由桌面生成)。
    const serverOrigin = window.location.origin;

    connectMobilePairingTransport({ qr, serverOrigin })
      .then((protocol) => {
        const client = new ChannelClient(protocol);
        setStreamClientId(generateMobileDeviceFingerprint());
        setState({ kind: "ready", services: new RemoteServiceAccess(client) });
      })
      .catch((error: unknown) => {
        const code =
          (error as { code?: string }).code ??
          (error instanceof Error ? error.message : String(error));
        setState({ kind: "error", code: String(code) });
      });
  }, []);

  // 会话页返回列表页:同时支持页面内返回按钮与手机系统/浏览器返回手势。
  useEffect(() => {
    const onPopState = () => setOpenTask(null);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const handleOpenTask = useCallback((target: MobileOpenTaskTarget) => {
    setOpenTask(target);
    // pushState 让系统返回手势先回到列表页,而不是直接离开页面。
    window.history.pushState({ zcodeMobileTaskId: target.taskId }, "");
  }, []);

  if (state.kind === "error") {
    return (
      <div className="h-dvh w-screen bg-background text-foreground">
        <div className="mx-auto flex h-full w-full max-w-lg items-center px-4">
          <section className="w-full rounded-xl border border-card-border bg-card p-5">
            <div className="flex items-center gap-3">
              <span className="size-2 rounded-full bg-destructive" />
              <h1 className="text-ui-xs font-medium">无法连接桌面</h1>
            </div>
            <p className="mt-2 break-all text-ui-xs/relaxed text-foreground-subtle">
              {state.message ?? state.code}
            </p>
            <p className="mt-1 text-ui-xs/relaxed text-foreground-subtle">
              请确认手机与电脑网络可达，并在桌面端重新生成二维码。
            </p>
            <button
              type="button"
              className="mt-4 rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs text-foreground-subtle hover:bg-surface-hover"
              onClick={() => window.location.reload()}
            >
              重试
            </button>
          </section>
        </div>
      </div>
    );
  }

  if (state.kind === "ready") {
    const services = state.services;
    return (
      <AppErrorBoundary>
        <ZCodeIntlProvider
          settingService={services.settingService}
          broadcastService={services.broadcastService}
        >
          {openTask ? (
            <>
              <Root
                services={services}
                platform={createMobileRemotePlatform()}
                initialWorkspaceAbsPath={openTask.workspacePath}
                initialWorkspaceIdentity={openTask.workspaceIdentity}
                initialTaskId={openTask.taskId}
                preferDirectoryBrowser={false}
                supportsEmbeddedBrowser={false}
                allowRemoteWorkspace={false}
              />
              <MobileBackToHomeButton />
            </>
          ) : (
            <MobileHomePage services={services} onOpenTask={handleOpenTask} />
          )}
        </ZCodeIntlProvider>
      </AppErrorBoundary>
    );
  }

  const phaseLabel =
    state.kind === "phase"
      ? PHASE_COPY[state.phase]
      : state.kind === "connecting"
        ? PHASE_COPY.connecting
        : "";
  return (
    <div className="h-dvh w-screen bg-background text-foreground">
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <div className="size-10 animate-spin rounded-full border-2 border-border border-t-primary" />
        <p className="text-ui-xs text-foreground-subtle">{phaseLabel}</p>
      </div>
    </div>
  );
}

/** 会话页顶部的返回列表入口:悬浮在桌面壳 header 中央,避开左右侧控件。 */
function MobileBackToHomeButton() {
  const { intl } = useZCodeIntl();
  return (
    <button
      type="button"
      className="fixed left-1/2 top-1.5 z-[60] -translate-x-1/2 rounded-full border border-border bg-card/90 px-3 py-1 text-ui-xs text-foreground-subtle shadow-lg backdrop-blur"
      onClick={() => window.history.back()}
    >
      ‹ {intl.formatMessage({ id: "mobileRemote.backToList" })}
    </button>
  );
}

/** 手机远控平台能力:Web 同构空实现 + 远控差异项。 */
function createMobileRemotePlatform(): Parameters<typeof Root>[0]["platform"] {
  return {
    canSelectFilePath: false,
    selectDirectory: () => Promise.resolve(null),
    selectFile: () => Promise.resolve(null),
    selectFiles: () => Promise.resolve([]),
    getPathForFile: () => null,
    createTempTextAttachment: () =>
      Promise.reject(new Error("Temporary text attachments require a desktop host")),
    onRemoteConnectionLog: () => () => {},
    onRemoteSessionClosed: () => () => {},
    onBotRemoteWorkspaceReconnected: () => () => {},
    activateOrSetWorkspace: () => Promise.resolve({ activated: false }),
    connectRemote: () =>
      Promise.resolve({
        success: false,
        error: "Remote connect is not supported in mobile remote mode",
      }),
    cancelPendingRemoteConnection: () => Promise.resolve(),
    disposeRemoteSession: () => Promise.resolve(),
    isDockerAvailable: () => Promise.resolve(false),
    listWSLDistros: () => Promise.resolve([]),
    listDockerContainers: () => Promise.resolve([]),
    listSSHConfigAliases: () => Promise.resolve([]),
    loadMcpFromUserDirectory: () => Promise.resolve({ servers: [] }),
    saveMcpToUserDirectory: () =>
      Promise.resolve({
        success: false,
        error: "MCP native directory management requires a desktop attachment",
      }),
    migrateLegacyCommonMcp: () =>
      Promise.resolve({ servers: {}, totalCount: 0, importedCount: 0, skippedCount: 0 }),
    openExternal: (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    openFeedback: () => Promise.resolve(),
    openCommunity: () => Promise.resolve(),
    canOpenCommunity: () => Promise.resolve(false),
    openInFileManager: () => Promise.resolve({ success: false, error: "Not supported" }),
    openExternalFile: () => Promise.resolve({ success: false, error: "Not supported" }),
    registerOAuthState: () => {},
    onOAuthCallback: () => () => {},
    onPaymentCallback: () => () => {},
    onShareImport: () => () => {},
    notifyRendererReady: () => {},
    reportTelemetryEvent: () => Promise.resolve(),
    reportArmsCustomEvent: () => Promise.resolve(),
    showTaskNotification: () => {},
    syncWindowTabs: () => {},
    syncWindowUnreadCount: () => {},
    syncActiveTaskSession: () => {},
    onFocusTab: () => () => {},
    onNewTab: () => () => {},
    onCloseActiveContextRequest: () => () => {},
    onOpenBrowserUrl: () => () => {},
    onNewTask: () => () => {},
    onOpenWorkspace: () => () => {},
    onWindowFullscreenChanged: () => () => {},
    onTaskNotificationClick: () => () => {},
    exportLogs: () => Promise.resolve({ success: false, error: "Not supported" }),
    captureWindowScreenshot: () => Promise.resolve(null),
    importChromeBrowserData: () =>
      Promise.resolve({
        success: false,
        cookies: { imported: 0, skipped: 0, failed: 0 },
        localStorage: {
          originsImported: 0,
          entriesImported: 0,
          originsSkipped: 0,
          originsFailed: 0,
        },
        error: "chrome_import_not_supported" as const,
      }),
    clearEmbeddedBrowserData: () => Promise.resolve({ success: false, error: "Not supported" }),
    onUpdateReady: () => () => {},
    onUpdateCheckResult: () => () => {},
    onUpdateStateChanged: () => () => {},
    getUpdateState: () => Promise.resolve({ kind: "idle", enabled: false }),
    downloadUpdate: () => Promise.resolve(),
    cancelUpdateDownload: () => Promise.resolve(),
    getDesktopSessionActivity: () => Promise.resolve({ runningAgentSessionCount: 0 }),
    getDesktopZoomLevel: () => Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: () => () => {},
    onPostUpdateReleaseNotes: () => () => {},
    acknowledgePostUpdateReleaseNotes: () => Promise.resolve(),
    skipUpdateVersion: () => Promise.resolve(),
    quitAndInstallUpdate: () => Promise.resolve(),
    getInstalledEditors: () => Promise.resolve([]),
    openInEditor: () => Promise.resolve({ success: false, error: "Not supported" }),
    executeDesktopCommand: () => Promise.resolve(),
    setApplicationLocale: () => Promise.resolve(),
    setTitleBarTheme: () => Promise.resolve(),
    getDeviceId: () => generateMobileDeviceFingerprint(),
  };
}
