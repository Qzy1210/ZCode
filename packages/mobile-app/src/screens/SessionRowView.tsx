/* 单行渲染:会话屏与"过程折叠块"共用;不持有订阅(数据由 store 提供)。
 * 从 SessionScreen 抽出,既控制单文件行数,也保证折叠块内用的是同一套渲染。
 */
import { Pressable, Text, View } from "react-native";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

import { sessionStyles as styles } from "./sessionStyles";
import { describeAttachments } from "../conversation/runtimeActions";
import { MarkdownText } from "./MarkdownText";
import { ToolCallCard } from "./ToolCallCard";

/** 摘要行截断(工具卡片有自己的模型,这里服务于思考/子代理等轻量行)。 */
function truncateLines(text: string, maxLines: number, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  const lines = trimmed.split("\n");
  const clipped = lines.length > maxLines ? `${lines.slice(0, maxLines).join("\n")} …` : trimmed;
  return clipped.length > maxChars ? `${clipped.slice(0, maxChars)} …` : clipped;
}

const SUBAGENT_STATUS_LABEL: Record<string, string> = {
  running: "进行中",
  success: "完成",
  failed: "失败",
  cancelled: "已取消",
};

export function SessionRowView({
  row,
  onOpenSession,
}: {
  row: ConversationRow;
  onOpenSession?: (target: { sessionId: string; title: string }) => void;
}) {

  switch (row.kind) {
    case "userInput": {
      // 附件只做只读摘要:手机端不取字节(预览与分享仍由桌面负责)。
      const attachments = describeAttachments(row.attachments);
      return (
        <View style={[styles.row, styles.userRow]}>
          <Text style={styles.userLabel}>你</Text>
          <Text style={styles.userText}>{row.text}</Text>
          {attachments ? <Text style={styles.attachmentText}>{attachments}</Text> : null}
        </View>
      );
    }
    case "assistantText":
      return (
        <View style={styles.row}>
          <MarkdownText text={row.text} streaming={row.state === "streaming"} />
          {row.state === "interrupted" || row.state === "failed" ? (
            <Text style={styles.rowHint}>
              {row.state === "interrupted" ? "已被中断" : "生成失败"}
            </Text>
          ) : null}
        </View>
      );
    case "reasoning":
      return (
        <View style={styles.row}>
          <Text style={styles.rowHint}>
            {row.state === "streaming"
              ? "思考中…"
              : `思考${row.durationMs ? ` · ${Math.round(row.durationMs / 1000)}s` : ""}`}
          </Text>
          {row.state !== "streaming" && row.text.trim().length > 0 ? (
            <Text style={styles.reasoningText}>
              {truncateLines(row.text, 3, 240)}
            </Text>
          ) : null}
        </View>
      );
    case "toolCall":
      return <ToolCallCard row={row} />;
    case "subagent": {
      const childSessionId = row.childSessionId;
      const canDrill = Boolean(childSessionId && onOpenSession);
      const content = (
        <View style={styles.row}>
          <Text style={styles.rowHint}>
            子代理 · {SUBAGENT_STATUS_LABEL[row.status] ?? row.status}
            {canDrill ? " · 点开查看" : ""}
          </Text>
          {row.summaryText.trim().length > 0 ? (
            <Text style={styles.toolOutput}>{truncateLines(row.summaryText, 3, 240)}</Text>
          ) : null}
        </View>
      );
      // childSessionId 存在即可下钻:与桌面一致,子会话是独立订阅,不内嵌 child rows。
      return canDrill ? (
        <Pressable
          onPress={() =>
            onOpenSession?.({ sessionId: childSessionId!, title: `${row.subagentType} 子会话` })
          }
        >
          {content}
        </Pressable>
      ) : (
        content
      );
    }
    case "turnHeader":
      return (
        <View style={styles.turnDivider}>
          <Text style={styles.turnText}>
            {new Date(row.createdAt).toLocaleTimeString()} ·{" "}
            {row.origin === "userInput" ? "本轮" : row.origin}
          </Text>
        </View>
      );
    case "timelineMarker":
      return (
        <View style={styles.turnDivider}>
          <Text style={styles.turnText}>{row.marker.type}</Text>
        </View>
      );
    case "artifact":
      return (
        <View style={styles.toolCard}>
          <Text style={styles.toolName} numberOfLines={1}>
            产物 · {row.artifactType}
          </Text>
          <Text style={styles.toolOutput} numberOfLines={1}>
            {row.displayName}
          </Text>
        </View>
      );
    case "hookInvocation":
      return (
        <View style={styles.row}>
          <Text style={styles.rowHint}>
            Hook · {row.hookEventName}
            {row.hookCount > 1 ? ` ×${row.hookCount}` : ""}
          </Text>
        </View>
      );
    default:
      return null;
  }

}
