/* 轻量 markdown 解析:把助手正文拆成块与行内片段,交给原生 Text 渲染。
 *
 * 为什么自己写而不引库:手机端只需要"代码块/行内代码/加粗/链接/标题/列表/表格"这几样,
 * 引一个完整 markdown 渲染器会带来依赖、主题不一致和无法单测的成本;这里是纯函数,
 * 规则可被用例逐条覆盖(智能体输出里最常见的是代码块与行内代码,它们错了最影响可读性)。
 *
 * 只处理明确支持的语法,其余原样保留文本——不猜测、不吞内容。
 */
export interface InlineSegment {
  kind: "text" | "code" | "bold" | "link";
  text: string;
  /** link 专用。 */
  href?: string;
}

export type MarkdownBlock =
  | { kind: "paragraph"; segments: InlineSegment[] }
  | { kind: "heading"; level: number; segments: InlineSegment[] }
  | { kind: "code"; language?: string; text: string }
  | { kind: "list"; ordered: boolean; items: InlineSegment[][] }
  | { kind: "quote"; segments: InlineSegment[] }
  | {
      kind: "table";
      /** 每列对齐(来自分隔行),长度与 header 一致。 */
      align: Array<"left" | "center" | "right">;
      /** header[列] 是该列表头的行内片段。 */
      header: InlineSegment[][];
      /** rows[行][列] 是该格的行内片段。 */
      rows: InlineSegment[][][];
    };

const FENCE_PATTERN = /^```([\w+#.-]*)\s*$/u;
const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/u;
const LIST_PATTERN = /^\s*([-*+]|\d+\.)\s+(.*)$/u;
const QUOTE_PATTERN = /^>\s?(.*)$/u;
const INLINE_PATTERN = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))/u;
const TABLE_ALIGN_PATTERN = /^(:?)(-+)(:?)$/u;

/** 按"未转义的 |"切分表格行,并去掉首尾边界竖线产生的空单元格。 */
function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === "\\" && line[index + 1] === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  if (cells.length > 0 && cells[0] === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

/** 分隔行(`---`/`:--:`)→ 对齐方式;不是分隔行时返回 null。 */
function tableAlignOf(cells: string[]): Array<"left" | "center" | "right"> | null {
  if (cells.length === 0) return null;
  const align: Array<"left" | "center" | "right"> = [];
  for (const cell of cells) {
    const match = TABLE_ALIGN_PATTERN.exec(cell);
    if (!match) return null;
    align.push(
      match[1] === ":" && match[3] === ":" ? "center" : match[3] === ":" ? "right" : "left",
    );
  }
  return align;
}

/** 行内解析:代码 > 加粗 > 链接,其余按纯文本;不处理嵌套标记(避免歧义)。 */
export function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let rest = text;
  while (rest.length > 0) {
    const match = INLINE_PATTERN.exec(rest);
    if (!match || match.index === undefined) {
      segments.push({ kind: "text", text: rest });
      break;
    }
    if (match.index > 0) {
      segments.push({ kind: "text", text: rest.slice(0, match.index) });
    }
    const token = match[0];
    if (token.startsWith("`")) {
      segments.push({ kind: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("**")) {
      segments.push({ kind: "bold", text: token.slice(2, -2) });
    } else {
      const linkMatch = /^\[([^\]]+)\]\(([^)\s]+)\)$/u.exec(token);
      if (linkMatch) {
        segments.push({ kind: "link", text: linkMatch[1]!, href: linkMatch[2]! });
      } else {
        segments.push({ kind: "text", text: token });
      }
    }
    rest = rest.slice(match.index + token.length);
  }
  return segments.length > 0 ? segments : [{ kind: "text", text: "" }];
}

export function parseMarkdown(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  let index = 0;
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", segments: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index]!;

    // 代码块:围栏内原样保留(含空行),未闭合时按普通段落处理。
    const fence = FENCE_PATTERN.exec(line);
    if (fence) {
      const codeLines: string[] = [];
      let cursor = index + 1;
      let closed = false;
      while (cursor < lines.length) {
        if (/^```\s*$/u.test(lines[cursor]!)) {
          closed = true;
          break;
        }
        codeLines.push(lines[cursor]!);
        cursor += 1;
      }
      if (closed) {
        flushParagraph();
        blocks.push({
          kind: "code",
          ...(fence[1] ? { language: fence[1] } : {}),
          text: codeLines.join("\n"),
        });
        index = cursor + 1;
        continue;
      }
    }

    if (line.trim().length === 0) {
      flushParagraph();
      index += 1;
      continue;
    }

    // 表格:表头行 + 分隔行 + 至少一行数据;表头/分隔列数不齐时按普通段落处理(不吞内容)。
    if (line.includes("|")) {
      const headerCells = splitTableRow(line);
      const separatorLine = lines[index + 1] ?? "";
      const separatorCells = separatorLine.includes("|") ? splitTableRow(separatorLine) : [];
      const align = separatorCells.length > 0 ? tableAlignOf(separatorCells) : null;
      if (align && headerCells.length === separatorCells.length) {
        flushParagraph();
        const rows: InlineSegment[][][] = [];
        let cursor = index + 2;
        while (cursor < lines.length) {
          const rowLine = lines[cursor]!;
          if (rowLine.trim().length === 0 || !rowLine.includes("|")) break;
          // 行内代码里的 | 由 splitTableRow 的转义规则保护;缺列补空,多列截断到表头宽。
          const cells = splitTableRow(rowLine);
          rows.push(headerCells.map((_, cellIndex) => parseInline(cells[cellIndex] ?? "")));
          cursor += 1;
        }
        blocks.push({
          kind: "table",
          align,
          header: headerCells.map((cell) => parseInline(cell)),
          rows,
        });
        index = cursor;
        continue;
      }
    }

    const heading = HEADING_PATTERN.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        kind: "heading",
        level: heading[1]!.length,
        segments: parseInline(heading[2]!.trim()),
      });
      index += 1;
      continue;
    }

    const quote = QUOTE_PATTERN.exec(line);
    if (quote) {
      flushParagraph();
      blocks.push({ kind: "quote", segments: parseInline(quote[1]!) });
      index += 1;
      continue;
    }

    const list = LIST_PATTERN.exec(line);
    if (list) {
      flushParagraph();
      const ordered = /\d/u.test(list[1]!);
      const items: InlineSegment[][] = [];
      let cursor = index;
      while (cursor < lines.length) {
        const item = LIST_PATTERN.exec(lines[cursor]!);
        if (!item || /\d/u.test(item[1]!) !== ordered) break;
        items.push(parseInline(item[2]!));
        cursor += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      index = cursor;
      continue;
    }

    paragraph.push(line);
    index += 1;
  }

  flushParagraph();
  return blocks;
}
