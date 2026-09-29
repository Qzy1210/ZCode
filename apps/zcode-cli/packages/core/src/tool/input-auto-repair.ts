import type { Logger } from "@zcode/contracts";
import { validateJsonSchemaValue } from "./json-schema.js";
import type { ToolEntry } from "./types.js";

/**
 * 工具入参自动修复层(模型原始输入,permission 之前)。
 *
 * 边界原则(与 input-normalization 的 JSON 字符串解包同属一类"无害可逆变换"):
 * - 只做两类修复:剥离 strict schema 拒绝的意外字段;无损标量强转(string↔number↔boolean)。
 * - 不造内容:缺必填参数/空入参不修(机器不能编造模型意图),继续走回传模型路径。
 * - 修复不是放行:修复后必须重新校验,仍失败则放弃修复结果,走原失败路径。
 * - 修复动作记 warn 级日志,便于观察模型高频失误形态,反向定位 provider/提示词问题。
 */

export interface AutoRepairResult {
  input: unknown;
  repaired: boolean;
  /** 修复动作摘要(日志/遥测用,如 "stripped unexpected keys: foo" )。 */
  actions: string[];
}

/** 意外字段键名(修复依据来自 unrecognized_keys issue,而非重新猜测 schema)。 */
function collectUnrecognizedKeys(issues: readonly { code: string; keys?: string[] }[]): string[] {
  return issues.flatMap((issue) => (issue.code === "unrecognized_keys" ? issue.keys ?? [] : []));
}

/**
 * 无损标量强转:只接受"往返一致"的转换,避免把 "abc" 转成 NaN、把 "1e3" 转出精度问题。
 * schema 期望的类型从 issue.expected 读取(zod 风格小写类型名)。
 */
function coerceScalarLossless(value: unknown, expected: string): { ok: true; value: unknown } | { ok: false } {
  if (expected === "string") {
    if (typeof value === "number" && Number.isFinite(value)) {
      const coerced = String(value);
      // 123 → "123" 可往返;但 1e21 → "1e+21" 解析回来仍相等,允许。
      return { ok: true, value: coerced };
    }
    if (typeof value === "boolean") return { ok: true, value: value ? "true" : "false" };
    return { ok: false };
  }
  if (expected === "number" || expected === "int") {
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      const coerced = Number(value);
      if (expected === "int" && !Number.isInteger(coerced)) return { ok: false };
      return { ok: true, value: coerced };
    }
    if (typeof value === "boolean" && expected === "number") {
      return { ok: true, value: value ? 1 : 0 };
    }
    return { ok: false };
  }
  if (expected === "boolean") {
    if (value === "true") return { ok: true, value: true };
    if (value === "false") return { ok: true, value: false };
    return { ok: false };
  }
  return { ok: false };
}

function setAtPath(target: Record<string, unknown>, path: (string | number)[], value: unknown): void {
  let cursor: Record<string, unknown> | unknown[] = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    if (segment === undefined) return;
    const next = (cursor as Record<string, unknown>)[segment];
    if (typeof next !== "object" || next === null) return;
    cursor = next as Record<string, unknown>;
  }
  const leaf = path[path.length - 1];
  if (leaf === undefined) return;
  (cursor as Record<string, unknown>)[leaf] = value;
}

/**
 * 尝试自动修复工具入参。返回 repaired=false 表示不适用或修复后仍不合法,
 * 调用方继续原输入的失败路径;repaired=true 时 input 为修复后的新值。
 */
export function autoRepairToolInput(
  entry: ToolEntry,
  input: unknown,
  logger?: Logger,
): AutoRepairResult {
  const actions: string[] = [];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { input, repaired: false, actions };
  }

  const firstValidation = validateJsonSchemaValue(input, entry.inputSchema);
  if (firstValidation.valid) {
    return { input, repaired: false, actions };
  }

  let repairedInput: Record<string, unknown> = { ...(input as Record<string, unknown>) };

  // 修复 1:剥离 strict schema 拒绝的意外字段(模型常见:发别名/旧字段名)。
  const unrecognizedKeys = collectUnrecognizedKeys(firstValidation.issues);
  if (unrecognizedKeys.length > 0) {
    for (const key of unrecognizedKeys) {
      delete repairedInput[key];
    }
    actions.push(`stripped unexpected keys: ${unrecognizedKeys.join(", ")}`);
  }

  // 修复 2:对剩余 invalid_type(排除 undefined 缺失)做无损标量强转。
  const typeIssues = firstValidation.issues.filter(
    (issue) =>
      issue.code === "invalid_type" &&
      !issue.message.includes("received undefined") &&
      issue.path.length > 0,
  );
  for (const issue of typeIssues) {
    if (issue.code !== "invalid_type") continue;
    const current = getPathValue(repairedInput, issue.path);
    const result = coerceScalarLossless(current, issue.expected);
    if (result.ok) {
      setAtPath(repairedInput, issue.path, result.value);
      actions.push(`coerced ${issue.path.join(".")} to ${issue.expected}`);
    }
  }

  if (actions.length === 0) {
    return { input, repaired: false, actions };
  }

  // 修复不是放行:重校验必须通过,否则丢弃修复结果。
  const reValidation = validateJsonSchemaValue(repairedInput, entry.inputSchema);
  if (!reValidation.valid) {
    return { input, repaired: false, actions };
  }

  logger?.warn("Tool input auto-repaired", {
    event: "tool.input.auto_repaired",
    module: "core.tool.input-auto-repair",
    toolName: entry.metadata.name,
    actions,
  });
  return { input: repairedInput, repaired: true, actions };
}

function getPathValue(target: Record<string, unknown>, path: (string | number)[]): unknown {
  let cursor: unknown = target;
  for (const segment of path) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}
