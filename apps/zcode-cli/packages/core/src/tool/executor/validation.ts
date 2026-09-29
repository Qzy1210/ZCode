import { CoreErrorType, createCoreError, isCoreError } from "@zcode/contracts";
import type { RuntimeInputValidationIssue } from "../input-normalization.js";
import {
  createInitialInputValidationModelContent,
  summarizeToolInputValidationIssues,
} from "../input-validation-model-content.js";
import { validateJsonSchemaValue } from "../json-schema.js";
import type { ToolInputValidationIssue } from "../tool-input-validation-issues.js";
import type { ToolEntry } from "../types.js";

const INITIAL_INPUT_VALIDATION_MODEL_CONTENT_KEY = "initialInputValidationModelContent";

export function validateOutput(output: unknown, entry: ToolEntry): void {
  const runtimeSchemaValidation = validateRuntimeSchema(output, entry.runtimeOutputSchema);
  if (runtimeSchemaValidation === true) return;
  if (Array.isArray(runtimeSchemaValidation)) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      "Tool output failed runtimeOutputSchema validation",
      {
        context: {
          errors: runtimeSchemaValidation.slice(0, 20),
          toolName: entry.metadata.name,
        },
        recoverable: false,
      },
    );
  }

  const validation = validateJsonSchemaValue(output, entry.outputSchema);
  if (validation.valid) return;

  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    "Tool output failed outputSchema validation",
    {
      context: {
        errors: validation.errors.slice(0, 20),
        toolName: entry.metadata.name,
      },
      recoverable: false,
    },
  );
}

function validateRuntimeSchema(output: unknown, schema: unknown): true | string[] | undefined {
  if (!isSafeParseSchema(schema)) return undefined;
  const parsed = schema.safeParse(output);
  if (parsed.success) return true;
  return parsed.error.issues.map((issue) => issue.message);
}

function isSafeParseSchema(schema: unknown): schema is {
  safeParse: (
    value: unknown,
  ) =>
    | { success: true; data: unknown }
    | { success: false; error: { issues: Array<{ message: string }> } };
} {
  return (
    typeof schema === "object" &&
    schema !== null &&
    "safeParse" in schema &&
    typeof (schema as { safeParse?: unknown }).safeParse === "function"
  );
}

export function validateInput(input: unknown, entry: ToolEntry): Error | undefined {
  const validation = validateJsonSchemaValue(input, entry.inputSchema);
  if (validation.valid) return undefined;

  return createInputValidationError(
    entry,
    validation.errors,
    undefined,
    validation.issues,
    isEmptyToolInput(input),
  );
}

/** 入参为空对象/undefined:调用整体没有携带参数,与"漏了某个字段"是不同的排查方向。 */
function isEmptyToolInput(input: unknown): boolean {
  if (input === undefined || input === null) return true;
  if (typeof input !== "object" || Array.isArray(input)) return false;
  return Object.keys(input).length === 0;
}

export function validateInitialModelToolInput(
  input: unknown,
  entry: ToolEntry,
  runtimeValidationIssues?: readonly RuntimeInputValidationIssue[],
): Error | undefined {
  const validation = validateJsonSchemaValue(input, entry.inputSchema);
  if (validation.valid) return undefined;

  const inputWasEmpty = isEmptyToolInput(input);
  // 模型原始参数的首次 schema 失败需要把具体问题回传给模型；Hook 或权限
  // 修改后的输入属于不同生命周期，不能复用这段 provider-visible 内容。
  const modelContent = createInitialInputValidationModelContent(
    entry,
    validation.issues,
    runtimeValidationIssues,
    { inputWasEmpty },
  );
  return createInputValidationError(
    entry,
    validation.errors,
    modelContent,
    validation.issues,
    inputWasEmpty,
  );
}

export function getInitialInputValidationModelContent(error: Error): string | undefined {
  if (!isCoreError(error) || error.type !== CoreErrorType.ToolExecutionFailed) {
    return undefined;
  }
  const modelContent = error.context?.[INITIAL_INPUT_VALIDATION_MODEL_CONTENT_KEY];
  return typeof modelContent === "string" ? modelContent : undefined;
}

export interface ToolInputValidationFacts {
  inputWasEmpty: boolean;
  issueCount: number;
}

/**
 * 读取输入校验失败时记录的事实(供遥测按工具计数与后续诊断):
 * 空入参拆成独立维度,用于区分"模型漏发参数"与普通缺字段/类型错误。
 * 仅对 createInputValidationError 构造的失败返回;其他 ToolExecutionFailed 返回 undefined。
 */
export function getInputValidationFacts(error: Error): ToolInputValidationFacts | undefined {
  if (!isCoreError(error) || error.type !== CoreErrorType.ToolExecutionFailed) {
    return undefined;
  }
  const inputWasEmpty = error.context?.inputWasEmpty;
  const issueCount = error.context?.issueCount;
  if (typeof inputWasEmpty !== "boolean" || typeof issueCount !== "number") {
    return undefined;
  }
  return { inputWasEmpty, issueCount };
}

function createInputValidationError(
  entry: ToolEntry,
  errors: string[],
  modelContent?: string,
  issues?: readonly ToolInputValidationIssue[],
  inputWasEmpty?: boolean,
): Error {
  // 正文附单行摘要:UI/日志能看到"哪个工具缺哪个参数"。
  // 失败频率与根因仍靠 errors/toolName(context)与遥测;这里只提升可读性,不改判定逻辑。
  const summary = issues
    ? summarizeToolInputValidationIssues(entry.metadata.name, issues)
    : undefined;
  const baseMessage = "Tool input failed inputSchema validation";
  return createCoreError(
    CoreErrorType.ToolExecutionFailed,
    summary === undefined ? baseMessage : `${baseMessage}: ${summary}`,
    {
      context: {
        errors: errors.slice(0, 20),
        toolName: entry.metadata.name,
        // 遥测计数维度:call-runner 经 getInputValidationFacts 读取后上报到工具 span。
        ...(inputWasEmpty === undefined ? {} : { inputWasEmpty }),
        ...(issues === undefined ? {} : { issueCount: issues.length }),
        ...(modelContent === undefined
          ? {}
          : { [INITIAL_INPUT_VALIDATION_MODEL_CONTENT_KEY]: modelContent }),
      },
      recoverable: true,
    },
  );
}
