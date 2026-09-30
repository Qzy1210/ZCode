/* 工具卡片模型验证(纯函数):
 *   node packages/mobile-app/scripts/verify.mjs tools
 *
 * 覆盖取值优先级(error → output.display → row.display → outputPreview → output.text)、
 * 六类工具的摘要选择、diff 行前缀与截断标注。这些规则写错的表现是"卡片显示的
 * 不是用户要看的那条信息",所以逐条立断言。
 */
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";

import { buildToolCardModel } from "../src/conversation/toolCardModel";
import { check, finish } from "./verify-harness";

let nextId = 1;
function toolRow(overrides: Partial<ToolCallRow> & { toolName: string }): ToolCallRow {
  const rowId = nextId++;
  return {
    kind: "toolCall",
    rowId,
    turnId: "t1",
    createdAt: Date.now(),
    createdAtSeq: rowId,
    toolCallId: `tc-${rowId}`,
    status: "success",
    inputText: "",
    ...overrides,
  } as ToolCallRow;
}

// ── Bash:命令 + 输出,运行中优先 outputPreview ──
{
  const row = toolRow({
    toolName: "Bash",
    status: "running",
    input: { command: "npm test -- --watch=false" },
    inputText: '{"command":"npm test -- --watch=false"}',
    outputPreview: { text: "旧预览", fullText: "运行中输出第一行\n第二行\n第三行", totalLines: 3, totalBytes: 30, linesEstimated: false },
    output: { text: "终态输出" },
  } as never);
  const model = buildToolCardModel(row);
  check("Bash 摘要取命令", model.summary === "npm test -- --watch=false", model.summary);
  check("运行中正文优先 outputPreview.fullText", model.body?.includes("第三行") === true, model.body ?? "");
  check("折叠态第二行给输出末尾", model.detail?.includes("第三行") === true, model.detail ?? "");
  check("Bash 可展开", model.expandable === true);
}

// ── Bash:终态优先 output.display(bash_output)并标注截断 ──
{
  const row = toolRow({
    toolName: "Bash",
    input: { command: "ls -la" },
    inputText: '{"command":"ls -la"}',
    output: {
      text: "短文本",
      display: { kind: "bash_output", output: "a\nb\nc", truncated: true, outputPath: "/tmp/zcode/tool-output/x.log" },
    },
  } as never);
  const model = buildToolCardModel(row);
  check("终态正文取 bash_output.output", model.body === "a\nb\nc", model.body ?? "");
  check("截断时给出完整内容位置", model.truncatedNote?.includes("x.log") === true, model.truncatedNote ?? "");
}

// ── 文件编辑:diff 正文与 +/− 统计 ──
{
  const row = toolRow({
    toolName: "Edit",
    input: { file_path: "/repo/src/a.ts", old_string: "x", new_string: "y" },
    inputText: "{}",
    output: {
      text: "",
      display: {
        kind: "file_diff",
        filePath: "/repo/src/a.ts",
        additions: 2,
        deletions: 1,
        structuredPatch: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 3, lines: [" keep", "-old", "+new1", "+new2"] },
        ],
      },
    },
  } as never);
  const model = buildToolCardModel(row);
  check("文件编辑摘要:文件名 + 增删", model.summary === "a.ts  +2 −1", model.summary);
  check("diff 正文含 hunk 头与原始行前缀", model.body?.includes("@@ -1,1 +1,3 @@") === true && model.body?.includes("+new1") === true);
  check("diff 正文按 diff 语义渲染", model.bodyKind === "diff", model.bodyKind ?? "");
  check("无截断时不提示", model.truncatedNote === undefined);
}

// ── diff 被截断(结构化 hunk 上限) ──
{
  const lines = Array.from({ length: 120 }, (_value, index) => `+line ${index}`);
  const row = toolRow({
    toolName: "Write",
    input: { file_path: "/repo/big.ts" },
    inputText: "{}",
    output: {
      text: "",
      display: {
        kind: "file_diff",
        filePath: "/repo/big.ts",
        additions: 120,
        deletions: 0,
        structuredPatch: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 120, lines }],
        truncated: true,
      },
    },
  } as never);
  const model = buildToolCardModel(row);
  check("超长 diff 只保留前 60 行", (model.body ?? "").split("\n").length <= 61, String((model.body ?? "").split("\n").length));
  check("截断标注来自 schema", model.truncatedNote === "diff 已截断", model.truncatedNote ?? "");
}

// ── 读取文件 ──
{
  const row = toolRow({
    toolName: "Read",
    input: { file_path: "/repo/pkg/src/index.ts", offset: 120, limit: 40 },
    inputText: "{}",
    output: { text: "line1\nline2\nline3" },
  } as never);
  const model = buildToolCardModel(row);
  check("读取摘要:文件名 + 行范围", model.summary === "index.ts · 第 120 行起 · 40 行", model.summary);
  check("读取折叠态给返回行数", model.detail === "返回 3 行", model.detail ?? "");
}

// ── 搜索 ──
{
  const row = toolRow({
    toolName: "Grep",
    input: { pattern: "createConversationStore", path: "packages/mobile-app" },
    inputText: "{}",
    output: { text: "a.ts:12:createConversationStore\nb.ts:30:createConversationStore" },
  } as never);
  const model = buildToolCardModel(row);
  check("搜索摘要取查询词", model.summary === "createConversationStore", model.summary);
  check("搜索折叠态给命中行数", model.detail === "命中 2 行", model.detail ?? "");
}

// ── 子代理 ──
{
  const row = toolRow({
    toolName: "Task",
    input: { description: "调研协议", subagent_type: "Explore", prompt: "请调研……" },
    inputText: "{}",
    output: { text: "结论:……" },
  } as never);
  const model = buildToolCardModel(row);
  check("子代理摘要取描述", model.summary === "调研协议", model.summary);
  check("子代理正文含提示词与结论", model.body?.includes("请调研") === true && model.body?.includes("结论") === true);
}

// ── MCP 工具 ──
{
  const row = toolRow({
    toolName: "mcp__fs__read_file",
    inputText: "{}",
    input: {},
    display: { kind: "mcp_tool", serverName: "fs", toolName: "read_file", description: "读取文件内容" },
    output: { text: "文件内容" },
  } as never);
  const model = buildToolCardModel(row);
  check("MCP 摘要:服务名 · 工具名", model.summary === "fs · read_file", model.summary);
  check("MCP 折叠态给描述", model.detail === "读取文件内容", model.detail ?? "");
}

// ── 错误优先 ──
{
  const row = toolRow({
    toolName: "Bash",
    status: "error",
    input: { command: "false" },
    inputText: "{}",
    error: { code: "exit_1", message: "命令失败" },
    output: { text: "一些输出" },
  } as never);
  const model = buildToolCardModel(row);
  check("错误文本优先展示", model.errorText === "exit_1: 命令失败", model.errorText ?? "");
}

// ── 流式入参(inputText 半截 JSON) ──
{
  const row = toolRow({
    toolName: "Bash",
    status: "inputStreaming",
    inputText: '{"command":"npm run build',
  } as never);
  const model = buildToolCardModel(row);
  check(
    "半截 JSON 也能取到命令",
    model.summary.includes("npm run build"),
    model.summary,
  );
}

// ── 未知工具:兜底为工具名 + 输出 ──
{
  const row = toolRow({
    toolName: "SomeNewTool",
    input: { foo: "bar" },
    inputText: '{"foo":"bar"}',
    output: { text: "输出内容" },
  } as never);
  const model = buildToolCardModel(row);
  check("未知工具摘要为工具名", model.summary === "SomeNewTool", model.summary);
  check("未知工具正文兜底为输出", model.body === "输出内容", model.body ?? "");
}

// ── 无内容时不可展开 ──
{
  const row = toolRow({ toolName: "TodoWrite", inputText: "{}", input: {} } as never);
  const model = buildToolCardModel(row);
  check("没有正文时不可展开(避免空展开)", model.expandable === false, JSON.stringify(model));
}

finish();
