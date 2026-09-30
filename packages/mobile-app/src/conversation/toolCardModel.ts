/* 工具卡片模型:把一行 toolCall 变成"折叠摘要 + 可展开正文"。
 *
 * 数据来源优先级(与桌面 toolCallRowAdapter 一致):
 *   row.error → row.output.display(全量 16 种,含 bash_output/file_diff)
 *   → row.display(白名单 11 种)→ 运行中 Bash 的 outputPreview
 *   → output.text → input / inputText(流式期用 shared 的半截 JSON 解析)
 *
 * 纯函数:不碰 UI,便于脚本覆盖(截断、取值优先级、diff 行前缀都容易写错)。
 */
import { buildZCodeStreamingToolInputPreview } from "@zcode/shared";
import type {
  ToolCallDisplay,
  ToolCallRow,
  ToolResultDisplay,
} from "@zcode/shared/zcode-protocol-v4";

const SUMMARY_MAX_CHARS = 80;
const DETAIL_MAX_CHARS = 160;
const BODY_MAX_LINES = 40;
const BODY_MAX_CHARS = 2_000;
const DIFF_MAX_LINES = 60;

export interface ToolCardModel {
  /** 折叠态第一行:命令/文件名/查询词等"这一步在做什么"。 */
  summary: string;
  /** 折叠态第二行:输出末尾预览或统计,可为空。 */
  detail?: string;
  /** 展开态正文(已按行截断)。 */
  body?: string;
  /** 正文语义:diff 需要按 +/-/空格上色。 */
  bodyKind?: "diff" | "text";
  /** 截断提示(读 schema 的 truncated 字段,不靠字数猜)。 */
  truncatedNote?: string;
  /** 错误文本,优先于正文显示。 */
  errorText?: string;
  /** 只有摘要没有正文时,卡片不可展开。 */
  expandable: boolean;
}

function compact(text: string): string {
  return text.trim().replace(/\s+/gu, " ");
}

function clip(text: string, maxChars: number): string {
  const value = text.trim();
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

function firstLine(text: string): string {
  const index = text.indexOf("\n");
  return index < 0 ? text : text.slice(0, index);
}

function tailLines(text: string, count: number, maxChars: number): string {
  const lines = text.trimEnd().split("\n");
  return clip(lines.slice(Math.max(0, lines.length - count)).join(" "), maxChars);
}

function countNonEmptyLines(text: string): number {
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}

function boundBody(text: string, maxLines: number): { body: string; clipped: boolean } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { body: "", clipped: false };
  const lines = trimmed.split("\n");
  const byLines = lines.length > maxLines ? lines.slice(0, maxLines).join("\n") : trimmed;
  const clippedByLines = lines.length > maxLines;
  const clippedByChars = byLines.length > BODY_MAX_CHARS;
  return {
    body: clippedByChars ? `${byLines.slice(0, BODY_MAX_CHARS)}…` : byLines,
    clipped: clippedByLines || clippedByChars,
  };
}

function fileBasename(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

/** 结构化入参读取(input 是 unknown,流式期只有半截 inputText)。 */
function readInput(row: ToolCallRow): Record<string, unknown> {
  if (row.input !== undefined && typeof row.input === "object" && row.input !== null) {
    return row.input as Record<string, unknown>;
  }
  const preview = buildZCodeStreamingToolInputPreview(row.inputText ?? "");
  return typeof preview.input === "object" && preview.input !== null
    ? (preview.input as Record<string, unknown>)
    : {};
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function pickDisplay(row: ToolCallRow): ToolCallDisplay | ToolResultDisplay | undefined {
  // 全量结果 display 优先:bash_output / file_diff 只存在于 output.display。
  return row.output?.display ?? row.display;
}

function diffBodyFrom(display: Extract<ToolResultDisplay, { kind: "file_diff" }>): string {
  const chunks: string[] = [];
  for (const hunk of display.structuredPatch) {
    chunks.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    chunks.push(...hunk.lines);
  }
  return chunks.join("\n");
}

function commandOf(input: Record<string, unknown>): string | undefined {
  return readString(input, "command") ?? readString(input, "cmd");
}

function toolFamily(toolName: string): "bash" | "fileWrite" | "fileRead" | "search" | "agent" | "other" {
  const name = toolName.toLowerCase();
  if (name === "bash" || name.includes("shell")) return "bash";
  if (name === "write" || name === "edit" || name === "applypatch" || name === "notebookedit") {
    return "fileWrite";
  }
  if (name === "read" || name === "notebookread") return "fileRead";
  if (["grep", "glob", "webfetch", "websearch", "web_search", "ls"].includes(name)) return "search";
  if (name === "agent" || name === "task") return "agent";
  return "other";
}

export function buildToolCardModel(row: ToolCallRow): ToolCardModel {
  const input = readInput(row);
  const display = pickDisplay(row);
  const errorText = row.error ? `${row.error.code}: ${row.error.message}` : undefined;
  const outputText = row.output?.text ?? "";
  const family = toolFamily(row.toolName);

  // ── 文件编辑:diff 是唯一能说明"改了什么"的东西 ──
  if (display?.kind === "file_diff") {
    const bounded = boundBody(diffBodyFrom(display), DIFF_MAX_LINES);
    const file = fileBasename(display.filePath);
    return {
      summary: `${file}  +${display.additions} −${display.deletions}`,
      ...(errorText ? { errorText } : {}),
      ...(bounded.body ? { body: bounded.body, bodyKind: "diff" as const } : {}),
      ...(display.truncated || bounded.clipped ? { truncatedNote: "diff 已截断" } : {}),
      expandable: bounded.body.length > 0,
    };
  }

  // ── Bash:命令 + 输出(运行中优先 outputPreview) ──
  if (family === "bash") {
    const command = commandOf(input) ?? compact(row.inputText ?? "");
    const running = row.status === "running" || row.status === "inputStreaming";
    const bodySource =
      (running ? row.outputPreview?.fullText ?? row.outputPreview?.text : undefined) ??
      (display?.kind === "bash_output" ? display.output : undefined) ??
      outputText;
    const bounded = boundBody(bodySource, BODY_MAX_LINES);
    const outputTail = tailLines(bodySource, 2, DETAIL_MAX_CHARS);
    const truncated =
      display?.kind === "bash_output" && display.truncated
        ? display.outputPath
          ? `输出已截断(完整内容:${fileBasename(display.outputPath)})`
          : "输出已截断"
        : row.output?.truncated
          ? "输出已截断"
          : undefined;
    return {
      summary: clip(firstLine(command), SUMMARY_MAX_CHARS) || row.toolName,
      ...(outputTail ? { detail: outputTail } : {}),
      ...(errorText ? { errorText } : {}),
      ...(bounded.body ? { body: bounded.body, bodyKind: "text" as const } : {}),
      ...(truncated ? { truncatedNote: truncated } : {}),
      expandable: bounded.body.length > 0,
    };
  }

  // ── 读取文件:文件名 + 行范围 + 行数 ──
  if (family === "fileRead") {
    const filePath = readString(input, "file_path") ?? readString(input, "path") ?? "";
    const offset = input.offset;
    const limit = input.limit;
    const range =
      typeof offset === "number"
        ? `第 ${offset} 行起${typeof limit === "number" ? ` · ${limit} 行` : ""}`
        : undefined;
    const bounded = boundBody(outputText, 30);
    return {
      summary: `${fileBasename(filePath) || row.toolName}${range ? ` · ${range}` : ""}`,
      ...(outputText ? { detail: `返回 ${countNonEmptyLines(outputText)} 行` } : {}),
      ...(errorText ? { errorText } : {}),
      ...(bounded.body ? { body: bounded.body, bodyKind: "text" as const } : {}),
      ...(bounded.clipped ? { truncatedNote: "内容已截断" } : {}),
      expandable: bounded.body.length > 0,
    };
  }

  // ── 搜索:查询词 + 命中行数 ──
  if (family === "search") {
    const query =
      readString(input, "pattern") ??
      readString(input, "query") ??
      readString(input, "url") ??
      readString(input, "path") ??
      "";
    const bounded = boundBody(outputText, 20);
    const hits = countNonEmptyLines(outputText);
    return {
      summary: clip(query, SUMMARY_MAX_CHARS) || row.toolName,
      ...(outputText ? { detail: `命中 ${hits} 行` } : {}),
      ...(errorText ? { errorText } : {}),
      ...(bounded.body ? { body: bounded.body, bodyKind: "text" as const } : {}),
      ...(bounded.clipped ? { truncatedNote: "结果已截断" } : {}),
      expandable: bounded.body.length > 0,
    };
  }

  // ── 子代理:描述 + 提示词/结果头部 ──
  if (family === "agent") {
    const description = readString(input, "description") ?? readString(input, "subagent_type") ?? "";
    const bounded = boundBody(
      [readString(input, "prompt") ?? "", outputText].filter((part) => part.length > 0).join("\n\n"),
      24,
    );
    return {
      summary: clip(description, SUMMARY_MAX_CHARS) || row.toolName,
      ...(outputText ? { detail: tailLines(outputText, 2, DETAIL_MAX_CHARS) } : {}),
      ...(errorText ? { errorText } : {}),
      ...(bounded.body ? { body: bounded.body, bodyKind: "text" as const } : {}),
      expandable: bounded.body.length > 0,
    };
  }

  // ── MCP / 其它:能拿到 presentation 就展示,否则退回输出前几行 ──
  if (display?.kind === "mcp_tool") {
    const bounded = boundBody(outputText, 20);
    return {
      summary: `${display.serverName} · ${display.toolName}`,
      ...(display.description ? { detail: clip(compact(display.description), DETAIL_MAX_CHARS) } : {}),
      ...(errorText ? { errorText } : {}),
      ...(display.unavailable ? { truncatedNote: "该工具当前不可用" } : {}),
      ...(bounded.body ? { body: bounded.body, bodyKind: "text" as const } : {}),
      expandable: bounded.body.length > 0,
    };
  }

  // ── 兜底:输出前几行;没有输出才看入参(空入参不生成 "{}" 这种噪音正文) ──
  const hasInput = Object.keys(input).length > 0;
  const fallbackBody = outputText.length > 0 ? outputText : hasInput ? JSON.stringify(input, null, 2) : "";
  const bounded = boundBody(fallbackBody, 20);
  return {
    summary: row.toolName,
    ...(outputText ? { detail: tailLines(outputText, 2, DETAIL_MAX_CHARS) } : {}),
    ...(errorText ? { errorText } : {}),
    ...(bounded.body ? { body: bounded.body, bodyKind: "text" as const } : {}),
    ...(bounded.clipped ? { truncatedNote: "内容已截断" } : {}),
    expandable: bounded.body.length > 0,
  };
}
