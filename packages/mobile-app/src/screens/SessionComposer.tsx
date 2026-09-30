/* 会话输入区:输入框 + 底部图标工具条(与桌面 composer 同构)。
 *
 * 工具条五个入口(截图对照):
 *   plus 添加上下文(移动端暂不支持,点击给一次性提示)
 *   shield-alert 权限模式 · chart-donut 上下文用量 · cube 模型 · brain 思考级别(打开对应面板)
 * 右侧发送。展示与回调都在这里,选择语义(草稿/面板)由 SessionScreen 编排。
 *
 * 图标用 MaterialCommunityIcons(单色线性),不用彩色 emoji:彩色 emoji 在深色
 * 工具条里过亮、与主题脱节;@expo/vector-icons 只引这一个字体文件。
 */
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import type { ConfigPickerTarget } from "./ConfigPickerSheet";
import { theme } from "../theme";

const ICON_SIZE = 19;

export interface SessionComposerLabels {
  mode: string;
  model: string;
  thought: string;
}

export function SessionComposer({
  draft,
  onChangeDraft,
  placeholder,
  editable,
  sending,
  reconnecting,
  labels,
  hint,
  onHint,
  onOpenPicker,
  onSend,
  errorMessage,
  bottomInset,
}: {
  draft: string;
  onChangeDraft: (text: string) => void;
  placeholder: string;
  editable: boolean;
  sending: boolean;
  /** 连接断开重连中:禁用发送(等价于不可写)。 */
  reconnecting: boolean;
  labels: SessionComposerLabels;
  /** 一次性提示(如"添加上下文"在移动端不可用);输入或再次操作即清除。 */
  hint: string | null;
  onHint: (next: string | null) => void;
  onOpenPicker: (target: ConfigPickerTarget) => void;
  onSend: () => void;
  errorMessage?: string;
  /** 底部安全区(导航条)。 */
  bottomInset: number;
}) {
  const sendDisabled = draft.trim().length === 0 || sending || reconnecting;
  return (
    <View style={[styles.composer, { paddingBottom: 10 + bottomInset }]}>
      {errorMessage ? <Text style={styles.sendError}>{errorMessage}</Text> : null}
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      <TextInput
        style={styles.input}
        value={draft}
        onChangeText={(next) => {
          onChangeDraft(next);
          if (hint) onHint(null);
        }}
        placeholder={placeholder}
        placeholderTextColor={theme.foregroundSubtle}
        multiline
        editable={editable}
      />
      <View style={styles.toolbarRow}>
        <Pressable
          style={styles.toolbarButton}
          accessibilityRole="button"
          accessibilityLabel="添加上下文"
          hitSlop={6}
          onPress={() => onHint("移动端暂不支持添加上下文(请在桌面端 @ 文件或引用选区)")}
        >
          <MaterialCommunityIcons name="plus" size={ICON_SIZE} color={theme.foregroundSubtle} />
        </Pressable>
        <Pressable
          style={styles.toolbarButton}
          accessibilityRole="button"
          accessibilityLabel={`权限模式:${labels.mode}`}
          hitSlop={6}
          onPress={() => onOpenPicker("mode")}
        >
          <MaterialCommunityIcons
            name="shield-alert-outline"
            size={ICON_SIZE}
            color={theme.foregroundSubtle}
          />
        </Pressable>
        <Pressable
          style={styles.toolbarButton}
          accessibilityRole="button"
          accessibilityLabel="上下文用量"
          hitSlop={6}
          onPress={() => onOpenPicker("usage")}
        >
          <MaterialCommunityIcons
            name="chart-donut"
            size={ICON_SIZE}
            color={theme.foregroundSubtle}
          />
        </Pressable>
        <Pressable
          style={styles.toolbarButton}
          accessibilityRole="button"
          accessibilityLabel={`模型:${labels.model}`}
          hitSlop={6}
          onPress={() => onOpenPicker("model")}
        >
          <MaterialCommunityIcons name="cube-outline" size={ICON_SIZE} color={theme.foregroundSubtle} />
        </Pressable>
        <Pressable
          style={styles.toolbarButton}
          accessibilityRole="button"
          accessibilityLabel={`思考级别:${labels.thought}`}
          hitSlop={6}
          onPress={() => onOpenPicker("thought")}
        >
          <MaterialCommunityIcons name="brain" size={ICON_SIZE} color={theme.foregroundSubtle} />
        </Pressable>
        <Pressable
          style={[styles.sendButton, sendDisabled ? styles.sendButtonDisabled : null]}
          disabled={sendDisabled}
          onPress={onSend}
        >
          <Text style={styles.sendText}>{sending ? "发送中" : "发送"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  composer: {
    gap: 6,
    paddingHorizontal: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  input: {
    maxHeight: 120,
    minHeight: 38,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    backgroundColor: theme.panel,
    color: theme.foreground,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
  },
  toolbarRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  toolbarButton: {
    width: 36,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  sendButton: {
    borderRadius: 10,
    backgroundColor: theme.primary,
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginLeft: "auto",
  },
  sendButtonDisabled: { opacity: 0.4 },
  sendText: { color: theme.primaryForeground, fontSize: 14, fontWeight: "600" },
  hint: { color: theme.foregroundSubtle, fontSize: 11 },
  sendError: { color: theme.destructive, fontSize: 12 },
});
