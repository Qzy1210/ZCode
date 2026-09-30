/* 会话屏:按"轮"组织的消息流 + 底部交互卡片与输入。
 *
 * 展示规则(与桌面端一致,判定在 conversation/turnRenderModel.ts):
 * - 用户输入与最终助手正文常显;
 * - 一轮里的思考/工具/子代理等"过程"折叠成一行「已工作 N 秒 / 已处理 / 已停止」,点开查看;
 * - 进行中的轮默认展开,中断/失败强制展开,没有最终正文时不折叠。
 *
 * 数据全部来自 conversationStore(单一所有者),本组件不解析帧;
 * 单行渲染在 SessionRowView,协议语义在 interactionModel / turnRenderModel。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Pressable,
  Text,
  View,
  type NativeScrollEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RemoteServiceAccess } from "@zcode/client";

import { createConversationStore, type ConversationView } from "../conversation/conversationStore";
import {
  resolveStopAvailability,
  selectInteractionForDisplay,
  summarizePlan,
} from "../conversation/interactionModel";
import {
  buildTurnRenderModel,
  describeFileChanges,
  type TurnRenderItem,
} from "../conversation/turnRenderModel";
import {
  buildSendOptions,
  describeDraftSummary,
  flattenModelOptions,
  resolveBaseModel,
  resolveComposerPlaceholder,
  type DraftConfig,
  type ModelOption,
} from "../conversation/draftConfig";
import type { ConversationWorkspaceTarget } from "../conversation/conversationTransport";
import { formatRelativeTime } from "../theme";
import { ConfigPickerSheet, type ConfigPickerTarget } from "./ConfigPickerSheet";
import { InteractionCard } from "./InteractionCard";
import { SessionComposer } from "./SessionComposer";
import { SessionStatusBar } from "./SessionStatusBar";
import { SessionRowView } from "./SessionRowView";
import { sessionStyles as styles } from "./sessionStyles";

const DURATION_TICK_MS = 1_000;

export function SessionScreen({
  services,
  workspacePath,
  workspaceIdentity,
  sessionId,
  title,
  onBack,
  onOpenSession,
  reconnecting = false,
  clientId,
}: {
  services: RemoteServiceAccess;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  title: string;
  /** 连接级 clientId(命令信封与握手共用)。 */
  clientId: string;
  /** 连接断开重连中:保留画面但禁用写入,避免在死连接上发命令永久挂起。 */
  reconnecting?: boolean;
  onBack: () => void;
  /** 子代理下钻:打开另一个会话(同一连接,只切换订阅)。 */
  onOpenSession?: (target: { sessionId: string; title: string }) => void;
}) {
  // target 必须是稳定引用:store 依赖它建立订阅,每次渲染换对象会导致反复重订阅。
  const target = useMemo<ConversationWorkspaceTarget>(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    }),
    [workspacePath, workspaceIdentity],
  );
  const store = useMemo(
    () => createConversationStore({ services, target, sessionId, clientId }),
    [services, target, sessionId, clientId],
  );
  useEffect(() => () => store.dispose(), [store]);
  const view: ConversationView = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  const listRef = useRef<FlatList<TurnRenderItem>>(null);
  /** 尾部行 id:用于区分"新消息"与"前插历史",只在有新消息时跟随到底部。 */
  const lastTailRowId = useRef<number>(-1);
  /** 用户是否停留在底部:决定流式增长时是否继续跟随。 */
  const stickToBottom = useRef(true);
  const [draft, setDraft] = useState("");
  /** 每个轮的过程块是否被手动展开;未记录时用模型给的默认值。 */
  const [expandedTurns, setExpandedTurns] = useState<Record<string, boolean>>({});
  /** 每秒 tick:驱动"工作中 N 秒"(仅在有流式内容时运行)。 */
  const [nowMs, setNowMs] = useState(() => Date.now());
  /** 草稿级模型/模式/思考级别选择:随下一次发送提交,不改会话级配置(与桌面一致)。 */
  const [draftConfig, setDraftConfig] = useState<DraftConfig>({});
  const [pickerTarget, setPickerTarget] = useState<ConfigPickerTarget | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  /** 工具条一次性提示(目前只有"添加上下文"在移动端不可用)。 */
  const [composerHint, setComposerHint] = useState<string | null>(null);
  /**
   * Android 上会话覆盖层从屏幕顶端开始画(edge-to-edge),状态栏/导航条让出的
   * 安全区由本屏自己处理;iOS 由外层 SafeAreaView 兜底,insets 只在键盘避让与
   * 底部留白时使用。
   */
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!view.streaming) return;
    const timer = setInterval(() => setNowMs(Date.now()), DURATION_TICK_MS);
    return () => clearInterval(timer);
  }, [view.streaming]);

  const draftSummary = useMemo(
    () => describeDraftSummary(view.config, draftConfig),
    [view.config, draftConfig],
  );

  /**
   * 占位文案与桌面 composer 同语义(chat.placeholder.*):判定在 draftConfig 纯函数里。
   */
  const composerPlaceholder = useMemo(
    () =>
      resolveComposerPlaceholder({
        hasHistory: view.rows.length > 0,
        streaming: view.streaming,
      }),
    [view.rows.length, view.streaming],
  );

  // 打开模型选择时才拉取列表(local scope 的本机 Registry,无需 workspace 参数)。
  useEffect(() => {
    if (pickerTarget !== "model" || modelOptions.length > 0 || loadingModels) return;
    setLoadingModels(true);
    void services.modelSelectionService
      .getView({ selection: null })
      .then((view) => setModelOptions(flattenModelOptions(view)))
      .catch(() => setModelOptions([]))
      .finally(() => setLoadingModels(false));
  }, [pickerTarget, modelOptions.length, loadingModels, services]);

  const items = useMemo(
    () =>
      buildTurnRenderModel(view.rows, {
        nowMs,
        ...(view.control?.phase ? { sessionPhase: view.control.phase } : {}),
      }),
    [view.rows, view.control?.phase, nowMs],
  );

  const handleScroll = useCallback((event: { nativeEvent: NativeScrollEvent }) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromEnd = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    stickToBottom.current = distanceFromEnd < 80;
  }, []);

  const scrollToEnd = useCallback(() => {
    if (!stickToBottom.current) return;
    listRef.current?.scrollToEnd({ animated: false });
  }, []);

  /** 滚到顶部附近自动加载更早的历史;到顶后不再请求。 */
  const handleStartReached = useCallback(() => {
    if (view.atTop || view.loadingOlder || view.status !== "ready") return;
    void store.loadOlder();
  }, [store, view.atTop, view.loadingOlder, view.status]);

  // 交互/控制面派生:协议判断都在纯函数里,这里只做 memo。
  const interactionCard = useMemo(
    () => selectInteractionForDisplay(view.pending),
    [view.pending],
  );
  const stopAvailability = useMemo(() => resolveStopAvailability(view.control), [view.control]);
  const planProgress = useMemo(() => summarizePlan(view.plan), [view.plan]);

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (text.length === 0 || view.send.state === "sending") return;
    // 思考级别住在 modelSelection.options 里:只改档位时用会话当前模型补齐(见 buildSendOptions)。
    const result = await store.send(text, buildSendOptions(draftConfig, resolveBaseModel(view.config)));
    if (result.state === "idle") {
      setDraft("");
      setComposerHint(null);
    }
  }, [draft, draftConfig, store, view.send.state, view.config]);

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

  const planSuffix = planProgress
    ? ` · 计划 ${planProgress.completed}/${planProgress.total}`
    : "";
  const statusLine = reconnecting
    ? "连接已断开，正在重连…"
    : view.error
      ? `同步异常：${view.error.message}`
      : view.status === "loading"
        ? "正在加载会话…"
        : view.streaming
          ? `生成中…${planSuffix}`
          : `共 ${view.rows.length} 行 · 最后更新 ${view.rows.length > 0 ? formatRelativeTime(view.rows[view.rows.length - 1]!.createdAt) : "—"}${planSuffix}`;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      // 两端统一 padding:RN 0.86 的位移计算是 frame.y+frame.height-keyboardY,
      // 本屏铺满整屏(覆盖层从 0 起),padding 恰好等于键盘高度,composer 精确抬到键盘上沿。
      // Android 此前依赖的 adjustResize 在 targetSdk35+edge-to-edge 下已被系统停用,
      // 必须走 JS 侧避让。
      behavior="padding"
    >
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable style={styles.backButton} onPress={onBack}>
          <Text style={styles.backText}>‹ 返回</Text>
        </Pressable>
        <View style={styles.headerBody}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <Text
            style={[styles.statusText, view.status === "error" ? styles.statusError : null]}
            numberOfLines={1}
          >
            {statusLine}
          </Text>
        </View>
        {view.status === "error" ? (
          <Pressable style={styles.retryButton} onPress={() => void store.retry()}>
            <Text style={styles.retryText}>重试</Text>
          </Pressable>
        ) : null}
        {view.status === "ready" && stopAvailability.canStop ? (
          <Pressable
            style={styles.stopButton}
            disabled={reconnecting || view.stop.state === "sending"}
            onPress={() => void store.stopTurn()}
          >
            <Text style={styles.stopText}>
              {view.stop.state === "sending"
                ? "中断中"
                : view.control?.stopState === "stopping"
                  ? "正在停"
                  : "中断"}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <ConfigPickerSheet
        target={pickerTarget}
        modelOptions={modelOptions}
        loadingModels={loadingModels}
        draft={draftConfig}
        thoughtLevels={draftSummary.thoughtLevels}
        {...(view.config?.thought ? { currentThought: view.config.thought } : {})}
        usage={view.usage}
        onPickModel={(option) => {
          // 换模型后旧档位可能不被支持:一并清掉草稿级思考级别(与会话级解耦)。
          setDraftConfig((current) => {
            const { reasoningLevel: _dropped, ...rest } = current;
            return { ...rest, model: { providerId: option.providerId, modelId: option.modelId } };
          });
          setPickerTarget(null);
        }}
        onPickMode={(mode) => {
          setDraftConfig((current) => ({ ...current, mode }));
          setPickerTarget(null);
        }}
        onTogglePlan={(enabled) =>
          setDraftConfig((current) => ({ ...current, planEnabled: enabled }))
        }
        onPickThought={(value) => {
          setDraftConfig((current) => {
            const { reasoningLevel: _dropped, ...rest } = current;
            return value === undefined ? rest : { ...rest, reasoningLevel: value };
          });
          setPickerTarget(null);
        }}
        onClose={() => setPickerTarget(null)}
      />
      {view.stop.state === "rejected" ? (
        <Text style={styles.sendError}>{view.stop.message ?? "中断失败"}</Text>
      ) : null}

      <SessionStatusBar
        plan={view.plan}
        backgroundWorks={view.backgroundWorks}
        workflowRuns={view.workflowRuns}
        queue={view.queue}
        availability={view.availability}
        disabled={reconnecting || view.response.state === "sending"}
        {...(view.response.state === "rejected" && view.response.message
          ? { errorMessage: view.response.message }
          : {})}
        onCancelWork={(workId) => void store.cancelBackgroundWork(workId)}
        onPromote={(queueItemId) => void store.promoteQueuedItem(queueItemId)}
        onRemove={(queueItemId) => void store.removeQueuedItem(queueItemId)}
      />

      <FlatList
        ref={listRef}
        data={items}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        onScroll={handleScroll}
        onContentSizeChange={() => {
          // 只看尾部行是否变化:前插历史也会改变 contentSize,若一律滚到底
          // 会把正在看历史的用户拽回底部。
          const tailKey = view.rows.length > 0 ? view.rows[view.rows.length - 1]!.rowId : -1;
          if (tailKey !== lastTailRowId.current) {
            lastTailRowId.current = tailKey;
            scrollToEnd();
          }
        }}
        // 滚到顶部附近即自动加载更早的历史(不再有底部按钮);
        // maintainVisibleContentPosition 保证前插时视口不跳。
        onStartReached={handleStartReached}
        onStartReachedThreshold={0.4}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        ListHeaderComponent={
          view.loadingOlder ? (
            <Text style={styles.loadOlderText}>正在加载更早…</Text>
          ) : null
        }
        ListEmptyComponent={
          view.status === "loading" ? (
            <Text style={styles.emptyText}>正在加载会话…</Text>
          ) : (
            <Text style={styles.emptyText}>这个任务还没有消息</Text>
          )
        }
      />

      {interactionCard ? (
        <InteractionCard
          card={interactionCard}
          busy={reconnecting || view.response.state === "sending"}
          {...(view.response.state === "rejected" && view.response.message
            ? { errorMessage: view.response.message }
            : {})}
          onRespond={(answer) => void store.respond(interactionCard.interactionId, answer)}
          onInteract={() => void store.snoozeInteraction(interactionCard.interactionId)}
        />
      ) : null}
      {view.send.state === "rejected" ? (
        <Text style={styles.sendError}>{view.send.message ?? "发送失败"}</Text>
      ) : null}
      <SessionComposer
        draft={draft}
        onChangeDraft={setDraft}
        placeholder={composerPlaceholder}
        editable={view.status !== "error" && !reconnecting}
        sending={view.send.state === "sending"}
        reconnecting={reconnecting}
        labels={{
          mode: draftSummary.mode,
          model: draftSummary.model,
          thought: draftSummary.thought,
        }}
        hint={composerHint}
        onHint={setComposerHint}
        onOpenPicker={(target) =>
          setPickerTarget((current) => (current === target ? null : target))
        }
        onSend={() => void handleSend()}
        bottomInset={insets.bottom}
      />
    </KeyboardAvoidingView>
  );
}
