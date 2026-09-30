/* 会话行的"轮"分组与过程收敛:纯函数,决定"什么常显、什么折叠成一行"。
 *
 * 与桌面端保持一致的规则(packages/ui/src/v4/conversationTurnRenderUnits.ts +
 * conversationTurnWorkSegments.ts 的精简版):
 * - 按 turnId 分组;进行中的最后一轮展开(流式正文与运行中的工具都在明面上);
 * - 已完成的轮:最终助手正文常显,其余过程(思考/工具/子代理)折叠成一行
 *   「已工作 N 秒 / 已处理 / 已停止」,点开可看;
 * - 中断/失败的轮强制展开(用户需要看到发生了什么);
 * - 没有最终正文时不折叠(否则整轮内容都被藏起来)。
 *
 * 只依赖 shared 的行类型,不碰 UI:便于用脚本覆盖判定规则。
 */
import type {
  AssistantTextRow,
  ConversationRow,
  SessionPhase,
  TurnHeaderRow,
} from "@zcode/shared/zcode-protocol-v4";

const ABNORMAL_TURN_STATES = new Set(["completedInterrupted", "failed"]);

/** 参与"过程"的助手行(用户输入/轮头/hook 之外的一切)。 */
export type AssistantWorkRow = Exclude<ConversationRow, { kind: "turnHeader" } | { kind: "userInput" }>;

export type TurnRenderItem =
  | { kind: "user"; key: string; row: Extract<ConversationRow, { kind: "userInput" }> }
  | { kind: "row"; key: string; row: ConversationRow }
  | {
      kind: "process";
      key: string;
      turnId: string;
      rows: AssistantWorkRow[];
      /** 折叠行文案(含时长)。 */
      label: string;
      /** 本轮文件改动统计(turnHeader.fileChanges):完成后一眼看到"改了几个文件"。 */
      fileChanges?: { files: number; additions: number; deletions: number; reverted: boolean };
      /** 默认是否展开;用户手动切换后以手动值为准。 */
      defaultOpen: boolean;
    };

export interface TurnRenderOptions {
  /** 当前时间:驱动"工作中 N 秒"。 */
  nowMs: number;
  /** 会话相位:冷快照缺 turnHeader 时判断轮是否还在跑。 */
  sessionPhase?: SessionPhase;
  /** 是否最后一轮(决定运行中的轮是否默认展开)。 */
  isLastChecked?: (turnId: string) => boolean;
}

function isRunningWorkRow(row: ConversationRow): boolean {
  if (row.kind === "assistantText" || row.kind === "reasoning") return row.state === "streaming";
  if (row.kind === "toolCall") {
    return (
      row.status === "running" || row.status === "pendingApproval" || row.status === "inputStreaming"
    );
  }
  if (row.kind === "subagent") return row.status === "running";
  return false;
}

/** 与桌面 resolveTurnRunning 同口径:有 turnHeader 时以它为准。 */
export function resolveTurnRunning(input: {
  header?: TurnHeaderRow;
  workRows: readonly AssistantWorkRow[];
  sessionPhase?: SessionPhase;
}): boolean {
  if (input.header) return input.header.state === "running";
  if (
    input.sessionPhase === "completedSuccess" ||
    input.sessionPhase === "completedInterrupted" ||
    input.sessionPhase === "error"
  ) {
    return false;
  }
  return input.workRows.some((row) => isRunningWorkRow(row));
}

/** 最终正文:带 actions 的 assistantText 优先;否则(非运行中)取最后一个 assistantText。 */
export function resolveFinalTextRow(
  workRows: readonly AssistantWorkRow[],
  running: boolean,
): AssistantTextRow | undefined {
  const texts = workRows.filter((row): row is AssistantTextRow => row.kind === "assistantText");
  const withActions = texts.find((row) => row.actions?.canFork === true || row.actions?.canRetry === true);
  if (withActions) return withActions;
  if (running) return undefined;
  return texts.length > 0 ? texts[texts.length - 1] : undefined;
}

export function describeTurnProcessLabel(input: {
  state: TurnHeaderRow["state"] | undefined;
  durationMs: number | undefined;
  running: boolean;
}): string {
  if (input.running) {
    return input.durationMs !== undefined
      ? `工作中 ${Math.max(1, Math.round(input.durationMs / 1000))} 秒`
      : "工作中…";
  }
  if (input.state === "completedInterrupted") return "已停止";
  if (input.state === "failed") return "已失败";
  if (input.durationMs !== undefined) {
    return `已工作 ${Math.max(1, Math.round(input.durationMs / 1000))} 秒`;
  }
  return "已处理";
}

/** 文件改动摘要:只读展示,回滚留给桌面(破坏性 + CAS 行目标命令)。 */
export function describeFileChanges(fileChanges: {
  files: number;
  additions: number;
  deletions: number;
  reverted: boolean;
}): string {
  const head = fileChanges.reverted
    ? `${fileChanges.files} 个文件已还原`
    : `${fileChanges.files} 个文件`;
  return `${head} +${fileChanges.additions} −${fileChanges.deletions}`;
}

function resolveDurationMs(header: TurnHeaderRow | undefined, running: boolean, nowMs: number): number | undefined {
  if (!header) return undefined;
  if (header.activeMs !== undefined) return header.activeMs;
  if (header.endedAt !== undefined) return Math.max(0, header.endedAt - header.createdAt);
  return running ? Math.max(0, nowMs - header.createdAt) : undefined;
}

/**
 * 把窗口内的行组织成渲染项(顺序保持:用户输入 → 过程折叠块 → 最终正文 → 后续行)。
 */
export function buildTurnRenderModel(
  rows: readonly ConversationRow[],
  options: TurnRenderOptions,
): TurnRenderItem[] {
  const items: TurnRenderItem[] = [];
  // 按出现顺序收集每个 turn 的行(窗口是 rowId 升序,turn 顺序天然正确)。
  const order: string[] = [];
  const groups = new Map<
    string,
    {
      header?: TurnHeaderRow;
      userInputs: Array<Extract<ConversationRow, { kind: "userInput" }>>;
      work: AssistantWorkRow[];
      extras: ConversationRow[];
    }
  >();

  for (const row of rows) {
    let group = groups.get(row.turnId);
    if (!group) {
      group = { userInputs: [], work: [], extras: [] };
      groups.set(row.turnId, group);
      order.push(row.turnId);
    }
    if (row.kind === "turnHeader") {
      group.header = row;
    } else if (row.kind === "userInput") {
      group.userInputs.push(row);
    } else if (row.kind === "hookInvocation") {
      // hook 行与工具/思考不同:它是准入事件,保持单行展示(不折叠)。
      group.extras.push(row);
    } else {
      group.work.push(row);
    }
  }

  const lastTurnId = order.length > 0 ? order[order.length - 1] : null;
  const isLastTurn = options.isLastChecked ?? ((turnId: string) => turnId === lastTurnId);

  for (const turnId of order) {
    const group = groups.get(turnId);
    if (!group) continue;
    for (const row of group.userInputs) {
      items.push({ kind: "user", key: `user:${row.rowId}`, row });
    }
    for (const row of group.extras) {
      items.push({ kind: "row", key: `row:${row.rowId}`, row });
    }
    if (group.work.length === 0) continue;

    const running = resolveTurnRunning({
      ...(group.header ? { header: group.header } : {}),
      workRows: group.work,
      ...(options.sessionPhase ? { sessionPhase: options.sessionPhase } : {}),
    });
    const finalText = resolveFinalTextRow(group.work, running);
    const finalIndex = finalText ? group.work.indexOf(finalText) : -1;
    const historyRows = finalIndex >= 0 ? group.work.slice(0, finalIndex) : group.work;
    const followingRows = finalIndex >= 0 ? group.work.slice(finalIndex + 1) : [];
    const durationMs = resolveDurationMs(group.header, running, options.nowMs);

    if (historyRows.length > 0) {
      const abnormal = group.header ? ABNORMAL_TURN_STATES.has(group.header.state) : false;
      const defaultOpen =
        (running && isLastTurn(turnId)) ||
        abnormal ||
        finalText === undefined ||
        group.header === undefined;
      const fileChanges = group.header?.fileChanges;
      items.push({
        kind: "process",
        key: `process:${turnId}:${historyRows[0]!.rowId}`,
        turnId,
        rows: historyRows,
        label: describeTurnProcessLabel({
          state: group.header?.state,
          durationMs,
          running,
        }),
        defaultOpen,
        ...(fileChanges
          ? {
              fileChanges: {
                files: fileChanges.files,
                additions: fileChanges.additions,
                deletions: fileChanges.deletions,
                reverted: fileChanges.state === "reverted",
              },
            }
          : {}),
      });
    }
    if (finalText) {
      items.push({ kind: "row", key: `row:${finalText.rowId}`, row: finalText });
    }
    for (const row of followingRows) {
      items.push({ kind: "row", key: `row:${row.rowId}`, row });
    }
  }

  return items;
}
