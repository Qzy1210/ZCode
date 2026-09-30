/* markdown 渲染:把 parseMarkdown 的块与行内片段画成原生 Text。
 *
 * 只渲染明确支持的语法(代码块/行内代码/加粗/链接/标题/列表/引用/表格),其余保持纯文本。
 * 解析在 conversation/markdown.ts(纯函数、可用例覆盖),这里只管样式。
 */
import { Linking, StyleSheet, Text, View } from "react-native";

import { parseMarkdown, type InlineSegment } from "../conversation/markdown";
import { theme } from "../theme";

function Inline({ segments, style }: { segments: InlineSegment[]; style?: object }) {
  return (
    <Text style={style}>
      {segments.map((segment, index) => {
        if (segment.kind === "code") {
          return (
            <Text key={index} style={styles.inlineCode}>
              {segment.text}
            </Text>
          );
        }
        if (segment.kind === "bold") {
          return (
            <Text key={index} style={styles.bold}>
              {segment.text}
            </Text>
          );
        }
        if (segment.kind === "link") {
          return (
            <Text
              key={index}
              style={styles.link}
              onPress={() => {
                if (segment.href) void Linking.openURL(segment.href).catch(() => undefined);
              }}
            >
              {segment.text}
            </Text>
          );
        }
        return <Text key={index}>{segment.text}</Text>;
      })}
    </Text>
  );
}

export function MarkdownText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const blocks = parseMarkdown(text);
  return (
    <View style={styles.container}>
      {blocks.map((block, index) => {
        if (block.kind === "code") {
          return (
            <View key={index} style={styles.codeBlock}>
              {block.language ? <Text style={styles.codeLanguage}>{block.language}</Text> : null}
              <Text style={styles.codeText}>{block.text}</Text>
            </View>
          );
        }
        if (block.kind === "heading") {
          return (
            <Inline
              key={index}
              segments={block.segments}
              style={block.level <= 2 ? styles.heading1 : styles.heading2}
            />
          );
        }
        if (block.kind === "list") {
          return (
            <View key={index} style={styles.list}>
              {block.items.map((item, itemIndex) => (
                <View key={itemIndex} style={styles.listItem}>
                  <Text style={styles.listMarker}>
                    {block.ordered ? `${itemIndex + 1}.` : "•"}
                  </Text>
                  <Inline segments={item} style={styles.paragraph} />
                </View>
              ))}
            </View>
          );
        }
        if (block.kind === "quote") {
          return (
            <View key={index} style={styles.quote}>
              <Inline segments={block.segments} style={styles.quoteText} />
            </View>
          );
        }
        if (block.kind === "table") {
          return (
            <View key={index} style={styles.table}>
              {[
                { cells: block.header, isHeader: true },
                ...block.rows.map((cells) => ({ cells, isHeader: false })),
              ].map(({ cells, isHeader }, rowIndex) => (
                <View
                  key={rowIndex}
                  style={[
                    styles.tableRow,
                    rowIndex === 0 ? styles.tableRowFirst : null,
                    isHeader ? styles.tableHeaderRow : null,
                  ]}
                >
                  {cells.map((cell, cellIndex) => (
                    <View key={cellIndex} style={styles.tableCell}>
                      <Inline
                        segments={cell}
                        style={
                          isHeader
                            ? styles.tableHeaderText
                            : [
                                styles.tableText,
                                block.align[cellIndex] === "right"
                                  ? styles.tableAlignRight
                                  : block.align[cellIndex] === "center"
                                    ? styles.tableAlignCenter
                                    : null,
                              ]
                        }
                      />
                    </View>
                  ))}
                </View>
              ))}
            </View>
          );
        }        return <Inline key={index} segments={block.segments} style={styles.paragraph} />;
      })}
      {streaming ? <Text style={styles.cursor}>▍</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 6 },
  paragraph: { color: theme.foreground, fontSize: 14, lineHeight: 21 },
  heading1: { color: theme.foreground, fontSize: 16, fontWeight: "700", lineHeight: 23 },
  heading2: { color: theme.foreground, fontSize: 15, fontWeight: "600", lineHeight: 22 },
  bold: { fontWeight: "700" },
  inlineCode: {
    fontFamily: "monospace",
    fontSize: 13,
    color: theme.info,
  },
  link: { color: theme.info, textDecorationLine: "underline" },
  codeBlock: {
    borderRadius: 8,
    backgroundColor: theme.card,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 4,
  },
  codeLanguage: { color: theme.foregroundSubtle, fontSize: 10 },
  codeText: { fontFamily: "monospace", fontSize: 12, lineHeight: 17, color: theme.foreground },
  list: { gap: 4 },
  listItem: { flexDirection: "row", gap: 6 },
  listMarker: { color: theme.foregroundSubtle, fontSize: 14, lineHeight: 21 },
  quote: {
    borderLeftWidth: 2,
    borderLeftColor: theme.border,
    paddingLeft: 8,
  },
  quoteText: { color: theme.foregroundSubtle, fontSize: 13, lineHeight: 20 },
  /** 表格:等宽列 + 表头底色;窄屏不追求列宽按内容分布,可读优先。 */
  table: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: 8,
  },
  tableRow: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  tableRowFirst: { borderTopWidth: 0 },
  tableHeaderRow: { backgroundColor: theme.card },
  tableCell: { flex: 1, paddingHorizontal: 8, paddingVertical: 6, justifyContent: "center" },
  tableHeaderText: { color: theme.foreground, fontSize: 12, fontWeight: "600" },
  tableText: { color: theme.foreground, fontSize: 12, lineHeight: 17 },
  tableAlignRight: { textAlign: "right" },
  tableAlignCenter: { textAlign: "center" },
  cursor: { color: theme.info, fontSize: 14 },
});
