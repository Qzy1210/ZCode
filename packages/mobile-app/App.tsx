/* ZCode 手机 App:首次扫码配对换取长期凭证,之后免扫码自动连接(P1),
 * 任务列表 → 会话视图(P2,历史 + 实时流式 + 发送)。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { ChannelClient, SocketProtocol } from "@zcode/rpc";
import { RemoteServiceAccess } from "@zcode/client";

import {
  clearDeviceCredential,
  loadDeviceCredential,
  saveDeviceCredential,
  type DeviceCredential,
} from "./src/deviceCredential";
import type { PairingQrPayload } from "./src/pairingQr";
import {
  createConnectionTransport,
  type PairingTransport,
  type PairingTransportPhase,
} from "./src/pairingTransport";
import { PairScreen } from "./src/screens/PairScreen";
import { SessionScreen } from "./src/screens/SessionScreen";
import { TaskListScreen } from "./src/screens/TaskListScreen";
import { theme } from "./src/theme";

type AppState =
  | { kind: "booting" }
  | { kind: "pair" }
  | { kind: "connecting"; label: string; detail?: string; canCancel: boolean }
  | { kind: "error"; code: string; hint: string; canRetryAuto: boolean }
  | { kind: "ready"; services: RemoteServiceAccess; mode: "pairing" | "device" };

const PHASE_COPY: Record<PairingTransportPhase, string> = {
  connecting: "正在连接桌面…",
  authenticating: "正在验证配对…",
  bridging: "正在同步工作区…",
  ready: "已连接",
  closed: "连接已断开",
};

/** 免扫码自动重连退避序列;用尽后转手动入口。 */
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000];

/** 与 web 端 MobileRemotePage 的错误指引保持一致,并补充设备凭证相关码。 */
const ERROR_HINTS: Record<string, string> = {
  pair_expired: "配对链接已过期，请在桌面端重新生成二维码后重新扫码。",
  pair_unknown: "配对链接已失效，请重新扫码。",
  auth_failed: "配对校验失败，请重新扫码。",
  rate_limited: "认证尝试次数过多，请在桌面端重新生成二维码。",
  device_unknown: "这台设备的凭证已失效（桌面端可能已吊销或重装），请重新扫码配对。",
  device_revoked: "这台设备的凭证已被吊销，请重新扫码配对。",
  desktop_disconnected: "与桌面端的连接已断开，请确认桌面端仍在运行。",
  relay_unavailable: "无法连接中继服务，请检查网络后重试。",
  connection_timeout: "连接超时，请确认手机与桌面端网络可达。",
  workspace_unavailable: "桌面端工作区暂不可用，请确认桌面窗口仍在运行。",
};

/** 凭证失效类错误:清除本地凭证并回到扫码配对。 */
const CREDENTIAL_INVALID_CODES = new Set(["device_unknown", "device_revoked", "auth_failed"]);

/** 会话屏打开目标:任务行三元组(taskId === sessionId)。 */
interface OpenTaskTarget {
  taskId: string;
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export default function App() {
  const [state, setState] = useState<AppState>({ kind: "booting" });
  /** 已打开的任务会话;null 表示停留在任务列表。 */
  const [openTask, setOpenTask] = useState<OpenTaskTarget | null>(null);
  const transportRef = useRef<PairingTransport | null>(null);
  const clientRef = useRef<ChannelClient | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 连接代际:自增即作废在途连接/重试,避免旧回调覆盖新状态。 */
  const generationRef = useRef(0);

  const deviceName = Platform.OS === "android" ? "Android 手机" : "手机 App";

  const releaseConnection = useCallback((bumpGeneration = true) => {
    if (bumpGeneration) generationRef.current += 1;
    // 连接换代即离开会话:旧 services 已失效,回列表避免继续消费已废弃的订阅。
    setOpenTask(null);
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    clientRef.current?.dispose();
    clientRef.current = null;
    transportRef.current?.dispose();
    transportRef.current = null;
  }, []);

  const connectWithCredential = useCallback(
    async (credential: DeviceCredential, attempt: number): Promise<void> => {
      releaseConnection();
      const generation = generationRef.current;
      setState({
        kind: "connecting",
        label: attempt === 0 ? "正在连接桌面…" : "连接失败，自动重试中…",
        ...(attempt === 0 ? {} : { detail: `即将进行第 ${attempt + 1} 次尝试` }),
        canCancel: true,
      });
      const transport = createConnectionTransport({
        auth: { mode: "device", credential },
        serverOrigin: credential.relayOrigin,
      });
      transportRef.current = transport;
      try {
        const socket = await transport.connect();
        if (generation !== generationRef.current) return;
        const client = new ChannelClient(new SocketProtocol(socket));
        clientRef.current = client;
        setState({ kind: "ready", services: new RemoteServiceAccess(client), mode: "device" });
      } catch (error: unknown) {
        if (generation !== generationRef.current) return;
        transportRef.current = null;
        transport.dispose();
        const code = String(
          (error as { code?: string }).code ??
            (error instanceof Error ? error.message : error),
        );
        if (CREDENTIAL_INVALID_CODES.has(code)) {
          await clearDeviceCredential();
          setState({ kind: "error", code, hint: ERROR_HINTS[code] ?? "请重新扫码配对。", canRetryAuto: false });
          return;
        }
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
          setState({
            kind: "error",
            code,
            hint: ERROR_HINTS[code] ?? "自动重连失败，请检查网络后重试，或重新扫码配对。",
            canRetryAuto: true,
          });
          return;
        }
        setState({
          kind: "connecting",
          label: "连接失败，自动重试中…",
          detail: `${Math.round(delay / 1000)} 秒后第 ${attempt + 2} 次尝试`,
          canCancel: true,
        });
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          if (generation !== generationRef.current) return;
          void connectWithCredential(credential, attempt + 1);
        }, delay);
      }
    },
    [releaseConnection],
  );

  // 启动:有凭证 → 免扫码直连;没有 → 扫码配对。
  useEffect(() => {
    void (async () => {
      const credential = await loadDeviceCredential();
      if (!credential) {
        setState({ kind: "pair" });
        return;
      }
      await connectWithCredential(credential, 0);
    })();
    return () => releaseConnection();
  }, [connectWithCredential, releaseConnection]);

  const handlePaired = useCallback(
    async (qr: PairingQrPayload) => {
      releaseConnection();
      const generation = generationRef.current;
      setState({ kind: "connecting", label: PHASE_COPY.connecting, canCancel: false });
      const transport = createConnectionTransport({
        auth: { mode: "pairing", qr },
        serverOrigin: qr.origin,
      });
      transportRef.current = transport;
      transport.onPhaseChange((event) => {
        if (generation !== generationRef.current) return;
        if (event.phase === "closed" && event.error) return;
        setState((current) =>
          current.kind === "connecting"
            ? { ...current, label: PHASE_COPY[event.phase] ?? current.label }
            : current,
        );
      });
      try {
        const socket = await transport.connect();
        if (generation !== generationRef.current) return;
        const client = new ChannelClient(new SocketProtocol(socket));
        clientRef.current = client;
        setState({ kind: "ready", services: new RemoteServiceAccess(client), mode: "pairing" });
        // 领取长期凭证(最佳努力):失败只影响"下次是否免扫码",不影响本次使用。
        void transport
          .requestDeviceCredential(deviceName)
          .then((issued) =>
            saveDeviceCredential({
              relayOrigin: qr.origin,
              hostId: issued.hostId,
              deviceId: issued.deviceId,
              deviceSecret: issued.deviceSecret,
              deviceName,
              createdAt: Date.now(),
            }),
          )
          .catch(() => {});
      } catch (error: unknown) {
        if (generation !== generationRef.current) return;
        transportRef.current = null;
        transport.dispose();
        const code = String(
          (error as { code?: string }).code ??
            (error instanceof Error ? error.message : error),
        );
        setState({ kind: "error", code, hint: ERROR_HINTS[code] ?? "请在桌面端确认服务状态后重试。", canRetryAuto: false });
      }
    },
    [deviceName, releaseConnection],
  );

  const handleForgetDevice = useCallback(async () => {
    releaseConnection();
    await clearDeviceCredential();
    setState({ kind: "pair" });
  }, [releaseConnection]);

  const handleRetryFromError = useCallback(async () => {
    releaseConnection();
    const credential = await loadDeviceCredential();
    if (!credential) {
      setState({ kind: "pair" });
      return;
    }
    await connectWithCredential(credential, 0);
  }, [connectWithCredential, releaseConnection]);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
        <StatusBar style="light" />
        {state.kind === "booting" ? (
          <View style={styles.center}>
            <Text style={styles.phaseText}>正在启动…</Text>
          </View>
        ) : null}

        {state.kind === "pair" ? <PairScreen onPaired={handlePaired} /> : null}

        {state.kind === "connecting" ? (
          <View style={styles.center}>
            <Text style={styles.phaseText}>{state.label}</Text>
            {state.detail ? <Text style={styles.detailText}>{state.detail}</Text> : null}
            {state.canCancel ? (
              <Pressable style={styles.retryButton} onPress={() => void handleForgetDevice()}>
                <Text style={styles.retryText}>改用扫码配对</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {state.kind === "error" ? (
          <View style={styles.center}>
            <Text style={styles.errorTitle}>无法连接桌面</Text>
            <Text style={styles.errorCode}>{state.code}</Text>
            <Text style={styles.errorHint}>{state.hint}</Text>
            <View style={styles.errorActions}>
              {state.canRetryAuto ? (
                <Pressable style={styles.retryButton} onPress={() => void handleRetryFromError()}>
                  <Text style={styles.retryText}>重试</Text>
                </Pressable>
              ) : null}
              <Pressable style={styles.retryButton} onPress={() => void handleForgetDevice()}>
                <Text style={styles.retryText}>重新扫码配对</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {state.kind === "ready" ? (
          openTask ? (
            <SessionScreen
              services={state.services}
              workspacePath={openTask.workspacePath}
              {...(openTask.workspaceIdentity
                ? { workspaceIdentity: openTask.workspaceIdentity }
                : {})}
              sessionId={openTask.taskId}
              title={openTask.title}
              onBack={() => setOpenTask(null)}
            />
          ) : (
            <TaskListScreen
              services={state.services}
              connectionMode={state.mode}
              onOpenTask={setOpenTask}
              onDisconnect={() => {
                releaseConnection();
                setState({ kind: "pair" });
              }}
              onForgetDevice={() => void handleForgetDevice()}
            />
          )
        ) : null}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.background },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 10 },
  phaseText: { color: theme.foreground, fontSize: 15 },
  detailText: { color: theme.foregroundSubtle, fontSize: 13 },
  errorTitle: { color: theme.foreground, fontSize: 17, fontWeight: "600" },
  errorCode: { color: theme.destructive, fontSize: 13 },
  errorHint: { color: theme.foregroundSubtle, fontSize: 13, textAlign: "center", lineHeight: 20 },
  errorActions: { flexDirection: "row", gap: 10, marginTop: 8 },
  retryButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  retryText: { color: theme.foreground, fontSize: 14 },
});
