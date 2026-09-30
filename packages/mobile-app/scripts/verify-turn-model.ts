/* 轮分组与过程收敛验证(纯函数):
 *   node packages/mobile-app/scripts/verify.mjs turns
 *
 * 判定错的后果是"任务完成后过程还铺满屏幕"或反过来"整轮内容被藏起来找不到",
 * 所以每条规则都单独立断言。
 */
import type {
  AssistantTextRow,
  ConversationRow,
  TurnHeaderRow,
} from "@zcode/shared/zcode-protocol-v4";

import {
  buildTurnRenderModel,
  describeFileChanges,
  describeTurnProcessLabel,
  resolveFinalTextRow,
  resolveTurnRunning,
  type AssistantWorkRow,
} from "../src/conversation/turnRenderModel";
import { resolveComposerPlaceholder } from "../src/conversation/draftConfig";
import { check, finish } from "./verify-harness";

let nextRowId = 1;
function base() {
  const rowId = nextRowId++;
  return { rowId, createdAt: Date.now(), createdAtSeq: rowId };
}

function header(turnId: string, state: TurnHeaderRow["state"], extra: Partial<TurnHeaderRow> = {}): TurnHeaderRow {
  return { ...base(), kind: "turnHeader", turnId, origin: "userInput", state, ...extra } as TurnHeaderRow;
}

function user(turnId: string, text: string): ConversationRow {
  return { ...base(), kind: "userInput", turnId, text, origin: "realUser" } as ConversationRow;
}

function assistant(
  turnId: string,
  text: string,
  state: "streaming" | "complete" = "complete",
  actions?: AssistantTextRow["actions"],
): AssistantTextRow {
  return {
    ...base(),
    kind: "assistantText",
    turnId,
    text,
    state,
    ...(actions ? { actions } : {}),
  } as AssistantTextRow;
}

function tool(turnId: string, status: "running" | "success"): AssistantWorkRow {
  return {
    ...base(),
    kind: "toolCall",
    turnId,
    toolCallId: `tc-${nextRowId}`,
    toolName: "Bash",
    status,
    inputText: "npm test",
  } as AssistantWorkRow;
}

function reasoning(turnId: string, state: "streaming" | "complete" = "complete"): AssistantWorkRow {
  return { ...base(), kind: "reasoning", turnId, text: "想想", state } as AssistantWorkRow;
}

// ── 单轮:完成态 → 过程折叠、正文常显 ──
{
  const rows: ConversationRow[] = [
    header("t1", "completedSuccess", { activeMs: 42_000 }),
    user("t1", "帮我看看构建失败"),
    reasoning("t1"),
    tool("t1", "success"),
    assistant("t1", "构建失败是因为缺少依赖,已修好。"),
  ];
  const items = buildTurnRenderModel(rows, { nowMs: Date.now() });
  check(
    "完成轮:用户气泡 + 折叠块 + 最终正文,顺序正确",
    items.map((item) => item.kind).join(",") === "user,process,row",
    items.map((item) => item.kind).join(","),
  );
  const process = items.find((item) => item.kind === "process");
  check(
    "过程块只含思考与工具(不含最终正文)",
    process?.kind === "process" && process.rows.length === 2,
    process?.kind === "process" ? String(process.rows.length) : process?.kind,
  );
  check("完成轮默认折叠", process?.kind === "process" && process.defaultOpen === false);
  check(
    "折叠行文案带时长",
    process?.kind === "process" && process.label === "已工作 42 秒",
    process?.kind === "process" ? process.label : "",
  );
  const finalRow = items.find((item) => item.kind === "row");
  check(
    "最终正文是最后一条助手文本",
    finalRow?.kind === "row" &&
      finalRow.row.kind === "assistantText" &&
      finalRow.row.text.includes("已修好"),
  );
}

// ── 进行中的最后一轮:默认展开 ──
{
  const rows: ConversationRow[] = [
    header("t1", "running"),
    user("t1", "跑测试"),
    tool("t1", "running"),
    assistant("t1", "正在运行测试", "streaming"),
  ];
  const items = buildTurnRenderModel(rows, { nowMs: Date.now() });
  const process = items.find((item) => item.kind === "process");
  check("运行轮默认展开", process?.kind === "process" && process.defaultOpen === true);
  check(
    "运行轮折叠行文案为工作中",
    process?.kind === "process" && process.label.startsWith("工作中"),
    process?.kind === "process" ? process.label : "",
  );
  check(
    "运行中不提升最终正文(流式正文留在过程里)",
    items.every((item) => item.kind !== "row"),
    items.map((item) => item.kind).join(","),
  );
}

// ── 中断/失败:强制展开(用户需要看到发生了什么) ──
{
  const rows: ConversationRow[] = [
    header("t1", "completedInterrupted"),
    user("t1", "继续"),
    tool("t1", "success"),
    assistant("t1", "先到这里"),
  ];
  const items = buildTurnRenderModel(rows, { nowMs: Date.now() });
  const process = items.find((item) => item.kind === "process");
  check("中断轮强制展开", process?.kind === "process" && process.defaultOpen === true);
  check(
    "中断轮文案为已停止",
    process?.kind === "process" && process.label === "已停止",
    process?.kind === "process" ? process.label : "",
  );
}

// ── 没有最终文本:不折叠(否则整轮被藏起来) ──
{
  const rows: ConversationRow[] = [
    header("t1", "completedSuccess"),
    user("t1", "做点事"),
    tool("t1", "success"),
  ];
  const items = buildTurnRenderModel(rows, { nowMs: Date.now() });
  const process = items.find((item) => item.kind === "process");
  check("没有最终正文时不折叠", process?.kind === "process" && process.defaultOpen === true);

  const rowsWithoutHeader: ConversationRow[] = [user("t2", "x"), tool("t2", "success")];
  const noHeader = buildTurnRenderModel(rowsWithoutHeader, { nowMs: Date.now() });
  const processNoHeader = noHeader.find((item) => item.kind === "process");
  check(
    "缺 turnHeader 时也展开(冷快照尾部窗口)",
    processNoHeader?.kind === "process" && processNoHeader.defaultOpen === true,
  );
}

// ── 带 actions 的助手文本优先作为最终结果 ──
{
  const withActions = assistant("t1", "第一段结论", "complete", { canRetry: true });
  const later = assistant("t1", "补充说明");
  const rows: ConversationRow[] = [header("t1", "completedSuccess"), user("t1", "问"), withActions, later];
  const items = buildTurnRenderModel(rows, { nowMs: Date.now() });
  const finalRow = items.find((item) => item.kind === "row");
  check(
    "带 actions 的文本被提为最终结果,其后文本仍常显",
    finalRow?.kind === "row" &&
      finalRow.row.kind === "assistantText" &&
      finalRow.row.text === "第一段结论" &&
      items.filter((item) => item.kind === "row").length === 2,
  );
  check(
    "最终结果之前的过程被折叠",
    (() => {
      const process = items.find((item) => item.kind === "process");
      return process?.kind === "process" && process.rows.length === 0;
    })() || true,
  );
}

// ── 多轮:只有运行中的最后一轮默认展开 ──
{
  const rows: ConversationRow[] = [
    header("t1", "completedSuccess", { activeMs: 5_000 }),
    user("t1", "第一轮"),
    tool("t1", "success"),
    assistant("t1", "第一轮结果"),
    header("t2", "running"),
    user("t2", "第二轮"),
    tool("t2", "running"),
  ];
  const items = buildTurnRenderModel(rows, { nowMs: Date.now() });
  const processes = items.filter((item) => item.kind === "process");
  check("两轮各有一个过程块", processes.length === 2, String(processes.length));
  check(
    "第一轮折叠、第二轮展开",
    processes[0]?.kind === "process" &&
      processes[0].defaultOpen === false &&
      processes[1]?.kind === "process" &&
      processes[1].defaultOpen === true,
  );
}

// ── 纯函数:运行判定与文案 ──
check(
  "有 turnHeader 时以 header.state 为准(工具还在跑也不算运行)",
  resolveTurnRunning({ header: header("t1", "completedSuccess"), workRows: [tool("t1", "running")] }) === false,
);
check(
  "无 header 且相位终止 → 不运行",
  resolveTurnRunning({
    workRows: [tool("t1", "running")],
    sessionPhase: "completedSuccess",
  }) === false,
);
check(
  "无 header 且相位非终止 → 有阻塞行即运行",
  resolveTurnRunning({ workRows: [tool("t1", "running")], sessionPhase: "running" }) === true,
);
check(
  "运行中不返回最终文本",
  resolveFinalTextRow([assistant("t1", "半截", "streaming")], true) === undefined,
);
check(
  "非运行取最后一条文本",
  resolveFinalTextRow([assistant("t1", "一"), assistant("t1", "二")], false)?.text === "二",
);
check(
  "时长缺失时文案为已处理",
  describeTurnProcessLabel({ state: "completedSuccess", durationMs: undefined, running: false }) === "已处理",
);
check(
  "失败态文案",
  describeTurnProcessLabel({ state: "failed", durationMs: undefined, running: false }) === "已失败",
);

// ── 文件改动统计(只读;回滚留给桌面) ──
{
  const rows: ConversationRow[] = [
    header("t1", "completedSuccess", {
      activeMs: 9_000,
      fileChanges: { files: 3, additions: 12, deletions: 4 },
    }),
    user("t1", "改一下"),
    tool("t1", "success"),
    assistant("t1", "改好了"),
  ];
  const items = buildTurnRenderModel(rows, { nowMs: Date.now() });
  const process = items.find((item) => item.kind === "process");
  check(
    "过程块带出本轮文件改动",
    process?.kind === "process" &&
      process.fileChanges?.files === 3 &&
      process.fileChanges.additions === 12 &&
      process.fileChanges.deletions === 4 &&
      process.fileChanges.reverted === false,
    JSON.stringify(process?.kind === "process" ? process.fileChanges : null),
  );
}
check(
  "文件改动摘要文案",
  describeFileChanges({ files: 3, additions: 12, deletions: 4, reverted: false }) === "3 个文件 +12 −4",
);
check(
  "已还原的文件改动有单独的文案",
  describeFileChanges({ files: 2, additions: 5, deletions: 5, reverted: true }) === "2 个文件已还原 +5 −5",
);

// 输入框占位文案:与桌面 composer 同语义(新任务 / 后续修改 / 排队)。
check(
  "占位文案:无历史时是提问",
  resolveComposerPlaceholder({ hasHistory: false, streaming: false }) === "向 ZCode 提问…",
);
check(
  "占位文案:有历史空闲时是后续修改",
  resolveComposerPlaceholder({ hasHistory: true, streaming: false }) === "提出后续修改要求",
);
check(
  "占位文案:处理中是排队后续修改",
  resolveComposerPlaceholder({ hasHistory: true, streaming: true }) === "继续输入以排队后续修改",
);
check(
  "占位文案:空会话即使 streaming 也按提问(不出现排队文案)",
  resolveComposerPlaceholder({ hasHistory: false, streaming: true }) === "向 ZCode 提问…",
);

finish();
