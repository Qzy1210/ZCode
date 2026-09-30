/* 草稿级模型/模式/思考级别选择:纯函数(选项表、展示标签、发送载荷)。
 *
 * 与桌面 composer 同语义:选择只随"下一次发送"提交(payload 的
 * modelSelection/mode/planEnabled),不立即改会话级配置。
 */
import type { ModelSelection } from "@zcode/shared/model-selection";
import type {
  CommandPayloadMap,
  SessionUsageState,
} from "@zcode/shared/zcode-protocol-v4";

export type SubmissionMode = NonNullable<CommandPayloadMap["sendText"]["mode"]>;

/** 权限模式候选(与 submissionModeSchema 同源;plan 由独立开关表达,不在此列)。 */
export const PERMISSION_MODE_OPTIONS: ReadonlyArray<{
  value: Exclude<SubmissionMode, "plan">;
  label: string;
  description: string;
}> = [
  { value: "build", label: "改前询问", description: "每次改文件前询问" },
  { value: "edit", label: "自动编辑", description: "自动编辑相关文件,命令仍需确认" },
  { value: "yolo", label: "完全放行", description: "减少确认,编辑与命令都放行" },
];

/**
 * 思考级别(value → 中文档位)。取值是 provider 自己声明的字符串,
 * 表里没有的原样显示(与桌面 thoughtLevelLabelId 同一张表的可见子集)。
 */
const THOUGHT_LEVEL_LABELS: Record<string, string> = {
  disabled: "关闭",
  false: "关闭",
  no: "关闭",
  none: "关闭",
  nothink: "关闭",
  "no-think": "关闭",
  no_think: "关闭",
  off: "关闭",
  enable: "开启",
  enabled: "开启",
  on: "开启",
  true: "开启",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  "extra-high": "很高",
  extra_high: "很高",
  xhigh: "很高",
  max: "最高",
  ultra: "最高",
};

export function thoughtLevelLabel(value: string | undefined): string {
  if (!value || value.trim().length === 0) return "默认";
  const normalized = value.trim().toLowerCase();
  return THOUGHT_LEVEL_LABELS[normalized] ?? value;
}

export interface DraftConfig {
  /** 用户在本机草稿里选的模型;空表示"沿用会话当前模型"。 */
  model?: ModelSelection;
  /** 用户选的权限模式;空表示沿用会话当前模式。 */
  mode?: Exclude<SubmissionMode, "plan">;
  /** 计划模式开关;undefined 表示沿用会话当前值。 */
  planEnabled?: boolean;
  /** 思考级别(provider 声明的值);空表示沿用会话当前值。 */
  reasoningLevel?: string;
}

export interface SessionConfigLike {
  provider?: string;
  model?: string;
  thought?: string;
  /** 当前模型可用的思考档位(provider 声明;空表示不支持)。 */
  thoughtLevels?: readonly string[];
  planEnabled?: boolean;
  mode?: string;
  modelSelection?: ModelSelection;
}

export function modeLabel(mode: string | undefined): string {
  const found = PERMISSION_MODE_OPTIONS.find((option) => option.value === mode);
  return found?.label ?? mode ?? "改前询问";
}

/** 会话当前模型的可读名(优先 modelSelection,退回 provider/model)。 */
export function modelLabel(config: SessionConfigLike | null | undefined): string {
  if (!config) return "默认模型";
  const selection = (config as { modelSelection?: ModelSelection }).modelSelection;
  if (selection?.modelId) return selection.modelId;
  if (config.model) return config.model;
  return "默认模型";
}

/** 头部展示用:模型 + 模式 + 计划 + 思考级别(把草稿覆盖叠在会话配置上)。 */
export function describeDraftSummary(
  config: SessionConfigLike | null | undefined,
  draft: DraftConfig,
): { model: string; mode: string; planOn: boolean; thought: string; thoughtLevels: readonly string[] } {
  const effectiveModel = draft.model?.modelId ?? modelLabel(config);
  const effectiveMode = draft.mode ?? config?.mode ?? "build";
  const planOn = draft.planEnabled ?? config?.planEnabled === true;
  const effectiveThought = draft.reasoningLevel ?? config?.thought;
  return {
    model: effectiveModel,
    mode: planOn ? "计划模式" : modeLabel(String(effectiveMode)),
    planOn,
    thought: thoughtLevelLabel(effectiveThought),
    thoughtLevels: config?.thoughtLevels ?? [],
  };
}

/** 会话当前模型(发送思考级别时需要它补齐 modelSelection)。 */
export function resolveBaseModel(
  config: SessionConfigLike | null | undefined,
): { providerId: string; modelId: string } | null {
  const selection = config?.modelSelection;
  if (selection?.providerId && selection.modelId) {
    return { providerId: selection.providerId, modelId: selection.modelId };
  }
  if (config?.provider && config.model) {
    return { providerId: config.provider, modelId: config.model };
  }
  return null;
}

/**
 * 发送时随 payload 提交的字段(未选择则不下发,由 CLI 取会话当前值)。
 *
 * 思考级别住在 `modelSelection.options.reasoningLevel`:只改档位时要用 base
 * (会话当前模型)补齐 provider/model——协议没有独立的档位字段。
 */
export function buildSendOptions(
  draft: DraftConfig,
  base?: { providerId: string; modelId: string } | null,
): {
  modelSelection?: ModelSelection;
  mode?: Exclude<SubmissionMode, "plan">;
  planEnabled?: boolean;
} {
  const effectiveModel = draft.model ?? base ?? null;
  const modelSelection: ModelSelection | undefined =
    effectiveModel && (draft.model || draft.reasoningLevel)
      ? {
          providerId: effectiveModel.providerId,
          modelId: effectiveModel.modelId,
          ...(draft.reasoningLevel
            ? { options: { reasoningLevel: draft.reasoningLevel } }
            : {}),
        }
      : undefined;
  return {
    ...(modelSelection ? { modelSelection } : {}),
    ...(draft.mode ? { mode: draft.mode } : {}),
    ...(draft.planEnabled !== undefined ? { planEnabled: draft.planEnabled } : {}),
  };
}

/** 上下文用量概要:供"上下文还剩多少"展示(null = 还没有用量事实)。 */
export interface ContextUsageSummary {
  usedTokens: number;
  maxTokens: number;
  /** 剩余可用比例(0-100,整数;丢弃的余量按向下取整显示更保守)。 */
  remainingPercent: number;
  /** 距自动压缩阈值的剩余 token(autoCompactThresholdTokens 缺失时为 null)。 */
  tokensUntilAutoCompact: number | null;
}

export function describeContextUsage(
  usage: SessionUsageState | null | undefined,
): ContextUsageSummary | null {
  const contextWindow = usage?.contextWindow ?? null;
  if (!contextWindow || contextWindow.maxTokens <= 0) return null;
  const used = Math.max(0, contextWindow.usedTokens);
  const max = contextWindow.maxTokens;
  const remainingPercent = Math.max(0, Math.min(100, Math.floor(((max - used) / max) * 100)));
  const threshold = contextWindow.autoCompactThresholdTokens;
  return {
    usedTokens: used,
    maxTokens: max,
    remainingPercent,
    tokensUntilAutoCompact:
      typeof threshold === "number" ? Math.max(0, threshold - used) : null,
  };
}

/** 千分位 token 数,便于阅读(12345 → 12,345)。 */
export function formatTokenCount(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * 输入框占位文案:与桌面 composer 同语义(chat.placeholder.*)——
 * 无历史 → 提问;有历史空闲 → 提出后续修改要求;处理中 → 排队后续修改。
 * 纯函数:判定与文案可被用例覆盖(渲染层只消费结果)。
 */
export function resolveComposerPlaceholder(input: {
  hasHistory: boolean;
  streaming: boolean;
}): string {
  if (!input.hasHistory) return "向 ZCode 提问…";
  return input.streaming ? "继续输入以排队后续修改" : "提出后续修改要求";
}

export interface ModelOption {
  providerId: string;
  modelId: string;
  label: string;
  group: string;
}

/** 把 modelSelectionService 的视图拍平成可选项(只列有模型的 provider)。 */
export function flattenModelOptions(view: {
  providers?: ReadonlyArray<{
    providerId: string;
    // 服务端用 null 表示"无展示名",这里统一按缺失处理。
    providerName?: string | null;
    models?: ReadonlyArray<{ modelId: string }>;
  }>;
}): ModelOption[] {
  const options: ModelOption[] = [];
  for (const provider of view.providers ?? []) {
    const group = provider.providerName ?? provider.providerId;
    for (const model of provider.models ?? []) {
      options.push({
        providerId: provider.providerId,
        modelId: model.modelId,
        label: model.modelId,
        group,
      });
    }
  }
  return options;
}
