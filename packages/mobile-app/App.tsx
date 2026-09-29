/* ZCode 手机 App 根组件:只做渲染与导航,连接生命周期交给 connectionRuntime。
 *
 * - 渲染分支:启动中 / 扫码配对 / 连接中 / 错误 / 就绪;
 * - 就绪时按会话栈渲染任务列表或会话屏;子代理下钻在栈上叠加;
 * - 连接代际(generation)作为屏幕 key:重连成功后屏幕重建,订阅与快照自动刷新;
 * - 断线重连期间保留最后画面,顶部显示横条并禁用写入类操作。
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AppState as RNAppState, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import { createConnectionRuntime } from "./src/connectionRuntime";
import type { PairingQrPayload } from "./src/pairingQr";
import { PairScreen } from "./src/screens/PairScreen";
import { SessionScreen } from "./src/screens/SessionScreen";
import { TaskListScreen } from "./src/screens/TaskListScreen";
import { theme } from "./src/theme";

/** 与 web 端 MobileRemotePage 的错误指引保持一致,并补充设备凭证与重连相关码。 */
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
  connection_superseded: "连接已在另一台手机上接管，本机已断开。如需继续使用，请重新扫码配对。",
  manual_stop: "已停止自动重连，可点重试重新连接。",
};

/** 会话屏打开目标:任务行三元组(taskId === sessionId)。 */
interface OpenTaskTarget {
  taskId: string;
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export default function App() {
  const runtime = useMemo(
    // 只在前台探活:后台不做无谓 RPC,既省电也避免系统回收时的假断线。
    () => createConnectionRuntime({ isAppActive: () => RNAppState.currentState === "active" }),
    [],
  );
  useEffect(() => {
    runtime.start();
    return () => runtime.dispose();
  }, [runtime]);
  const state = useSyncExternalStore(runtime.subscribe, runtime.getState, runtime.getState);

  /**
   * 已打开的会话栈(末位为当前屏):任务列表 → 会话 → 子代理会话……
   * 用栈而不是单个会话,是因为子代理下钻要能逐层返回,且共用同一条连接。
   */
  const [sessionStack, setSessionStack] = useState<OpenTaskTarget[]>([]);
  const openTask = sessionStack[sessionStack.length - 1] ?? null;

  useEffect(() => {
    // 连接不可用时退回列表(会话订阅依赖连接,留着只会空转);
    // 断线重连(generation 变化)不走这里——那时 state 仍是 ready,栈要保留。
    if (state.kind !== "ready") setSessionStack([]);
  }, [state.kind]);

  const handlePaired = (qr: PairingQrPayload) => {
    void runtime.connectWithQr(qr);
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
        <StatusBar style="light" />
        {state.kind === "idle" ? (
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
              <Pressable style={styles.retryButton} onPress={() => void runtime.forgetDevice()}>
                <Text style={styles.retryText}>改用扫码配对</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {state.kind === "error" ? (
          <View style={styles.center}>
            <Text style={styles.errorTitle}>无法连接桌面</Text>
            <Text style={styles.errorCode}>{state.code}</Text>
            <Text style={styles.errorHint}>{ERROR_HINTS[state.code] ?? "请重新扫码配对后再试。"}</Text>
            <View style={styles.errorActions}>
              {state.canRetryAuto ? (
                <Pressable style={styles.retryButton} onPress={() => runtime.retryFromError()}>
                  <Text style={styles.retryText}>重试</Text>
                </Pressable>
              ) : null}
              <Pressable style={styles.retryButton} onPress={() => void runtime.forgetDevice()}>
                <Text style={styles.retryText}>重新扫码配对</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {state.kind === "ready" ? (
          <>
            {state.banner ? (
              <View style={styles.banner}>
                <Text style={styles.bannerText} numberOfLines={2}>
                  {state.banner.message}
                </Text>
                <Pressable
                  style={styles.bannerAction}
                  onPress={() => void runtime.forgetDevice()}
                >
                  <Text style={styles.bannerActionText}>重新扫码</Text>
                </Pressable>
                <Pressable style={styles.bannerAction} onPress={() => runtime.stopReconnect()}>
                  <Text style={styles.bannerActionText}>停止重连</Text>
                </Pressable>
              </View>
            ) : null}
            {openTask ? (
              <SessionScreen
                // 连接代际入 key:重连成功后重建 store 与订阅,内容自动跟上。
                key={`${openTask.taskId}#${state.generation}`}
                services={state.services}
                workspacePath={openTask.workspacePath}
                {...(openTask.workspaceIdentity
                  ? { workspaceIdentity: openTask.workspaceIdentity }
                  : {})}
                sessionId={openTask.taskId}
                title={openTask.title}
                reconnecting={state.banner !== null}
                onBack={() => setSessionStack((stack) => stack.slice(0, -1))}
                onOpenSession={({ sessionId, title }) =>
                  setSessionStack((stack) => [
                    ...stack,
                    {
                      taskId: sessionId,
                      title,
                      workspacePath: openTask.workspacePath,
                      ...(openTask.workspaceIdentity
                        ? { workspaceIdentity: openTask.workspaceIdentity }
                        : {}),
                    },
                  ])
                }
              />
            ) : (
              <TaskListScreen
                key={`tasks#${state.generation}`}
                services={state.services}
                connectionMode={state.mode}
                reconnecting={state.banner !== null}
                onOpenTask={(target) => setSessionStack([target])}
                onDisconnect={() => runtime.disconnect()}
                onForgetDevice={() => void runtime.forgetDevice()}
              />
            )}
          </>
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
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: "rgba(245, 158, 11, 0.14)",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.warning,
  },
  bannerText: { flex: 1, color: theme.warning, fontSize: 12 },
  bannerAction: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.warning,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  bannerActionText: { color: theme.warning, fontSize: 12, fontWeight: "600" },
});
