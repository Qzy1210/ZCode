/* 模型/模式/思考级别/上下文用量弹层:只负责选,不负责发命令。
 *
 * 与桌面 composer 工具条同语义:
 * - 模型、权限模式、思考级别只写入草稿,随下一次发送提交(见 draftConfig.ts);
 * - 上下文用量是只读事实(snapshot.usage),这里只展示。
 */
import { useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  describeContextUsage,
  formatTokenCount,
  PERMISSION_MODE_OPTIONS,
  thoughtLevelLabel,
  type ContextUsageSummary,
  type DraftConfig,
  type ModelOption,
} from "../conversation/draftConfig";
import type { SessionUsageState } from "@zcode/shared/zcode-protocol-v4";
import { theme } from "../theme";

export type ConfigPickerTarget = "model" | "mode" | "thought" | "usage";

const SHEET_TITLES: Record<ConfigPickerTarget, string> = {
  model: "选择模型",
  mode: "权限与计划",
  thought: "思考级别",
  usage: "上下文用量",
};

export function ConfigPickerSheet({
  target,
  modelOptions,
  loadingModels,
  draft,
  thoughtLevels,
  currentThought,
  usage,
  onPickModel,
  onPickMode,
  onTogglePlan,
  onPickThought,
  onClose,
}: {
  target: ConfigPickerTarget | null;
  modelOptions: readonly ModelOption[];
  loadingModels: boolean;
  draft: DraftConfig;
  /** 当前模型可用的思考档位(provider 声明;空数组表示不支持)。 */
  thoughtLevels: readonly string[];
  /** 会话当前思考级别(草稿未选时的高亮基线)。 */
  currentThought?: string;
  /** 上下文用量事实(只读)。 */
  usage: SessionUsageState | null;
  onPickModel: (option: ModelOption) => void;
  onPickMode: (mode: DraftConfig["mode"]) => void;
  onTogglePlan: (enabled: boolean) => void;
  /** value=undefined 表示"跟随会话默认"(清除草稿级选择)。 */
  onPickThought: (value: string | undefined) => void;
  onClose: () => void;
}) {
  const [planLocal, setPlanLocal] = useState<boolean | undefined>(undefined);
  const planOn = planLocal ?? draft.planEnabled ?? false;
  // Modal 挂在窗口根上不吃 SafeAreaView 的 padding:底部弹层自己让出导航条。
  const insets = useSafeAreaInsets();
  const usageSummary: ContextUsageSummary | null = describeContextUsage(usage);

  return (
    <Modal visible={target !== null} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, { paddingBottom: 20 + insets.bottom }]} onPress={() => undefined}>
          <Text style={styles.sheetTitle}>{target ? SHEET_TITLES[target] : ""}</Text>
          {target === "model" ? (
            loadingModels ? (
              <Text style={styles.hint}>正在读取可用模型…</Text>
            ) : modelOptions.length === 0 ? (
              <Text style={styles.hint}>没有可用的模型配置</Text>
            ) : (
              <FlatList
                data={modelOptions}
                keyExtractor={(item) => `${item.providerId}/${item.modelId}`}
                style={styles.list}
                renderItem={({ item }) => {
                  const active =
                    draft.model?.providerId === item.providerId &&
                    draft.model.modelId === item.modelId;
                  return (
                    <Pressable
                      style={[styles.optionRow, active ? styles.optionRowActive : null]}
                      onPress={() => onPickModel(item)}
                    >
                      <View style={styles.optionBody}>
                        <Text style={styles.optionLabel}>
                          {item.group} · {item.label}
                        </Text>
                      </View>
                      {active ? <Text style={styles.check}>✓</Text> : null}
                    </Pressable>
                  );
                }}
              />
            )
          ) : target === "mode" ? (
            <View style={styles.list}>
              <Pressable
                style={[styles.optionRow, planOn ? styles.optionRowActive : null]}
                onPress={() => {
                  const next = !planOn;
                  setPlanLocal(next);
                  onTogglePlan(next);
                }}
              >
                <View style={styles.optionBody}>
                  <Text style={styles.optionLabel}>计划模式</Text>
                  <Text style={styles.optionDescription}>先给出计划,确认后再动手</Text>
                </View>
                {planOn ? <Text style={styles.check}>✓</Text> : null}
              </Pressable>
              {PERMISSION_MODE_OPTIONS.map((option) => {
                const active = draft.mode === option.value;
                return (
                  <Pressable
                    key={option.value}
                    style={[styles.optionRow, active ? styles.optionRowActive : null]}
                    onPress={() => onPickMode(option.value)}
                  >
                    <View style={styles.optionBody}>
                      <Text style={styles.optionLabel}>{option.label}</Text>
                      <Text style={styles.optionDescription}>{option.description}</Text>
                    </View>
                    {active ? <Text style={styles.check}>✓</Text> : null}
                  </Pressable>
                );
              })}
            </View>
          ) : target === "thought" ? (
            thoughtLevels.length === 0 ? (
              <Text style={styles.hint}>当前模型不支持思考级别</Text>
            ) : (
              <View style={styles.list}>
                {[
                  { value: undefined as string | undefined, label: "跟随会话默认", description: "不指定档位,由模型默认决定" },
                  ...thoughtLevels.map((value) => ({
                    value: value as string | undefined,
                    label: thoughtLevelLabel(value),
                    description: undefined,
                  })),
                ].map((option, index) => {
                  // 高亮:草稿选了就用草稿;没选则高亮"跟随会话默认"并标注会话当前档位。
                  const active =
                    draft.reasoningLevel === option.value ||
                    (draft.reasoningLevel === undefined && option.value === undefined);
                  const isDefaultRow = option.value === undefined;
                  return (
                    <Pressable
                      key={option.value ?? `default-${index}`}
                      style={[styles.optionRow, active ? styles.optionRowActive : null]}
                      onPress={() => onPickThought(option.value)}
                    >
                      <View style={styles.optionBody}>
                        <Text style={styles.optionLabel}>
                          {option.label}
                          {isDefaultRow && currentThought
                            ? `（当前:${thoughtLevelLabel(currentThought)}）`
                            : ""}
                        </Text>
                        {option.description ? (
                          <Text style={styles.optionDescription}>{option.description}</Text>
                        ) : null}
                      </View>
                      {active ? <Text style={styles.check}>✓</Text> : null}
                    </Pressable>
                  );
                })}
              </View>
            )
          ) : (
            <View style={styles.list}>
              {usageSummary ? (
                <>
                  <View style={styles.usageRow}>
                    <Text style={styles.usageLabel}>已用</Text>
                    <Text style={styles.usageValue}>
                      {formatTokenCount(usageSummary.usedTokens)} tokens
                    </Text>
                  </View>
                  <View style={styles.usageRow}>
                    <Text style={styles.usageLabel}>上限</Text>
                    <Text style={styles.usageValue}>
                      {formatTokenCount(usageSummary.maxTokens)} tokens
                    </Text>
                  </View>
                  <View style={styles.usageRow}>
                    <Text style={styles.usageLabel}>剩余</Text>
                    <Text style={styles.usageValue}>{usageSummary.remainingPercent}%</Text>
                  </View>
                  {usageSummary.tokensUntilAutoCompact !== null ? (
                    <View style={styles.usageRow}>
                      <Text style={styles.usageLabel}>距自动压缩</Text>
                      <Text style={styles.usageValue}>
                        {formatTokenCount(usageSummary.tokensUntilAutoCompact)} tokens
                      </Text>
                    </View>
                  ) : null}
                </>
              ) : (
                <Text style={styles.hint}>暂无上下文用量(会话开始后显示)</Text>
              )}
            </View>
          )}
          {/* 用量面板是只读事实,没有"下次发送生效"的语义。 */}
          {target === "usage" ? null : (
            <Text style={styles.footerHint}>选择在下次发送时生效(与桌面端一致)</Text>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" },
  sheet: {
    maxHeight: "70%",
    backgroundColor: theme.panel,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 20,
    gap: 10,
  },
  sheetTitle: { color: theme.primary, fontSize: 15, fontWeight: "600" },
  list: { flexGrow: 0 },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    backgroundColor: theme.card,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
  },
  optionRowActive: { borderColor: theme.info },
  optionBody: { flex: 1, gap: 2 },
  optionLabel: { color: theme.foreground, fontSize: 14 },
  optionDescription: { color: theme.foregroundSubtle, fontSize: 11 },
  check: { color: theme.info, fontSize: 14 },
  hint: { color: theme.foregroundSubtle, fontSize: 12, paddingVertical: 8 },
  usageRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    backgroundColor: theme.card,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  usageLabel: { color: theme.foregroundSubtle, fontSize: 12 },
  usageValue: { color: theme.foreground, fontSize: 13, fontWeight: "600" },
  footerHint: { color: theme.foregroundSubtle, fontSize: 11, textAlign: "center" },
});
