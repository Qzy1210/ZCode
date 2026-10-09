/* 会话时间线:按"轮"组织的消息流 + 底部锚定 + 「跳到最新」悬浮按钮。
 *
 * 为什么单独成组件:锚定状态机(用户滚动权 / 贴底收敛 / 前插不打扰)与列表渲染
 * 共享同一批 ref 与渲染依赖,放在会话屏里会把屏幕编排淹没。语义与桌面
 * packages/ui/src/v4/timelineScrollAnchor.ts 一致,纯函数判定在 conversation/scrollAnchor.ts。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import {
  FlatList,
  Pressable,
  Text,
  View,
  type NativeScrollEvent,
} from "react-native";
import type { ConversationRow, SessionControl } from "@zcode/shared/zcode-protocol-v4";

import {
  classifyRowsEdgeChange,
  isAtBottom,
  resolveFollowingAfterUserScroll,
  shouldShowJumpToBottom,
  shouldStickOnContentChange,
  type RowsEdges,
  type ScrollGeometry,
} from "../conversation/scrollAnchor";
import {
  buildTurnRenderModel,
  describeFileChanges,
  type TurnRenderItem,
} from "../conversation/turnRenderModel";
import { theme } from "../theme";
import { SessionRowView } from "./SessionRowView";
import { sessionStyles as styles } from "./sessionStyles";

/** 贴底收敛:间隔与次数覆盖"变高行首帧后才测完高"的窗口(约 0.6s)。 */
const JUMP_SETTLE_INTERVAL_MS = 120;
const JUMP_SETTLE_MAX_ATTEMPTS = 5;
/** 拖拽结束后等待惯性滚动开始的宽限;无惯性时到此清掉用户输入态。 */
const DRAG_END_GRACE_MS = 120;

export function SessionTimeline({
  rows,
  sessionPhase,
  streaming,
  status,
  loadingOlder,
  atTop,
  onLoadOlder,
  onOpenSession,
}: {
  rows: ConversationRow[];
  /** 会话相位(control.phase):影响时长文案与运行轮的默认展开。 */
  sessionPhase?: SessionControl["phase"];
  /** 有流式行时驱动"工作中 N 秒"的每秒 tick。 */
  streaming: boolean;
  status: "loading" | "ready" | "error";
  loadingOlder: boolean;
  atTop: boolean;
  onLoadOlder: () => void;
  onOpenSession?: (target: { sessionId: string; title: string }) => void;
}) {
  /** 每秒 tick:驱动"工作中 N 秒"(仅在有流式内容时运行)。 */
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!streaming) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [streaming]);

  /** 每个轮的过程块是否被手动展开;未记录时用模型给的默认值。 */
  const [expandedTurns, setExpandedTurns] = useState<Record<string, boolean>>({});

  const items = useMemo(
    () => buildTurnRenderModel(rows, { nowMs, ...(sessionPhase ? { sessionPhase } : {}) }),
    [rows, sessionPhase, nowMs],
  );

  const listRef = useRef<FlatList<TurnRenderItem>>(null);
  /**
   * 底部锚定状态:`following` 是"用户滚动权",只有真实用户滚动输入能改变它;
   * 程序化贴底与测高补偿只更新几何账目(atBottom 驱动按钮显隐)。
   */
  const followingRef = useRef(true);
  /** 手指驱动滚动(拖拽/惯性)窗口:只有这段窗口内的 onScroll 才算用户输入。 */
  const userScrollingRef = useRef(false);
  const dragEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleAttemptsRef = useRef(0);
  const lastMetricsRef = useRef<ScrollGeometry | null>(null);
  /** 行窗口两端 id:区分"前插历史"与"追加 / 流式增长"。 */
  const rowsEdgesRef = useRef<RowsEdges>({ first: -1, last: -1 });
  const [atBottom, setAtBottom] = useState(true);

  /** 贴底:置跟随态并滚到底;变高行测高期间有界重试,直到几何上真的到底或用户接管。 */
  const jumpToBottom = useCallback((animated: boolean) => {
    followingRef.current = true;
    settleAttemptsRef.current = 0;
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    listRef.current?.scrollToEnd({ animated });
    const settle = () => {
      settleTimerRef.current = null;
      if (!followingRef.current || userScrollingRef.current) return;
      const metrics = lastMetricsRef.current;
      if (metrics && isAtBottom(metrics)) return;
      if (settleAttemptsRef.current >= JUMP_SETTLE_MAX_ATTEMPTS) return;
      settleAttemptsRef.current += 1;
      listRef.current?.scrollToEnd({ animated: false });
      settleTimerRef.current = setTimeout(settle, JUMP_SETTLE_INTERVAL_MS);
    };
    settleTimerRef.current = setTimeout(settle, JUMP_SETTLE_INTERVAL_MS);
  }, []);

  /** 滚动事件:几何账目总是更新(含程序化贴底),跟随态只在用户手指驱动期间改变。 */
  const handleScroll = useCallback((event: { nativeEvent: NativeScrollEvent }) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const metrics: ScrollGeometry = {
      offsetY: contentOffset.y,
      contentHeight: contentSize.height,
      viewportHeight: layoutMeasurement.height,
    };
    lastMetricsRef.current = metrics;
    const nextAtBottom = isAtBottom(metrics);
    setAtBottom((current) => (current === nextAtBottom ? current : nextAtBottom));
    if (!userScrollingRef.current) return;
    followingRef.current = resolveFollowingAfterUserScroll(metrics);
  }, []);

  const handleScrollBeginDrag = useCallback(() => {
    if (dragEndTimerRef.current) {
      clearTimeout(dragEndTimerRef.current);
      dragEndTimerRef.current = null;
    }
    userScrollingRef.current = true;
  }, []);
  const handleScrollEndDrag = useCallback(() => {
    if (dragEndTimerRef.current) clearTimeout(dragEndTimerRef.current);
    // 惯性滚动紧接着拖拽结束开始:给一个短窗口;无惯性时到此结束用户输入态。
    dragEndTimerRef.current = setTimeout(() => {
      dragEndTimerRef.current = null;
      userScrollingRef.current = false;
    }, DRAG_END_GRACE_MS);
  }, []);
  const handleMomentumScrollBegin = useCallback(() => {
    if (dragEndTimerRef.current) {
      clearTimeout(dragEndTimerRef.current);
      dragEndTimerRef.current = null;
    }
    userScrollingRef.current = true;
  }, []);
  const handleMomentumScrollEnd = useCallback(() => {
    userScrollingRef.current = false;
  }, []);

  /** 内容尺寸变化:跟随态下的追加/流式增长贴底;前插历史不贴底(不把读历史的人拽回来)。 */
  const handleContentSizeChange = useCallback(() => {
    const next: RowsEdges = {
      first: rows[0]?.rowId ?? -1,
      last: rows[rows.length - 1]?.rowId ?? -1,
    };
    const change = classifyRowsEdgeChange(rowsEdgesRef.current, next);
    rowsEdgesRef.current = next;
    if (!shouldStickOnContentChange({ following: followingRef.current, change })) return;
    jumpToBottom(false);
  }, [rows, jumpToBottom]);

  useEffect(
    () => () => {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      if (dragEndTimerRef.current) clearTimeout(dragEndTimerRef.current);
    },
    [],
  );

  const toggleTurn = useCallback((turnId: string, next: boolean) => {
    setExpandedTurns((current) => ({ ...current, [turnId]: next }));
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: TurnRenderItem }) => {
      if (item.kind === "user") {
        return (
          <View style={[styles.row, styles.userRow]}>
            <Text style={styles.userLabel}>你</Text>
            <Text style={styles.userText}>{item.row.text}</Text>
          </View>
        );
      }
      if (item.kind === "row") {
        return <SessionRowView row={item.row} {...(onOpenSession ? { onOpenSession } : {})} />;
      }
      const open = expandedTurns[item.turnId] ?? item.defaultOpen;
      return (
        <View style={styles.processBlock}>
          <Pressable style={styles.processHeader} onPress={() => toggleTurn(item.turnId, !open)}>
            <Text style={styles.processLabel} numberOfLines={1}>
              {item.label}
              {item.fileChanges ? ` · ${describeFileChanges(item.fileChanges)}` : ""}
            </Text>
            <Text style={styles.processChevron}>{open ? "收起" : "查看过程"}</Text>
          </Pressable>
          {open ? (
            <View style={styles.processBody}>
              {item.rows.map((row) => (
                <SessionRowView
                  key={row.rowId}
                  row={row}
                  {...(onOpenSession ? { onOpenSession } : {})}
                />
              ))}
            </View>
          ) : null}
        </View>
      );
    },
    [expandedTurns, onOpenSession, toggleTurn],
  );

  return (
    <View style={styles.listWrapper}>
      <FlatList
        ref={listRef}
        data={items}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        onScroll={handleScroll}
        onContentSizeChange={handleContentSizeChange}
        // 手指驱动窗口:只有这段窗口内的滚动能改变跟随态(程序化贴底/测高补偿不算)。
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={handleScrollEndDrag}
        onMomentumScrollBegin={handleMomentumScrollBegin}
        onMomentumScrollEnd={handleMomentumScrollEnd}
        // 滚到顶部附近即自动加载更早的历史(不再有底部按钮);
        // maintainVisibleContentPosition 保证前插时视口不跳。
        onStartReached={() => {
          if (atTop || loadingOlder || status !== "ready") return;
          onLoadOlder();
        }}
        onStartReachedThreshold={0.4}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        ListHeaderComponent={
          loadingOlder ? <Text style={styles.loadOlderText}>正在加载更早…</Text> : null
        }
        ListEmptyComponent={
          status === "loading" ? (
            <Text style={styles.emptyText}>正在加载会话…</Text>
          ) : (
            <Text style={styles.emptyText}>这个任务还没有消息</Text>
          )
        }
      />
      {/*
        「跳到最新」悬浮按钮:与桌面端同语义(离底才出现,点它恢复跟随)。
        位置在列表右下角、composer 之上,不挡输入框。
      */}
      {shouldShowJumpToBottom({ atBottom, hasContent: items.length > 0 }) ? (
        <Pressable
          style={styles.jumpToBottomButton}
          accessibilityRole="button"
          accessibilityLabel="跳到最新消息"
          onPress={() => jumpToBottom(true)}
        >
          <MaterialCommunityIcons name="chevron-down" size={22} color={theme.foreground} />
        </Pressable>
      ) : null}
    </View>
  );
}
