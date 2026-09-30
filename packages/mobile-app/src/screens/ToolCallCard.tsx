/* 工具卡片:折叠态一行摘要 + (可选)第二行,点开看正文。
 *
 * 内容全部来自 toolCardModel 的纯函数判定;这里只管渲染与本地展开状态。
 * diff 不引入渲染库:内容已带 `+`/`-`/空格 前缀,按前缀上色即可。
 */
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";

import { buildToolCardModel } from "../conversation/toolCardModel";
import { theme } from "../theme";

const TOOL_STATUS_LABEL: Record<string, string> = {
  inputStreaming: "准备中",
  pendingApproval: "待确认",
  running: "运行中",
  success: "完成",
  error: "失败",
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

function diffLineStyle(line: string): { color: string } {
  if (line.startsWith("+")) return { color: theme.success };
  if (line.startsWith("-")) return { color: theme.destructive };
  if (line.startsWith("@@")) return { color: theme.info };
  return { color: theme.foregroundSubtle };
}

export function ToolCallCard({ row }: { row: ToolCallRow }) {
  const [expanded, setExpanded] = useState(false);
  const model = buildToolCardModel(row);
  const statusLabel = TOOL_STATUS_LABEL[row.status] ?? row.status;

  return (
    <View style={styles.card}>
      <Pressable
        style={styles.header}
        disabled={!model.expandable}
        onPress={() => setExpanded((current) => !current)}
      >
        <Text style={styles.toolName} numberOfLines={1}>
          {row.toolName}
        </Text>
        {model.expandable ? (
          <Text style={styles.toggle}>{expanded ? "收起" : "展开"}</Text>
        ) : null}
        <Text
          style={[styles.status, { color: TOOL_STATUS_COLOR[row.status] ?? theme.foregroundSubtle }]}
        >
          {statusLabel}
        </Text>
      </Pressable>

      <Text style={styles.summary} numberOfLines={2}>
        {model.summary}
      </Text>
      {model.detail ? (
        <Text style={styles.detail} numberOfLines={2}>
          {model.detail}
        </Text>
      ) : null}

      {model.errorText ? <Text style={styles.error}>{model.errorText}</Text> : null}

      {expanded && model.body ? (
        model.bodyKind === "diff" ? (
          <View style={styles.body}>
            {model.body.split("\n").map((line, index) => (
              <Text key={index} style={[styles.diffLine, diffLineStyle(line)]}>
                {line.length > 0 ? line : " "}
              </Text>
            ))}
          </View>
        ) : (
          <Text style={styles.bodyText} numberOfLines={60}>
            {model.body}
          </Text>
        )
      ) : null}

      {expanded && model.truncatedNote ? (
        <Text style={styles.truncated}>{model.truncatedNote}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: 10,
    backgroundColor: theme.panel,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 4,
  },
  header: { flexDirection: "row", alignItems: "center", gap: 8 },
  toolName: { color: theme.foreground, fontSize: 12, fontWeight: "600", flexShrink: 1 },
  toggle: { color: theme.info, fontSize: 11 },
  status: { fontSize: 11, marginLeft: "auto" },
  summary: { color: theme.foreground, fontSize: 12, lineHeight: 17 },
  detail: { color: theme.foregroundSubtle, fontSize: 11, lineHeight: 16 },
  error: { color: theme.destructive, fontSize: 11, lineHeight: 16 },
  body: {
    borderRadius: 8,
    backgroundColor: theme.card,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  diffLine: { fontFamily: "monospace", fontSize: 11, lineHeight: 15 },
  bodyText: { color: theme.foregroundSubtle, fontSize: 11, lineHeight: 16 },
  truncated: { color: theme.warning, fontSize: 10 },
});
