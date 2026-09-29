import { useEffect, useMemo, useSyncExternalStore } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { RemoteServiceAccess } from "@zcode/client";

import { createTaskStore, workspaceKeyOf, type TaskStoreSnapshot } from "../taskStore";
import { formatRelativeTime, taskStatusColor, theme } from "../theme";

type ListRow =
  | {
      kind: "workspace";
      key: string;
      title: string;
      path: string;
      kindLabel: string;
      taskCount: number;
    }
  | {
      kind: "task";
      key: string;
      title: string;
      status: string;
      updatedAt: number;
      /** 打开会话所需的三元组:与 controller 任务行 meta 一致(taskId === sessionId)。 */
      taskId: string;
      workspacePath: string;
      workspaceIdentity?: string;
    };

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
  reconnecting = false,
}: {
  services: RemoteServiceAccess;
  /** device = 免扫码长期凭证连接;pairing = 本次扫码建立。 */
  connectionMode: "pairing" | "device";
  /** 连接断开重连中:状态点转黄并如实提示。 */
  reconnecting?: boolean;
  onDisconnect: () => void;
  onForgetDevice: () => void;
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

  const rows = useMemo(() => {
    const result: ListRow[] = [];
    for (const workspace of snapshot.workspaces) {
      const key = workspaceKeyOf(workspace);
      const workspaceTasks = snapshot.tasks.filter((row) => workspaceKeyOf(row.meta) === key);
      const kindLabel = workspace.remoteSessionId
        ? "远程"
        : workspaceTasks.some((row) => row.meta.workspacePurpose === "conversation")
          ? "对话"
          : "本地";
      result.push({
        kind: "workspace",
        key: `workspace:${key}`,
        title: lastPathSegment(workspace.workspacePath),
        path: workspace.workspacePath,
        kindLabel,
        taskCount: workspaceTasks.length,
      });
      for (const task of workspaceTasks) {
        result.push({
          kind: "task",
          key: `task:${key}\0${task.meta.taskId}`,
          title: task.meta.title.trim() || "未命名任务",
          status: task.liveStatus,
          updatedAt: task.meta.updatedAt,
          taskId: task.meta.taskId,
          workspacePath: task.meta.workspacePath,
          ...(task.meta.workspaceIdentity ? { workspaceIdentity: task.meta.workspaceIdentity } : {}),
        });
      }
    }
    return result;
  }, [snapshot]);

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

      <FlatList
        data={rows}
        keyExtractor={(row) => row.key}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          snapshot.status === "ready" ? (
            <Text style={styles.emptyText}>当前桌面窗口没有可展示的工作区</Text>
          ) : null
        }
        renderItem={({ item }) =>
          item.kind === "workspace" ? (
            <View style={styles.workspaceHeader}>
              <View style={styles.workspaceTitleRow}>
                <Text style={styles.workspaceTitle} numberOfLines={1}>
                  {item.title}
                </Text>
                <View style={styles.kindBadge}>
                  <Text style={styles.kindBadgeText}>{item.kindLabel}</Text>
                </View>
                <Text style={styles.workspaceCount}>{item.taskCount} 个任务</Text>
              </View>
              <Text style={styles.workspacePath} numberOfLines={1}>
                {item.path}
              </Text>
            </View>
          ) : (
            <Pressable
              style={styles.taskRow}
              onPress={() =>
                onOpenTask({
                  taskId: item.taskId,
                  title: item.title,
                  workspacePath: item.workspacePath,
                  ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
                })
              }
            >
              <View
                style={[
                  styles.taskStatusDot,
                  { backgroundColor: taskStatusColor[item.status] ?? theme.foregroundSubtle },
                ]}
              />
              <View style={styles.taskBody}>
                <Text style={styles.taskTitle} numberOfLines={2}>
                  {item.title}
                </Text>
                <Text style={styles.taskMeta}>
                  {STATUS_LABEL[item.status] ?? item.status} · {formatRelativeTime(item.updatedAt)}
                </Text>
              </View>
            </Pressable>
          )
        }
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
  listContent: { paddingBottom: 32 },
  workspaceHeader: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
    gap: 2,
  },
  workspaceTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  workspaceTitle: { color: theme.foreground, fontSize: 15, fontWeight: "600", maxWidth: "60%" },
  kindBadge: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  kindBadgeText: { color: theme.foregroundSubtle, fontSize: 10 },
  workspaceCount: { color: theme.foregroundSubtle, fontSize: 11, marginLeft: "auto" },
  workspacePath: { color: theme.foregroundSubtle, fontSize: 11 },
  taskRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  taskStatusDot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  taskBody: { flex: 1, gap: 3 },
  taskTitle: { color: theme.foreground, fontSize: 14, lineHeight: 20 },
  taskMeta: { color: theme.foregroundSubtle, fontSize: 11 },
  emptyText: { color: theme.foregroundSubtle, fontSize: 13, textAlign: "center", paddingTop: 48 },
});
