/* 任务列表:项目卡片 + 任务行。
 *
 * 展示规则(对齐移动端设计稿):
 * - 每个项目是一张卡片:文件夹图标 + 名称 + 类型徽标 / 路径 / 「更新于 X」+「N 个任务 ▾」+「＋」;
 * - 任务行在卡片内,缩进一级:标题 + 相对时间在左,状态徽标右对齐;
 * - 点项目行折叠/展开任务(折叠是纯本地 UI 状态,不碰订阅)。
 *
 * 数据全部来自 taskStore(单一所有者);本组件只做派生与渲染。
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { RemoteServiceAccess } from "@zcode/client";

import { createTaskStore, workspaceKeyOf, type TaskStoreSnapshot } from "../taskStore";
import { formatRelativeTime, taskStatusColor, theme } from "../theme";

/** 列表项:一个项目及其任务(taskId === sessionId)。 */
interface WorkspaceCard {
  key: string;
  /** workspaceKeyOf 的原始结果:折叠集合的 key。 */
  workspaceKey: string;
  title: string;
  path: string;
  kindLabel: string;
  /** 该项目下最近一次任务更新时间(无任务时为空,不显示"更新于")。 */
  updatedAt: number | null;
  workspacePath: string;
  workspaceIdentity?: string;
  tasks: Array<{
    taskId: string;
    title: string;
    status: string;
    updatedAt: number;
  }>;
}

const STATUS_LABEL: Record<string, string> = {
  running: "运行中",
  waiting: "等待中",
  completed: "已完成",
  error: "出错",
  idle: "空闲",
};

function lastPathSegment(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

export function TaskListScreen({
  services,
  connectionMode,
  onDisconnect,
  onForgetDevice,
  onOpenTask,
  onCreateTask,
  createTaskError = null,
  reconnecting = false,
}: {
  services: RemoteServiceAccess;
  /** device = 免扫码长期凭证连接;pairing = 本次扫码建立。 */
  connectionMode: "pairing" | "device";
  /** 连接断开重连中:状态点转黄并如实提示。 */
  reconnecting?: boolean;
  onDisconnect: () => void;
  onForgetDevice: () => void;
  /** 新建任务:由 App 发 createSession 并进入会话屏(草稿会话,首条消息后才落库)。 */
  onCreateTask?: (target: { workspacePath: string; workspaceIdentity?: string }) => void;
  /** 新建任务失败原因。 */
  createTaskError?: string | null;
  /** 打开任务会话:由 App 切换到会话屏(P2)。 */
  onOpenTask: (target: {
    taskId: string;
    title: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => void;
}) {
  const store = useMemo(() => createTaskStore(services), [services]);
  useEffect(() => () => store.dispose(), [store]);
  const snapshot: TaskStoreSnapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  /**
   * 折叠的项目 key(workspaceKeyOf 的结果):默认全部展开。
   * key 失效(项目消失)时条目自动无害化。
   */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleWorkspace = (key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const cards = useMemo(() => {
    const result: WorkspaceCard[] = [];
    for (const workspace of snapshot.workspaces) {
      const key = workspaceKeyOf(workspace);
      const workspaceTasks = snapshot.tasks.filter((row) => workspaceKeyOf(row.meta) === key);
      const kindLabel = workspace.remoteSessionId
        ? "远程"
        : workspaceTasks.some((row) => row.meta.workspacePurpose === "conversation")
          ? "对话"
          : "本地";
      result.push({
        key: `workspace:${key}`,
        workspaceKey: key,
        title: lastPathSegment(workspace.workspacePath),
        path: workspace.workspacePath,
        kindLabel,
        updatedAt:
          workspaceTasks.length > 0
            ? Math.max(...workspaceTasks.map((row) => row.meta.updatedAt))
            : null,
        workspacePath: workspace.workspacePath,
        ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
        tasks: workspaceTasks.map((task) => ({
          taskId: task.meta.taskId,
          title: task.meta.title.trim() || "未命名任务",
          status: task.liveStatus,
          updatedAt: task.meta.updatedAt,
        })),
      });
    }
    return result;
  }, [snapshot]);

  const renderTaskRow = (card: WorkspaceCard, task: WorkspaceCard["tasks"][number]) => (
    <Pressable
      key={task.taskId}
      style={styles.taskRow}
      accessibilityRole="button"
      onPress={() =>
        onOpenTask({
          taskId: task.taskId,
          title: task.title,
          workspacePath: card.workspacePath,
          ...(card.workspaceIdentity ? { workspaceIdentity: card.workspaceIdentity } : {}),
        })
      }
    >
      <View style={styles.taskBody}>
        <Text style={styles.taskTitle} numberOfLines={2}>
          {task.title}
        </Text>
        <Text style={styles.taskTime}>{formatRelativeTime(task.updatedAt)}</Text>
      </View>
      <Text
        style={[styles.taskStatus, { color: taskStatusColor[task.status] ?? theme.foregroundSubtle }]}
      >
        {STATUS_LABEL[task.status] ?? task.status}
      </Text>
    </Pressable>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.title}>ZCode</Text>
          <View style={styles.statusRow}>
            <View
              style={[
                styles.statusDot,
                {
                  backgroundColor:
                    reconnecting || snapshot.status !== "ready" ? theme.warning : theme.success,
                },
              ]}
            />
            <Text style={styles.statusText}>
              {reconnecting
                ? "连接已断开，正在重连…"
                : snapshot.status === "ready"
                  ? `已连接${connectionMode === "device" ? "(免扫码)" : ""} · ${snapshot.workspaces.length} 个工作区 · ${snapshot.tasks.length} 个任务`
                  : snapshot.status === "loading"
                    ? "正在同步项目与任务…"
                    : "同步失败"}
            </Text>
          </View>
        </View>
        <View style={styles.headerActions}>
          {connectionMode === "device" ? (
            <Pressable style={styles.disconnectButton} onPress={onForgetDevice}>
              <Text style={styles.disconnectText}>忘记设备</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.disconnectButton} onPress={onDisconnect}>
            <Text style={styles.disconnectText}>断开</Text>
          </Pressable>
        </View>
      </View>

      {createTaskError ? (
        <Text style={styles.createTaskError}>新建任务失败：{createTaskError}</Text>
      ) : null}
      <FlatList
        data={cards}
        keyExtractor={(card) => card.key}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          snapshot.status === "ready" ? (
            <Text style={styles.emptyText}>当前桌面窗口没有可展示的工作区</Text>
          ) : snapshot.status === "error" ? (
            // 订阅超时/失败时必须给出出口,否则用户只能杀进程(此前就是如此)。
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>同步失败,可能是连接已断开</Text>
              <Pressable style={styles.retryButton} onPress={() => store.retry()}>
                <Text style={styles.retryText}>重试</Text>
              </Pressable>
            </View>
          ) : null
        }
        renderItem={({ item: card }) => {
          const isCollapsed = collapsed.has(card.workspaceKey);
          return (
            <View style={styles.workspaceCard}>
              <Pressable
                style={styles.workspaceRow}
                accessibilityRole="button"
                accessibilityLabel={`${card.title},${isCollapsed ? "展开" : "收起"}任务`}
                onPress={() => toggleWorkspace(card.workspaceKey)}
              >
                <MaterialCommunityIcons
                  name="folder-outline"
                  size={19}
                  color={theme.foregroundSubtle}
                  style={styles.folderIcon}
                />
                <View style={styles.workspaceBody}>
                  <View style={styles.workspaceTitleRow}>
                    <Text style={styles.workspaceTitle} numberOfLines={1}>
                      {card.title}
                    </Text>
                    <View style={styles.kindBadge}>
                      <Text style={styles.kindBadgeText}>{card.kindLabel}</Text>
                    </View>
                  </View>
                  <Text style={styles.workspacePath} numberOfLines={1}>
                    {card.path}
                  </Text>
                  <View style={styles.workspaceMetaRow}>
                    {card.updatedAt !== null ? (
                      <Text style={styles.workspaceUpdated}>
                        更新于 {formatRelativeTime(card.updatedAt)}
                      </Text>
                    ) : null}
                    <Text style={styles.workspaceCount}>
                      {card.tasks.length} 个任务 {isCollapsed ? "▸" : "▾"}
                    </Text>
                  </View>
                </View>
                {onCreateTask && !reconnecting ? (
                  <Pressable
                    style={styles.createTaskButton}
                    accessibilityRole="button"
                    accessibilityLabel={`在 ${card.title} 新建任务`}
                    hitSlop={8}
                    onPress={() =>
                      onCreateTask({
                        workspacePath: card.workspacePath,
                        ...(card.workspaceIdentity
                          ? { workspaceIdentity: card.workspaceIdentity }
                          : {}),
                      })
                    }
                  >
                    <Text style={styles.createTaskText}>＋</Text>
                  </Pressable>
                ) : null}
              </Pressable>
              {!isCollapsed && card.tasks.length > 0 ? (
                <View style={styles.taskGroup}>
                  {card.tasks.map((task) => renderTaskRow(card, task))}
                </View>
              ) : null}
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  headerLeft: { flex: 1, gap: 4 },
  title: { color: theme.primary, fontSize: 20, fontWeight: "600" },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { color: theme.foregroundSubtle, fontSize: 12 },
  headerActions: { flexDirection: "row", gap: 8 },
  disconnectButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  disconnectText: { color: theme.foregroundSubtle, fontSize: 13 },
  listContent: { paddingHorizontal: 10, paddingTop: 10, paddingBottom: 32, gap: 10 },
  /** 项目卡片:头部 + 任务行同一张卡,靠边界表达层级。 */
  workspaceCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: 12,
    backgroundColor: theme.card,
    overflow: "hidden",
  },
  workspaceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  folderIcon: { marginTop: 1 },
  workspaceBody: { flex: 1, gap: 2 },
  workspaceTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  workspaceTitle: { color: theme.foreground, fontSize: 15, fontWeight: "600", flexShrink: 1 },
  kindBadge: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  kindBadgeText: { color: theme.foregroundSubtle, fontSize: 10 },
  workspacePath: { color: theme.foregroundSubtle, fontSize: 11 },
  workspaceMetaRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  workspaceUpdated: { color: theme.foregroundSubtle, fontSize: 11 },
  workspaceCount: { color: theme.foregroundSubtle, fontSize: 11, marginLeft: "auto" },
  createTaskButton: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  createTaskText: { color: theme.info, fontSize: 15, lineHeight: 18 },
  createTaskError: {
    color: theme.destructive,
    fontSize: 12,
    paddingHorizontal: 16,
    paddingBottom: 6,
  },
  /** 任务行:缩进一级;标题/时间在左,状态徽标右对齐。 */
  taskGroup: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
    paddingVertical: 2,
  },
  taskRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingLeft: 40,
    paddingRight: 12,
    paddingVertical: 9,
  },
  taskBody: { flex: 1, gap: 3 },
  taskTitle: { color: theme.foreground, fontSize: 14, lineHeight: 20 },
  taskTime: { color: theme.foregroundSubtle, fontSize: 11 },
  taskStatus: { fontSize: 11 },
  emptyText: { color: theme.foregroundSubtle, fontSize: 13, textAlign: "center", paddingTop: 48 },
  errorBox: { alignItems: "center", gap: 12, paddingTop: 48, paddingHorizontal: 24 },
  errorText: { color: theme.destructive, fontSize: 13, textAlign: "center" },
  retryButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  retryText: { color: theme.foreground, fontSize: 13 },
});
