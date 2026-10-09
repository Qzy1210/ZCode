/* 会话时间线的底部锚定(纯函数,与桌面 packages/ui/src/v4/timelineScrollAnchor.ts 同语义)。
 *
 * 为什么需要它:进入会话必须默认停在最新内容;而"跟随"表达的是**用户的滚动权**,
 * 不是瞬时几何快照——程序化贴底、列表测高补偿同样会派发 onScroll,若把它们当成
 * 用户上滚,跟随态会被自己打掉,表现为"进入会话停在中间、要往下翻好久"。
 *
 * 规则:
 * - 落点在底部 ⇔ 跟随;只有**真实用户滚动输入**可以改变跟随态;
 * - 在底部时,追加与流式增长(含行内文本变高)都贴底;
 * - 前插历史(加载更早)不贴底,不把正在看历史的用户拽回底部;
 * - 用户上滚离底 → 解除跟随并显示「跳到最新」按钮;点按钮或滚回底部 → 恢复。
 */

/** 离底判定容差:覆盖亚像素滚动与最后一行 padding。与桌面取值一致。 */
export const BOTTOM_ANCHOR_EPSILON_PX = 48;

/** 滚动几何:RN onScroll 的 contentOffset.y / contentSize.height / layoutMeasurement.height。 */
export interface ScrollGeometry {
  offsetY: number;
  contentHeight: number;
  viewportHeight: number;
}

/** 距底部的剩余可滚动距离(内容不足一屏时为 0)。 */
export function distanceToBottom(geometry: ScrollGeometry): number {
  return Math.max(0, geometry.contentHeight - geometry.viewportHeight - geometry.offsetY);
}

export function isAtBottom(
  geometry: ScrollGeometry,
  epsilonPx: number = BOTTOM_ANCHOR_EPSILON_PX,
): boolean {
  return distanceToBottom(geometry) <= epsilonPx;
}

/** 用户真实滚动之后的跟随态:落点在底部 ⇔ 跟随。 */
export function resolveFollowingAfterUserScroll(
  geometry: ScrollGeometry,
  epsilonPx: number = BOTTOM_ANCHOR_EPSILON_PX,
): boolean {
  return isAtBottom(geometry, epsilonPx);
}

/** 「跳到最新」按钮是否显示:不在底部且还有内容。几何驱动,不依赖跟随权。 */
export function shouldShowJumpToBottom(input: {
  atBottom: boolean;
  hasContent: boolean;
}): boolean {
  return input.hasContent && !input.atBottom;
}

/** 行窗口两端 id(rowId;空窗口用 -1)。 */
export interface RowsEdges {
  first: number;
  last: number;
}

/**
 * 内容尺寸变化时,窗口两端 id 的变化类型:
 * - `append`:尾行变了(新行追加 / 窗口滑动)→ 跟随态下贴底;
 * - `prepend`:只有首行变了(加载更早前插)→ 不贴底;
 * - `none`:两端都没变(行内文本流式增长、卡片测高)→ 跟随态下贴底。
 */
export type RowsEdgeChange = "append" | "prepend" | "none";

export function classifyRowsEdgeChange(previous: RowsEdges, next: RowsEdges): RowsEdgeChange {
  if (next.last !== previous.last) return "append";
  if (next.first !== previous.first) return "prepend";
  return "none";
}

/** 内容尺寸变化时是否应贴底:仅在跟随态,且不是前插历史。 */
export function shouldStickOnContentChange(input: {
  following: boolean;
  change: RowsEdgeChange;
}): boolean {
  return input.following && input.change !== "prepend";
}
