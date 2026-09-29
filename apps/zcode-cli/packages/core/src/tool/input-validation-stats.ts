import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * 工具入参校验失败的本地统计(只落盘,不上报)。
 *
 * 目的:给"减少该错误"的优化提供本地依据——
 * - 按工具统计失败次数,识别高频失误工具;
 * - empty 单独计数(入参完全为空,疑似流式截断/模型漏发),与普通缺字段区分;
 * - autoRepaired 记录自动修复层已尝试修复但校验仍未通过的回数(修复救不回该调用)。
 *
 * 文件位置与设备身份状态文件同目录(`$ZCODE_HOME/v2` 或 `~/.zcode/v2`):
 *   tool-input-validation-stats.json
 *
 * 可靠性策略:诊断用途,任何 fs 异常都静默降级,绝不影响工具执行主链路;
 * 进程内串行 + 临时文件原子替换,避免读到半截 JSON。跨进程并发(多窗口多 Host)
 * 下极端同时写可能丢失个别增量,对该诊断统计可接受,不引入锁文件及其残留风险。
 */

export interface ToolInputValidationFailureDetail {
  toolName: string;
  /** 入参完全为空(undefined/null/空对象)。 */
  inputWasEmpty: boolean;
  /** 校验问题条数(原始计数)。 */
  issueCount: number;
  /** 自动修复层是否已应用过变换(修后仍失败)。 */
  autoRepaired: boolean;
}

interface ToolInputValidationCounters {
  failures: number;
  empty: number;
  autoRepaired: number;
  issueCount: number;
}

export interface ToolInputValidationStats {
  version: 1;
  createdAt: string;
  updatedAt: string;
  total: ToolInputValidationCounters;
  byTool: Record<string, ToolInputValidationCounters>;
}

const STATS_FILE_NAME = "tool-input-validation-stats.json";

/** 解析统计文件位置:与 telemetry-state.json 同目录(仓库统一约定)。 */
export function resolveToolInputValidationStatsFile(
  env: Record<string, string | undefined> = process.env,
): string {
  const zcodeHome = env.ZCODE_HOME?.trim();
  return zcodeHome
    ? join(zcodeHome, "v2", STATS_FILE_NAME)
    : join(homedir(), ".zcode", "v2", STATS_FILE_NAME);
}

function emptyCounters(): ToolInputValidationCounters {
  return { failures: 0, empty: 0, autoRepaired: 0, issueCount: 0 };
}

function readCounters(value: unknown): ToolInputValidationCounters | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const failures = record.failures;
  const empty = record.empty;
  const autoRepaired = record.autoRepaired;
  const issueCount = record.issueCount;
  if (
    typeof failures !== "number" ||
    typeof empty !== "number" ||
    typeof autoRepaired !== "number" ||
    typeof issueCount !== "number"
  ) {
    return undefined;
  }
  return { failures, empty, autoRepaired, issueCount };
}

async function readExistingStats(file: string): Promise<ToolInputValidationStats | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1) return undefined;
    const total = readCounters(record.total);
    if (!total || typeof record.byTool !== "object" || record.byTool === null) return undefined;
    const byTool: Record<string, ToolInputValidationCounters> = {};
    for (const [tool, counters] of Object.entries(record.byTool as Record<string, unknown>)) {
      const parsedCounters = readCounters(counters);
      if (parsedCounters) byTool[tool] = parsedCounters;
    }
    return {
      version: 1,
      createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
      total,
      byTool,
    };
  } catch {
    // 文件缺失/损坏时从零开始:诊断统计允许重置,不为此引入修复分支。
    return undefined;
  }
}

async function applyUpdate(
  file: string,
  detail: ToolInputValidationFailureDetail,
  now: () => Date,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const timestamp = now().toISOString();
  const stats = (await readExistingStats(file)) ?? {
    version: 1 as const,
    createdAt: timestamp,
    updatedAt: timestamp,
    total: emptyCounters(),
    byTool: {},
  };
  const toolCounters = stats.byTool[detail.toolName] ?? emptyCounters();
  stats.byTool[detail.toolName] = toolCounters;
  for (const counters of [stats.total, toolCounters]) {
    counters.failures += 1;
    if (detail.inputWasEmpty) counters.empty += 1;
    if (detail.autoRepaired) counters.autoRepaired += 1;
    counters.issueCount += detail.issueCount;
  }
  stats.updatedAt = timestamp;
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(stats, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

// 进程内串行链:并发失败事件按到达顺序依次读改写,避免互相覆盖。
let writeChain: Promise<void> = Promise.resolve();

/**
 * 记录一次输入校验失败(异步落盘,调用方不等待、不处理错误)。
 * options 仅用于测试:注入 env / 文件路径 / 时钟。
 */
export function recordToolInputValidationFailure(
  detail: ToolInputValidationFailureDetail,
  options?: {
    env?: Record<string, string | undefined>;
    filePath?: string;
    now?: () => Date;
  },
): void {
  const file = options?.filePath ?? resolveToolInputValidationStatsFile(options?.env);
  const now = options?.now ?? (() => new Date());
  writeChain = writeChain.then(() =>
    applyUpdate(file, detail, now).catch(() => {
      // 统计写盘失败不影响工具执行;下一次失败会再次尝试。
    }),
  );
}
