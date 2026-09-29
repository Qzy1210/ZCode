/* 交互模型验证(纯函数):
 *   node packages/mobile-app/scripts/verify.mjs model
 *
 * 这里覆盖的是"协议语义"——答案形状必须与 CLI interaction-broker 的归一规则一致,
 * 出错的代价是静默误批/误拒,所以每条规则都单独立断言。
 */
import {
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

finish();
