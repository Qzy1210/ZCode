/* 会话屏:历史消息 + 实时流式 + 发送输入。
 *
 * 设计取舍(与桌面 UI 的差异):
 * - 只渲染"手机上读得下去"的行:用户输入、助手正文、思考摘要、工具卡片、子代理、轮分隔;
 *   计划/审批/文件改动等富交互留给 P3,不在这里做半成品;
 * - 未接 markdown 渲染器,正文按纯文本展示(保留换行),避免为一种格式引入整棵依赖;
 * - 数据全部来自 conversationStore(单一所有者),本组件不解析帧。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
} from "react-native";
import type { RemoteServiceAccess } from "@zcode/client";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

import { createConversationStore, type ConversationView } from "../conversation/conversationStore";
import type { ConversationWorkspaceTarget } from "../conversation/conversationTransport";
import { formatRelativeTime, theme } from "../theme";
import { sessionStyles as styles } from "./sessionStyles";

const TOOL_STATUS_LABEL: Record<string, string> = {
  inputStreaming: "准备中",
  pendingApproval: "待确认",
  running: "运行中",
  success: "完成",
  error: "失败",
  cancelled: "已取消",
};

const SUBAGENT_STATUS_LABEL: Record<string, string> = {
  running: "进行中",
  success: "完成",
  failed: "失败",
  cancelled: "已取消",
};

const TOOL_STATUS_COLOR: Record<string, string> = {
  inputStreaming: theme.foregroundSubtle,
  pendingApproval: theme.warning,
  running: theme.info,
  success: theme.success,
  error: theme.destructive,
  cancelled: theme.foregroundSubtle,
};

const OUTPUT_PREVIEW_LINES = 4;
const OUTPUT_PREVIEW_CHARS = 400;

function truncateLines(text: string, maxLines: number, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  const lines = trimmed.split("\n");
  const clipped =
    lines.length > maxLines ? `${lines.slice(0, maxLines).join("\n")} …` : trimmed;
  return clipped.length > maxChars ? `${clipped.slice(0, maxChars)} …` : clipped;
}

function toolDetail(row: Extract<ConversationRow, { kind: "toolCall" }>): string {
  if (row.error) return `${row.error.code}: ${row.error.message}`;
  const output = row.output?.text ?? row.outputPreview?.text ?? "";
  const fromOutput = truncateLines(output, OUTPUT_PREVIEW_LINES, OUTPUT_PREVIEW_CHARS);
  if (fromOutput) return fromOutput;
  // 参数只在没有输出时展示:replayable 档下 input 是半截流,长参数会刷屏。
  return truncateLines(row.inputText, 2, 160);
}

export function SessionScreen({
  services,
  workspacePath,
  workspaceIdentity,
  sessionId,
  title,
  onBack,
}: {
  services: RemoteServiceAccess;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  title: string;
  onBack: () => void;
}) {
  // target 必须是稳定引用:store 依赖它建立订阅,每次渲染换对象会导致反复重订阅。
  const target = useMemo<ConversationWorkspaceTarget>(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    }),
    [workspacePath, workspaceIdentity],
  );
  const store = useMemo(
    () => createConversationStore({ services, target, sessionId }),
    [services, target, sessionId],
  );
  useEffect(() => () => store.dispose(), [store]);
  const view: ConversationView = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  const listRef = useRef<FlatList<ConversationRow>>(null);
  /** 用户是否停留在底部:决定流式增长时是否继续跟随。 */
  const stickToBottom = useRef(true);
  const [draft, setDraft] = useState("");

  const handleScroll = useCallback((event: { nativeEvent: NativeScrollEvent }) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromEnd = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    stickToBottom.current = distanceFromEnd < 80;
  }, []);

  const scrollToEnd = useCallback(() => {
    if (!stickToBottom.current) return;
    listRef.current?.scrollToEnd({ animated: false });
  }, []);

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (text.length === 0 || view.send.state === "sending") return;
    const result = await store.send(text);
    if (result.state === "idle") setDraft("");
  }, [draft, store, view.send.state]);

  const renderRow = useCallback(({ item }: { item: ConversationRow }) => {
    switch (item.kind) {
      case "userInput":
        return (
          <View style={[styles.row, styles.userRow]}>
            <Text style={styles.userLabel}>你</Text>
            <Text style={styles.userText}>{item.text}</Text>
          </View>
        );
      case "assistantText":
        return (
          <View style={styles.row}>
            <Text style={styles.assistantText}>
              {item.text}
              {item.state === "streaming" ? <Text style={styles.cursor}>▍</Text> : null}
            </Text>
            {item.state === "interrupted" || item.state === "failed" ? (
              <Text style={styles.rowHint}>
                {item.state === "interrupted" ? "已被中断" : "生成失败"}
              </Text>
            ) : null}
          </View>
        );
      case "reasoning":
        return (
          <View style={styles.row}>
            <Text style={styles.rowHint}>
              {item.state === "streaming"
                ? "思考中…"
                : `思考${item.durationMs ? ` · ${Math.round(item.durationMs / 1000)}s` : ""}`}
            </Text>
            {item.state !== "streaming" && item.text.trim().length > 0 ? (
              <Text style={styles.reasoningText}>
                {truncateLines(item.text, 3, 240)}
              </Text>
            ) : null}
          </View>
        );
      case "toolCall": {
        const detail = toolDetail(item);
        return (
          <View style={styles.toolCard}>
            <View style={styles.toolHeader}>
              <Text style={styles.toolName} numberOfLines={1}>
                {item.toolName}
              </Text>
              <Text
                style={[
                  styles.toolStatus,
                  { color: TOOL_STATUS_COLOR[item.status] ?? theme.foregroundSubtle },
                ]}
              >
                {TOOL_STATUS_LABEL[item.status] ?? item.status}
              </Text>
            </View>
            {detail ? (
              <Text style={item.error ? styles.toolError : styles.toolOutput} numberOfLines={6}>
                {detail}
              </Text>
            ) : null}
            {item.progress ? (
              <Text style={styles.rowHint}>
                {item.progress.bytes > 0 ? `${Math.round(item.progress.bytes / 1024)} KB` : ""}
                {item.progress.previewLine ? ` · ${item.progress.previewLine}` : ""}
              </Text>
            ) : null}
          </View>
        );
      }
      case "subagent":
        return (
          <View style={styles.row}>
            <Text style={styles.rowHint}>
              子代理 · {SUBAGENT_STATUS_LABEL[item.status] ?? item.status}
            </Text>
            {item.summaryText.trim().length > 0 ? (
              <Text style={styles.toolOutput}>{truncateLines(item.summaryText, 3, 240)}</Text>
            ) : null}
          </View>
        );
      case "turnHeader":
        return (
          <View style={styles.turnDivider}>
            <Text style={styles.turnText}>
              {new Date(item.createdAt).toLocaleTimeString()} ·{" "}
              {item.origin === "userInput" ? "本轮" : item.origin}
            </Text>
          </View>
        );
      case "timelineMarker":
        return (
          <View style={styles.turnDivider}>
            <Text style={styles.turnText}>{item.marker.type}</Text>
          </View>
        );
      case "artifact":
        return (
          <View style={styles.toolCard}>
            <Text style={styles.toolName} numberOfLines={1}>
              产物 · {item.artifactType}
            </Text>
            <Text style={styles.toolOutput} numberOfLines={1}>
              {item.displayName}
            </Text>
          </View>
        );
      case "hookInvocation":
        return (
          <View style={styles.row}>
            <Text style={styles.rowHint}>
              Hook · {item.hookEventName}
              {item.hookCount > 1 ? ` ×${item.hookCount}` : ""}
            </Text>
          </View>
        );
      default:
        return null;
    }
  }, []);

  const statusLine = view.error
    ? `同步异常：${view.error.message}`
    : view.status === "loading"
      ? "正在加载会话…"
      : view.streaming
        ? "生成中…"
        : `共 ${view.rows.length} 行 · 最后更新 ${view.rows.length > 0 ? formatRelativeTime(view.rows[view.rows.length - 1]!.createdAt) : "—"}`;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <Pressable style={styles.backButton} onPress={onBack}>
          <Text style={styles.backText}>‹ 返回</Text>
        </Pressable>
        <View style={styles.headerBody}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <Text
            style={[styles.statusText, view.status === "error" ? styles.statusError : null]}
            numberOfLines={1}
          >
            {statusLine}
          </Text>
        </View>
        {view.status === "error" ? (
          <Pressable style={styles.retryButton} onPress={() => void store.retry()}>
            <Text style={styles.retryText}>重试</Text>
          </Pressable>
        ) : null}
      </View>

      <FlatList
        ref={listRef}
        data={view.rows}
        keyExtractor={(row) => String(row.rowId)}
        renderItem={renderRow}
        contentContainerStyle={styles.listContent}
        onScroll={handleScroll}
        onContentSizeChange={() => {
          if (stickToBottom.current) scrollToEnd();
        }}
        ListHeaderComponent={
          view.rows.length > 0 && !view.atTop ? (
            <Pressable
              style={styles.loadOlder}
              disabled={view.loadingOlder}
              onPress={() => void store.loadOlder()}
            >
              <Text style={styles.loadOlderText}>
                {view.loadingOlder ? "加载中…" : "加载更早的消息"}
              </Text>
            </Pressable>
          ) : null
        }
        ListEmptyComponent={
          view.status === "loading" ? (
            <Text style={styles.emptyText}>正在加载会话…</Text>
          ) : (
            <Text style={styles.emptyText}>这个任务还没有消息</Text>
          )
        }
      />

      {view.send.state === "rejected" ? (
        <Text style={styles.sendError}>{view.send.message ?? "发送失败"}</Text>
      ) : null}
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="输入消息…"
          placeholderTextColor={theme.foregroundSubtle}
          multiline
          editable={view.status !== "error"}
        />
        <Pressable
          style={[
            styles.sendButton,
            draft.trim().length === 0 || view.send.state === "sending" ? styles.sendButtonDisabled : null,
          ]}
          disabled={draft.trim().length === 0 || view.send.state === "sending"}
          onPress={() => void handleSend()}
        >
          <Text style={styles.sendText}>{view.send.state === "sending" ? "发送中" : "发送"}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
