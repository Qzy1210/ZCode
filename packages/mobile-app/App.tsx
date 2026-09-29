/* ZCode 手机 App(P0):扫码配对 → 连接桌面 Host → 项目/任务列表(实时)。
 * 会话界面(P2)与持久凭证(P1)按方案分期接入。
 */
import { useCallback, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { ChannelClient, SocketProtocol } from "@zcode/rpc";
import { RemoteServiceAccess } from "@zcode/client";

import type { PairingQrPayload } from "./src/pairingQr";
import {
  createPairingTransport,
  type PairingTransportPhase,
} from "./src/pairingTransport";
import { PairScreen } from "./src/screens/PairScreen";
import { TaskListScreen } from "./src/screens/TaskListScreen";
import { theme } from "./src/theme";

type AppState =
  | { kind: "pair" }
  | { kind: "connecting"; phase: PairingTransportPhase }
  | { kind: "error"; code: string; message?: string }
  | { kind: "ready"; services: RemoteServiceAccess };

const PHASE_COPY: Record<PairingTransportPhase, string> = {
  connecting: "正在连接桌面…",
  authenticating: "正在验证配对…",
  bridging: "正在同步工作区…",
  ready: "已连接",
  closed: "连接已断开",
};

/** 与 web 端 MobileRemotePage 的错误指引保持一致的措辞。 */
const ERROR_HINTS: Record<string, string> = {
  pair_expired: "配对链接已过期，请在桌面端重新生成二维码后重新扫码。",
  pair_unknown: "配对链接已失效，请重新扫码。",
  auth_failed: "配对校验失败，请重新扫码。",
  rate_limited: "认证尝试次数过多，请在桌面端重新生成二维码。",
  desktop_disconnected: "与桌面端的连接已断开，请确认桌面端仍在运行。",
  relay_unavailable: "无法连接中继服务，请检查网络后重试。",
  connection_timeout: "连接超时，请确认手机与桌面端网络可达。",
  workspace_unavailable: "桌面端工作区暂不可用，请确认桌面窗口仍在运行。",
};

export default function App() {
  const [state, setState] = useState<AppState>({ kind: "pair" });
  const transportRef = useRef<ReturnType<typeof createPairingTransport> | null>(null);
  const clientRef = useRef<ChannelClient | null>(null);

  const serverOriginRef = useRef<string>("");

  const handlePaired = useCallback((qr: PairingQrPayload) => {
    serverOriginRef.current = qr.origin;
    setState({ kind: "connecting", phase: "connecting" });
    const transport = createPairingTransport({ qr, serverOrigin: qr.origin });
    transportRef.current = transport;
    transport.onPhaseChange((event) => {
      if (event.phase === "closed" && event.error) return; // 失败态由 connect().catch 处理。
      setState((current) =>
        current.kind === "connecting" ? { kind: "connecting", phase: event.phase } : current,
      );
    });
    transport
      .connect()
      .then((socket) => {
        // ChannelClient 需要 IMessagePassingProtocol;ISocket 必须先经 SocketProtocol 分帧包装。
        const client = new ChannelClient(new SocketProtocol(socket));
        clientRef.current = client;
        setState({ kind: "ready", services: new RemoteServiceAccess(client) });
      })
      .catch((error: unknown) => {
        const code =
          (error as { code?: string }).code ??
          (error instanceof Error ? error.message : String(error));
        setState({ kind: "error", code: String(code) });
        transport.dispose();
        transportRef.current = null;
      });
  }, []);

  const handleDisconnect = useCallback(() => {
    clientRef.current?.dispose();
    clientRef.current = null;
    transportRef.current?.dispose();
    transportRef.current = null;
    setState({ kind: "pair" });
  }, []);

  return (
    // react-native 核心 SafeAreaView 在 Android 上是空实现(iOS 专属),统一用 safe-area-context。
    <SafeAreaProvider>
      <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
        <StatusBar style="light" />
      {state.kind === "pair" ? <PairScreen onPaired={handlePaired} /> : null}

      {state.kind === "connecting" ? (
        <View style={styles.center}>
          <Text style={styles.phaseText}>{PHASE_COPY[state.phase]}</Text>
        </View>
      ) : null}

      {state.kind === "error" ? (
        <View style={styles.center}>
          <Text style={styles.errorTitle}>无法连接桌面</Text>
          <Text style={styles.errorCode}>{state.code}</Text>
          <Text style={styles.errorHint}>
            {ERROR_HINTS[state.code] ?? "请在桌面端确认服务状态后重试。"}
          </Text>
          <Pressable style={styles.retryButton} onPress={() => setState({ kind: "pair" })}>
            <Text style={styles.retryText}>重新配对</Text>
          </Pressable>
        </View>
      ) : null}

        {state.kind === "ready" ? (
          <TaskListScreen services={state.services} onDisconnect={handleDisconnect} />
        ) : null}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.background },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 10 },
  phaseText: { color: theme.foregroundSubtle, fontSize: 14 },
  errorTitle: { color: theme.foreground, fontSize: 17, fontWeight: "600" },
  errorCode: { color: theme.destructive, fontSize: 13 },
  errorHint: { color: theme.foregroundSubtle, fontSize: 13, textAlign: "center", lineHeight: 20 },
  retryButton: {
    marginTop: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  retryText: { color: theme.foreground, fontSize: 14 },
});
