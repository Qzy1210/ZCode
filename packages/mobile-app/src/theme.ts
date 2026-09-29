/**
 * 对齐 web 端 `theme-zai-dark` 的设计 token,保证两端视觉语言一致。
 * 取值来源:packages/ui/src/styles.css 的 .theme-zai-dark 变量。
 */
export const theme = {
  background: "#161616",
  panel: "#202020",
  card: "#2b2b2b",
  border: "rgba(255, 255, 255, 0.10)",
  hover: "rgba(255, 255, 255, 0.05)",
  selected: "rgba(255, 255, 255, 0.10)",
  foreground: "#d4d4d4",
  foregroundSubtle: "#8f8f8f",
  primary: "#ffffff",
  primaryForeground: "#000000",
  success: "#46bf72",
  destructive: "#ff5c5c",
  warning: "#f59e0b",
  info: "#38bdf8",
} as const;

/** 任务状态点颜色(与 web 移动页的语义一致)。 */
export const taskStatusColor: Record<string, string> = {
  running: theme.info,
  waiting: theme.warning,
  completed: theme.success,
  error: theme.destructive,
  idle: "#6b6b6b",
};

export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(timestamp).toLocaleDateString();
}
