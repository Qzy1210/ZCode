/* markdown 解析验证(纯函数):
 *   node packages/mobile-app/scripts/verify.mjs markdown
 *
 * 智能体输出里最常见的是代码块与行内代码,解析错了最影响可读性;另外"不吞内容"
 * (未闭合围栏、非支持语法)是底线,所以逐条立断言。
 */
import { parseInline, parseMarkdown } from "../src/conversation/markdown";
import { check, finish } from "./verify-harness";

// ── 行内 ──
check(
  "行内代码与加粗",
  (() => {
    const segments = parseInline("用 `npm test` 或 **直接跑** 都行");
    return (
      segments.map((s) => s.kind).join(",") === "text,code,text,bold,text" &&
      segments[1]?.text === "npm test" &&
      segments[3]?.text === "直接跑"
    );
  })(),
);
check(
  "链接被解析且保留 href",
  (() => {
    const segments = parseInline("见 [文档](https://example.com/a)");
    const link = segments.find((s) => s.kind === "link");
    return link?.text === "文档" && link.href === "https://example.com/a";
  })(),
);
check("普通文本原样保留", parseInline("纯文本 没有标记").length === 1);

// ── 块 ──
check(
  "代码块原样保留(含空行与内部符号)",
  (() => {
    const blocks = parseMarkdown("说明\n\n```bash\nnpm test\n\n**不是加粗**\n```\n结尾");
    const code = blocks.find((b) => b.kind === "code");
    return (
      code?.kind === "code" &&
      code.text === "npm test\n\n**不是加粗**" &&
      code.language === "bash" &&
      blocks.filter((b) => b.kind === "paragraph").length === 2
    );
  })(),
);
check(
  "未闭合围栏按段落处理(不吞内容)",
  (() => {
    const blocks = parseMarkdown("```bash\nnpm test");
    const text = JSON.stringify(blocks);
    return blocks.every((b) => b.kind !== "code") && text.includes("npm test");
  })(),
);
check(
  "标题与引用",
  (() => {
    const blocks = parseMarkdown("## 结论\n> 注意边界");
    return (
      blocks[0]?.kind === "heading" &&
      blocks[0].level === 2 &&
      blocks[1]?.kind === "quote"
    );
  })(),
);
check(
  "有序与无序列表",
  (() => {
    const ordered = parseMarkdown("1. 第一步\n2. 第二步");
    const bullet = parseMarkdown("- a\n- b");
    return (
      ordered[0]?.kind === "list" &&
      ordered[0].ordered === true &&
      ordered[0].items.length === 2 &&
      bullet[0]?.kind === "list" &&
      bullet[0].ordered === false
    );
  })(),
);
check(
  "列表项内可含行内标记",
  (() => {
    const blocks = parseMarkdown("- 跑 `npm test`\n- 看 **日志**");
    const list = blocks[0];
    return (
      list?.kind === "list" &&
      list.items[0]?.some((s) => s.kind === "code") === true &&
      list.items[1]?.some((s) => s.kind === "bold") === true
    );
  })(),
);
check(
  "交替列表不会被合并成一块",
  (() => {
    const blocks = parseMarkdown("1. 一\n- 二");
    return blocks.filter((b) => b.kind === "list").length === 2;
  })(),
);
check("多行段落合并为一块", (() => {
  const blocks = parseMarkdown("第一行\n第二行");
  return blocks.length === 1 && blocks[0]?.kind === "paragraph";
})());
check("空文本不产生块", parseMarkdown("").length === 0);
check("CRLF 换行被归一", (() => {
  const blocks = parseMarkdown("第一行\r\n第二行");
  return blocks[0]?.kind === "paragraph" && JSON.stringify(blocks[0]).includes("第一行\\n第二行");
})());

// ── 表格(P5 真机反馈:智能体输出的对比表此前被拍平成普通段落)──
check(
  "表格:表头/分隔/数据行成块,对齐来自分隔行",
  (() => {
    const blocks = parseMarkdown(
      "| 命令 | 用途 |\n| --- | --- |\n| pnpm typecheck | 类型检查 |\n| pnpm lint | 静态检查 |",
    );
    const table = blocks[0];
    return (
      table?.kind === "table" &&
      table.header.length === 2 &&
      table.rows.length === 2 &&
      table.align.every((a) => a === "left") &&
      JSON.stringify(table.header[0]).includes("命令")
    );
  })(),
);
check(
  "表格:分隔行的冒号决定左右/居中对齐",
  (() => {
    const blocks = parseMarkdown("| a | b | c |\n| :-- | --: | :-: |\n| 1 | 2 | 3 |");
    const table = blocks[0];
    return (
      table?.kind === "table" &&
      table.align[0] === "left" &&
      table.align[1] === "right" &&
      table.align[2] === "center"
    );
  })(),
);
check(
  "表格:单元格里保留行内标记",
  (() => {
    const blocks = parseMarkdown("| 名称 |\n| --- |\n| `pnpm` 与 **lint** |");
    const table = blocks[0];
    const firstRow = table?.kind === "table" ? table.rows[0] : undefined;
    return (
      firstRow !== undefined &&
      firstRow.some((cell) => cell.some((s) => s.kind === "code")) === true &&
      firstRow.some((cell) => cell.some((s) => s.kind === "bold")) === true
    );
  })(),
);
check(
  "表格:数据行缺列补空、多列截断到表头宽",
  (() => {
    const blocks = parseMarkdown("| a | b |\n| --- | --- |\n| 1 |\n| 1 | 2 | 3 |");
    const table = blocks[0];
    return (
      table?.kind === "table" &&
      table.rows[0]?.length === 2 &&
      table.rows[0]?.[1]?.[0]?.text === "" &&
      table.rows[1]?.length === 2
    );
  })(),
);
check(
  "表格:不是分隔行(| 之间不是横线)按段落保留",
  (() => {
    const blocks = parseMarkdown("| a | b |\n| 没有 | 分隔 |");
    return blocks.length === 1 && blocks[0]?.kind === "paragraph";
  })(),
);
check(
  "表格:表头列数与分隔列数不齐按段落保留(不吞内容)",
  (() => {
    const blocks = parseMarkdown("| a | b | c |\n| --- | --- |\n| 1 | 2 | 3 |");
    return blocks.length === 1 && blocks[0]?.kind === "paragraph";
  })(),
);
check(
  "表格:前后块不被吞",
  (() => {
    const blocks = parseMarkdown("前言\n| a |\n| --- |\n| 1 |\n\n后记");
    return (
      blocks[0]?.kind === "paragraph" &&
      blocks[1]?.kind === "table" &&
      blocks[2]?.kind === "paragraph"
    );
  })(),
);
check(
  "表格:边界竖线可省略",
  (() => {
    const blocks = parseMarkdown("a | b\n--- | ---\n1 | 2");
    return blocks[0]?.kind === "table" && blocks[0].rows.length === 1;
  })(),
);
check(
  "表格:转义竖线不切开单元格",
  (() => {
    const blocks = parseMarkdown("| a \\| b |\n| --- |\n| 1 |");
    const table = blocks[0];
    return (
      table?.kind === "table" && table.header.length === 1 && table.header[0]?.[0]?.text === "a | b"
    );
  })(),
);

finish();
