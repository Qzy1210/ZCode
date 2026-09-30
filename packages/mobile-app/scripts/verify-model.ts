/* 交互模型验证(纯函数):
 *   node packages/mobile-app/scripts/verify.mjs model
 *
 * 这里覆盖的是"协议语义"——答案形状必须与 CLI interaction-broker 的归一规则一致,
 * 出错的代价是静默误批/误拒,所以每条规则都单独立断言。
 */
import {
  describeAutoResolution,
  describeCountdown,
  buildDeclineAnswer,
  buildInteractionCard,
  buildLegacyUserInputAnswer,
  buildPermissionAnswer,
  buildPlanAnswer,
  buildQuestionAnswer,
  PLAN_APPROVAL_APPROVE,
  selectInteractionForDisplay,
  summarizePlan,
} from "../src/conversation/interactionModel";
import {
  buildSendOptions,
  describeContextUsage,
  describeDraftSummary,
  flattenModelOptions,
  formatTokenCount,
  modeLabel,
  PERMISSION_MODE_OPTIONS,
  resolveBaseModel,
  thoughtLevelLabel,
} from "../src/conversation/draftConfig";
import {
  describeAttachments,
  describeBackgroundWork,
  describeWorkflowRuns,
  describeQueue,
  nextCasRevision,
  selectActiveWorks,
  selectCancellableWorks,
} from "../src/conversation/runtimeActions";
import {
  check,
  finish,
  hookReviewInteraction,
  permissionInteraction,
  planInteraction,
  questionInteraction,
} from "./verify-harness";

// ── P3:交互模型(纯函数)──
const permissionCard = buildInteractionCard(permissionInteraction("perm-1"));
check(
  "审批卡片:工具名与选项齐备",
  permissionCard.kind === "permission" &&
    permissionCard.toolName === "Bash" &&
    permissionCard.options.length === 2 &&
    permissionCard.freeText,
);
check(
  "审批卡片:detail 被格式化为可读文本",
  permissionCard.kind === "permission" && permissionCard.detailText.includes("rm -rf build"),
  permissionCard.kind === "permission" ? permissionCard.detailText : "",
);
check(
  "审批答案:选项 + 备注",
  JSON.stringify(buildPermissionAnswer("deny", " 先别删 ")) ===
    JSON.stringify({ optionId: "deny", freeText: "先别删" }),
);
check(
  "审批答案:空备注不下发",
  JSON.stringify(buildPermissionAnswer("allowOnce", "   ")) === JSON.stringify({ optionId: "allowOnce" }),
);

const planCard = buildInteractionCard(planInteraction("plan-1"));
check("计划卡片:ExitPlanMode 识别为 plan", planCard.kind === "plan", planCard.kind);
check(
  "计划批准走哨兵值 approve",
  JSON.stringify(buildPlanAnswer("approve")) ===
    JSON.stringify({ action: "accept", content: { answer: PLAN_APPROVAL_APPROVE } }),
);
check(
  "计划拒绝带反馈:accept + answer=反馈(CLI 归一为 deny+原因)",
  JSON.stringify(buildPlanAnswer("decline", " 先补测试 ")) ===
    JSON.stringify({ action: "accept", content: { answer: "先补测试" } }),
);
check("计划拒绝无反馈:decline", JSON.stringify(buildPlanAnswer("decline")) === JSON.stringify({ action: "decline" }));

const questionCard = buildInteractionCard(questionInteraction("q-1"));
check(
  "问答卡片:多题结构完整",
  questionCard.kind === "question" &&
    questionCard.questions.length === 1 &&
    questionCard.questions[0]?.multiSelect === true &&
    questionCard.questions[0]?.options.length === 2,
);
check(
  "问答答案:多选以 ', ' 连接且按问题原文为 key",
  JSON.stringify(buildQuestionAnswer([{ question: "选哪些?", values: ["a", "b"] }])) ===
    JSON.stringify({ action: "accept", content: { answers: { "选哪些?": "a, b" } } }),
);
check(
  "问答答案:未作答的题不下发",
  JSON.stringify(buildQuestionAnswer([{ question: "选哪些?", values: ["  "] }])) ===
    JSON.stringify({ action: "accept", content: { answers: {} } }),
);
check(
  "旧式单题:自由文本优先,其次选项",
  JSON.stringify(buildLegacyUserInputAnswer({ optionId: "o1", freeText: "自定义" })) ===
    JSON.stringify({ freeText: "自定义" }) &&
    JSON.stringify(buildLegacyUserInputAnswer({ optionId: "o1" })) === JSON.stringify({ optionId: "o1" }),
);
check("拒绝答案统一为 decline", JSON.stringify(buildDeclineAnswer()) === JSON.stringify({ action: "decline" }));
check(
  "hook review 交互不渲染,但不阻塞后续交互",
  buildInteractionCard(hookReviewInteraction("hook-1")).kind === "unsupported" &&
    selectInteractionForDisplay([
      hookReviewInteraction("hook-1"),
      permissionInteraction("perm-2"),
    ])?.interactionId === "perm-2",
);
check("计划进度摘要", (() => {
  const progress = summarizePlan({
    items: [
      { id: "1", content: "读代码", status: "completed" },
      { id: "2", content: "改代码", status: "inProgress" },
      { id: "3", content: "跑测试", status: "pending" },
    ],
    updatedAt: Date.now(),
  });
  return progress?.completed === 1 && progress.inProgress === 1 && progress.total === 3;
})());
check("空计划不显示", summarizePlan({ items: [], updatedAt: Date.now() }) === null);

// ── 草稿级模型/模式(与桌面 composer 同语义:随下次发送提交) ──
check(
  "权限模式候选与协议取值一致(不含 plan,plan 走独立开关)",
  PERMISSION_MODE_OPTIONS.map((option) => option.value).join(",") === "build,edit,yolo",
);
check("未选择时不下发字段(交给 CLI 取会话当前值)", (() => {
  const options = buildSendOptions({});
  return Object.keys(options).length === 0;
})());
check("选择后按协议字段下发", (() => {
  const options = buildSendOptions({
    model: { providerId: "zai", modelId: "glm-4.6" },
    mode: "edit",
    planEnabled: true,
  });
  return (
    options.modelSelection?.modelId === "glm-4.6" &&
    options.mode === "edit" &&
    options.planEnabled === true
  );
})());
check("头部摘要:草稿覆盖会话配置", (() => {
  const summary = describeDraftSummary(
    { model: "glm-4.5", mode: "build", planEnabled: false },
    { model: { providerId: "zai", modelId: "glm-4.6" }, mode: "yolo" },
  );
  return summary.model === "glm-4.6" && summary.mode === "完全放行" && summary.planOn === false;
})());
check("头部摘要:计划开启时显示计划模式", (() => {
  const summary = describeDraftSummary({ mode: "build" }, { planEnabled: true });
  return summary.planOn === true && summary.mode === "计划模式";
})());
check("模型列表拍平:按 provider 分组且跳过空 provider", (() => {
  const options = flattenModelOptions({
    providers: [
      { providerId: "zai", providerName: "Z.ai", models: [{ modelId: "glm-4.6" }] },
      { providerId: "empty", providerName: null, models: [] },
    ],
  });
  return options.length === 1 && options[0]?.group === "Z.ai" && options[0].modelId === "glm-4.6";
})());
check("模式标签兜底", modeLabel(undefined) === "改前询问" && modeLabel("yolo") === "完全放行");

// ── 工具条:思考级别 / 上下文用量(与桌面 composer 工具条同语义) ──
check("思考级别标签:已知档位中文、未知档位原样", (() => {
  return (
    thoughtLevelLabel("off") === "关闭" &&
    thoughtLevelLabel("low") === "低" &&
    thoughtLevelLabel("high") === "高" &&
    thoughtLevelLabel("max") === "最高" &&
    thoughtLevelLabel("enabled") === "开启" &&
    thoughtLevelLabel("provider-custom") === "provider-custom" &&
    thoughtLevelLabel(undefined) === "默认"
  );
})());
check("思考级别:只改档位时用会话当前模型补齐 modelSelection", (() => {
  const options = buildSendOptions(
    { reasoningLevel: "high" },
    { providerId: "zai", modelId: "glm-4.6" },
  );
  return (
    options.modelSelection?.providerId === "zai" &&
    options.modelSelection.modelId === "glm-4.6" &&
    options.modelSelection.options?.reasoningLevel === "high"
  );
})());
check("思考级别:草稿模型优先于会话基线", (() => {
  const options = buildSendOptions(
    { model: { providerId: "deepseek", modelId: "v4" }, reasoningLevel: "low" },
    { providerId: "zai", modelId: "glm-4.6" },
  );
  return (
    options.modelSelection?.providerId === "deepseek" &&
    options.modelSelection.options?.reasoningLevel === "low"
  );
})());
check("思考级别:没有基线模型时不下发模型选择(避免伪造 provider)", (() => {
  const options = buildSendOptions({ reasoningLevel: "high" }, null);
  return options.modelSelection === undefined;
})());
check("只选模型(未选档位)时不带 reasoningLevel", (() => {
  const options = buildSendOptions({ model: { providerId: "zai", modelId: "glm-4.6" } });
  return options.modelSelection !== undefined && options.modelSelection.options === undefined;
})());
check("会话基线模型解析:优先 modelSelection,退回 provider/model", (() => {
  const fromSelection = resolveBaseModel({
    provider: "raw-provider",
    model: "raw-model",
    modelSelection: { providerId: "zai", modelId: "glm-4.6" },
  });
  const fromLegacy = resolveBaseModel({ provider: "raw-provider", model: "raw-model" });
  const missing = resolveBaseModel({ provider: "raw-provider" });
  return (
    fromSelection?.providerId === "zai" &&
    fromLegacy?.modelId === "raw-model" &&
    missing === null
  );
})());
check("头部摘要:思考级别取草稿覆盖并给出可用档位", (() => {
  const summary = describeDraftSummary(
    { model: "glm-4.6", mode: "build", thought: "off", thoughtLevels: ["off", "low", "high"] },
    { reasoningLevel: "high" },
  );
  return summary.thought === "高" && summary.thoughtLevels.length === 3;
})());
check("上下文用量:已用/上限/剩余百分比与距自动压缩", (() => {
  const summary = describeContextUsage({
    contextWindow: {
      usedTokens: 30_000,
      maxTokens: 120_000,
      autoCompactThresholdTokens: 100_000,
    },
    cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  return (
    summary?.remainingPercent === 75 &&
    summary.tokensUntilAutoCompact === 70_000 &&
    formatTokenCount(summary.usedTokens) === "30,000"
  );
})());
check("上下文用量:无事实/上限为 0 时不显示", (() => {
  return (
    describeContextUsage(null) === null &&
    describeContextUsage({
      contextWindow: { usedTokens: 10, maxTokens: 0, autoCompactThresholdTokens: null },
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }) === null
  );
})());
check("上下文用量:超出上限时剩余不为负", (() => {
  const summary = describeContextUsage({
    contextWindow: { usedTokens: 200_000, maxTokens: 120_000, autoCompactThresholdTokens: null },
    cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  return summary?.remainingPercent === 0 && summary.tokensUntilAutoCompact === null;
})());

// ── 后台工作与队列(运行态操作) ──
const works = [
  { workId: "w1", kind: "bash", title: "npm run dev", status: "running", startedAt: 1 },
  { workId: "w2", kind: "subagent", title: "调研", status: "running", cancellable: false, startedAt: 1 },
  { workId: "w3", kind: "workflow", title: "流程", status: "failed", startedAt: 1 },
  { workId: "w4", kind: "bash", title: "等待结果", status: "resultPending", startedAt: 1 },
] as never as Parameters<typeof selectCancellableWorks>[0];
check(
  "只有运行中且未标记不可取消的后台工作可取消",
  selectCancellableWorks(works).map((work) => work.workId).join(",") === "w1",
  selectCancellableWorks(works).map((work) => work.workId).join(","),
);
check(
  "活跃工作含运行中与待取结果",
  selectActiveWorks(works).map((work) => work.workId).join(",") === "w1,w2,w4",
);
check("后台工作文案", describeBackgroundWork(works[0]!).includes("后台命令"));

const queue = {
  items: [
    { queueItemId: "q1", kind: "sendText", text: "排队的第一条", dispatch: { state: "queued" } },
    { queueItemId: "q2", kind: "sendText", text: "正在提升", dispatch: { state: "promoting" } },
  ],
  autoDrain: false,
  pauseReason: "stopped",
} as never as Parameters<typeof describeQueue>[0];
const queueView = describeQueue(queue, { queueEdit: { allowed: true }, sendQueuedNow: { allowed: true } });
check("队列视图:两个条目", queueView?.items.length === 2);
check("队列视图:已暂停给出提示", queueView?.pausedHint === "已停止,队列暂停", queueView?.pausedHint ?? "");
check(
  "队列视图:正在提升的项不可再操作",
  queueView?.items[1]?.canPromote === false && queueView.items[1]?.canDelete === false,
);
check(
  "队列视图:队列门禁关闭时不可删除",
  describeQueue(queue, { queueEdit: { allowed: false, reasonCode: "x" } })?.items[0]?.canDelete === false,
);
check("空队列不显示", describeQueue({ items: [], autoDrain: true } as never, null) === null);

check(
  "CAS:stale 用服务端 revision 重试",
  nextCasRevision({ status: "stale", revisionAtDecision: 42 } as never) === 42,
);
check(
  "CAS:非 stale 不重试",
  nextCasRevision({ status: "rejected" } as never) === undefined,
);

// ── 自动结束倒计时(AskUserQuestion 这类交互会自己收尾) ──
const now = 1_000_000;
check(
  "无 autoResolution 时不显示倒计时",
  describeAutoResolution(undefined, now).mode === "none",
);
check(
  "宽限期内不显示倒计时(避免惊扰)",
  describeAutoResolution(
    { state: "hiddenGrace", startedAt: now - 100, visibleAt: now + 3_000, deadlineAt: now + 30_000 },
    now,
  ).mode === "hidden",
);
check(
  "可见后显示剩余时间",
  (() => {
    const view = describeAutoResolution(
      { state: "visibleCountdown", startedAt: now - 1_000, visibleAt: now - 500, deadlineAt: now + 8_400 },
      now,
    );
    return view.mode === "countdown" && Math.ceil(view.remainingMs / 1000) === 9;
  })(),
);
check(
  "已暂停(用户动过手)时不再显示倒计时",
  describeAutoResolution({ state: "snoozed", startedAt: now - 1_000, snoozedAt: now - 500 }, now).mode ===
    "snoozed",
);
check(
  "倒计时文案不出现 0 秒",
  describeCountdown(0) === "还剩 1 秒自动处理" && describeCountdown(2_100) === "还剩 3 秒自动处理",
  describeCountdown(0),
);

// ── 工作流运行(只读) ──
const workflowRuns = [
  { runId: "run-abcdef123456", status: "running", usage: { spentTokens: 3_400, nodesUsed: 12 }, nodes: [], actors: [] },
  { runId: "run-finished0000", status: "completed", usage: { spentTokens: 100, nodesUsed: 3 }, nodes: [], actors: [] },
  { runId: "run-pending00000", status: "pending", usage: { spentTokens: 0, nodesUsed: 0 }, nodes: [], actors: [] },
] as never as Parameters<typeof describeWorkflowRuns>[0];
check(
  "只展示进行中的工作流(已结束的不占位)",
  describeWorkflowRuns(workflowRuns).map((row) => row.runId).join(",") ===
    "run-abcdef123456,run-pending00000",
  describeWorkflowRuns(workflowRuns).map((row) => row.runId).join(","),
);
check(
  "工作流行含状态/步数/tokens",
  describeWorkflowRuns(workflowRuns)[0]?.label === "工作流 run-abcd · 运行中 · 已用 12 步 · 3.4k tokens",
  describeWorkflowRuns(workflowRuns)[0]?.label ?? "",
);
check("无 token 消耗时不显示 tokens 段", !(describeWorkflowRuns(workflowRuns)[1]?.label ?? "").includes("tokens"));
check("工作流数量上限", describeWorkflowRuns(workflowRuns as never, 1).length === 1);

// ── 附件摘要(只读:手机不取字节) ──
check("无附件不显示", describeAttachments(undefined) === null && describeAttachments([]) === null);
check(
  "附件摘要含数量与名称",
  describeAttachments([{ fileName: "a.png" }, { fileName: "b.ts" }]) === "📎 2 个附件 · a.png、b.ts",
  describeAttachments([{ fileName: "a.png" }, { fileName: "b.ts" }]) ?? "",
);
check(
  "附件名过长时截断",
  (describeAttachments([{ fileName: "x".repeat(80) }]) ?? "").endsWith("…"),
);

finish();
