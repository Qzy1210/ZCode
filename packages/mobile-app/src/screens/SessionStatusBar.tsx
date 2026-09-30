/* 会话状态条:计划进度 + 后台工作(可取消) + 排队消息(可立即发送/删除)。
 *
 * 纯展示组件:判定与文案都来自 interactionModel / runtimeActions,
 * 这里只负责把状态画出来并把用户动作回传(会话屏保持只做编排)。
 * 计划默认只显示「计划 N/M」摘要行(多步计划整列展示很占屏),点开看明细。
 */
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { summarizePlan } from "../conversation/interactionModel";
import {
  describeBackgroundWork,
  describeQueue,
  describeWorkflowRuns,
  selectCancellableWorks,
} from "../conversation/runtimeActions";
import type {
  ActionAvailability,
  BackgroundWorkSummary,
  PlanState,
  QueueState,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import { theme } from "../theme";

export function SessionStatusBar({
  plan,
  backgroundWorks,
  workflowRuns,
  queue,
  availability,
  disabled,
  errorMessage,
  onCancelWork,
  onPromote,
  onRemove,
}: {
  plan: PlanState | null;
  backgroundWorks: readonly BackgroundWorkSummary[];
  workflowRuns: readonly WorkflowRunState[];
  queue: QueueState | null;
  availability: { queueEdit?: ActionAvailability; sendQueuedNow?: ActionAvailability } | null;
  /** 重连中或命令在途:禁用写入。 */
  disabled: boolean;
  errorMessage?: string;
  onCancelWork: (workId: string) => void;
  onPromote: (queueItemId: string) => void;
  onRemove: (queueItemId: string) => void;
}) {
  // 计划明细默认收起:状态条是常驻层,整列计划项会把消息流压得太窄。
  // hook 必须在早退 return null 之前(内容出现/消失不能改变 hook 数量)。
  const [planExpanded, setPlanExpanded] = useState(false);
  const planProgress = summarizePlan(plan);
  const cancellableWorks = selectCancellableWorks(backgroundWorks);
  const workflowRows = describeWorkflowRuns(workflowRuns);
  const queueView = describeQueue(queue, availability);
  if (!planProgress && cancellableWorks.length === 0 && workflowRows.length === 0 && !queueView) {
    return null;
  }

  return (
    <View style={styles.card}>
      {planProgress ? (
        <>
          <Pressable
            style={styles.planHeader}
            accessibilityRole="button"
            accessibilityLabel={`${planExpanded ? "收起" : "展开"}计划明细`}
            onPress={() => setPlanExpanded((current) => !current)}
          >
            <Text style={styles.title}>
              计划 {planProgress.completed}/{planProgress.total}
              {planProgress.inProgress > 0 ? ` · ${planProgress.inProgress} 进行中` : ""}
            </Text>
            <Text style={styles.planChevron}>{planExpanded ? "收起 ▴" : "展开 ▾"}</Text>
          </Pressable>
          {planExpanded
            ? planProgress.items.map((item) => (
                <Text key={item.id} style={styles.planItem} numberOfLines={2}>
                  {item.status === "completed" ? "✓" : item.status === "inProgress" ? "▸" : "·"}{" "}
                  {item.content}
                </Text>
              ))
            : null}
        </>
      ) : null}

      {cancellableWorks.map((work) => (
        <View key={work.workId} style={styles.row}>
          <Text style={styles.label} numberOfLines={1}>
            {describeBackgroundWork(work)} · {work.title}
          </Text>
          <Pressable style={styles.action} disabled={disabled} onPress={() => onCancelWork(work.workId)}>
            <Text style={styles.actionText}>取消</Text>
          </Pressable>
        </View>
      ))}

      {workflowRows.map((run) => (
        <Text key={run.runId} style={styles.label} numberOfLines={1}>
          {run.label}
        </Text>
      ))}

      {queueView ? (
        <>
          <Text style={styles.title}>
            排队中 {queueView.items.length} 条
            {queueView.pausedHint ? ` · ${queueView.pausedHint}` : ""}
          </Text>
          {queueView.items.map((item) => (
            <View key={item.queueItemId} style={styles.row}>
              <Text style={styles.label} numberOfLines={1}>
                {item.preview}
              </Text>
              <View style={styles.actions}>
                {item.canPromote ? (
                  <Pressable
                    style={styles.action}
                    disabled={disabled}
                    onPress={() => onPromote(item.queueItemId)}
                  >
                    <Text style={styles.actionText}>立即发送</Text>
                  </Pressable>
                ) : null}
                {item.canDelete ? (
                  <Pressable
                    style={styles.action}
                    disabled={disabled}
                    onPress={() => onRemove(item.queueItemId)}
                  >
                    <Text style={styles.actionText}>删除</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ))}
        </>
      ) : null}

      {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
    backgroundColor: theme.panel,
  },
  title: { color: theme.foregroundSubtle, fontSize: 11, fontWeight: "600" },
  planHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  planChevron: { color: theme.info, fontSize: 11, marginLeft: "auto" },
  planItem: { color: theme.foreground, fontSize: 12, lineHeight: 17 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  label: { flex: 1, color: theme.foreground, fontSize: 12 },
  actions: { flexDirection: "row", gap: 6 },
  action: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  actionText: { color: theme.info, fontSize: 11 },
  error: { color: theme.destructive, fontSize: 11 },
});
