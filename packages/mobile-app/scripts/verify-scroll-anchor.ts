/* 底部锚定验证(纯函数):
 *   node packages/mobile-app/scripts/verify.mjs scroll
 *
 * 这几条判定的后果都是"用户看不到最新输出"或反过来"正在看历史被拽回底部",
 * 所以边界(容差、内容不足一屏、前插 vs 追加)逐条断言。
 */
import {
  BOTTOM_ANCHOR_EPSILON_PX,
  classifyRowsEdgeChange,
  distanceToBottom,
  isAtBottom,
  resolveFollowingAfterUserScroll,
  shouldShowJumpToBottom,
  shouldStickOnContentChange,
} from "../src/conversation/scrollAnchor";
import { check, finish } from "./verify-harness";

// ── 几何:离底距离与"在底部"容差 ──
check(
  "离底距离 = 内容高 - 视口高 - 滚动位置",
  distanceToBottom({ offsetY: 100, contentHeight: 1_000, viewportHeight: 400 }) === 500,
);
check(
  "内容不足一屏时离底距离为 0(不会出现负数)",
  distanceToBottom({ offsetY: 0, contentHeight: 200, viewportHeight: 400 }) === 0,
);
check(
  "容差边界:恰好在容差上算在底部",
  isAtBottom({ offsetY: 552, contentHeight: 1_000, viewportHeight: 400 }) === true &&
    isAtBottom({ offsetY: 551, contentHeight: 1_000, viewportHeight: 400 }) === false,
  `epsilon=${BOTTOM_ANCHOR_EPSILON_PX}`,
);
check(
  "滚到最底(offset 到底)必在底部",
  isAtBottom({ offsetY: 600, contentHeight: 1_000, viewportHeight: 400 }) === true,
);

// ── 跟随权:只有用户输入能改变 ──
check(
  "用户上滚离底 → 解除跟随",
  resolveFollowingAfterUserScroll({ offsetY: 0, contentHeight: 5_000, viewportHeight: 400 }) ===
    false,
);
check(
  "用户滚回底部 → 恢复跟随",
  resolveFollowingAfterUserScroll({
    offsetY: 4_600,
    contentHeight: 5_000,
    viewportHeight: 400,
  }) === true,
);

// ── 按钮显隐:几何驱动 ──
check(
  "不在底部且有内容 → 显示「跳到最新」",
  shouldShowJumpToBottom({ atBottom: false, hasContent: true }) === true,
);
check(
  "在底部不显示;没有内容也不显示",
  shouldShowJumpToBottom({ atBottom: true, hasContent: true }) === false &&
    shouldShowJumpToBottom({ atBottom: false, hasContent: false }) === false,
);

// ── 内容尺寸变化:追加/流式增长贴底,前插不贴底 ──
check(
  "尾行变化 → append(新行追加 / 窗口滑动)",
  classifyRowsEdgeChange({ first: 1, last: 10 }, { first: 1, last: 11 }) === "append" &&
    classifyRowsEdgeChange({ first: 1, last: 10 }, { first: 2, last: 11 }) === "append",
);
check(
  "只有首行变化 → prepend(加载更早)",
  classifyRowsEdgeChange({ first: 10, last: 20 }, { first: 1, last: 20 }) === "prepend",
);
check(
  "两端都没变 → none(行内文本流式增长 / 卡片测高)",
  classifyRowsEdgeChange({ first: 1, last: 10 }, { first: 1, last: 10 }) === "none",
);
check(
  "跟随态下:追加与流式增长都贴底,前插不贴底",
  shouldStickOnContentChange({ following: true, change: "append" }) === true &&
    shouldStickOnContentChange({ following: true, change: "none" }) === true &&
    shouldStickOnContentChange({ following: true, change: "prepend" }) === false,
);
check(
  "非跟随态(用户在看历史)下:任何变化都不贴底",
  shouldStickOnContentChange({ following: false, change: "append" }) === false &&
    shouldStickOnContentChange({ following: false, change: "none" }) === false,
);

finish();
