/* 交互卡片:审批 / 计划批准 / 问答。
 *
 * 只消费 interactionModel 给出的视图模型,自己不做协议判断;
 * 所有提交都通过 onRespond(answer) 回传 store,由 store 走 resolveInteraction。
 */
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import type { InteractionAnswer } from "../conversation/conversationTransport";
import {
  buildDeclineAnswer,
  buildLegacyUserInputAnswer,
  buildPermissionAnswer,
  buildPlanAnswer,
  buildQuestionAnswer,
  type InteractionCardModel,
  type QuestionModel,
} from "../conversation/interactionModel";
import { theme } from "../theme";

const DENY_OPTION_HINT = /(deny|reject|拒绝|不允许)/i;

function isDenyOption(kind: string, label: string, optionId: string): boolean {
  return kind === "deny" || DENY_OPTION_HINT.test(label) || DENY_OPTION_HINT.test(optionId);
}

function QuestionBlock({
  question,
  selected,
  customText,
  onToggle,
  onCustomTextChange,
}: {
  question: QuestionModel;
  selected: string[];
  customText: string;
  onToggle: (value: string) => void;
  onCustomTextChange: (text: string) => void;
}) {
  return (
    <View style={styles.questionBlock}>
      <Text style={styles.questionHeader}>
        {question.header ? `${question.header} · ` : ""}
        {question.multiSelect ? "可多选" : "单选"}
      </Text>
      <Text style={styles.questionText}>{question.question}</Text>
      {question.options.map((option) => {
        const active = selected.includes(option.value);
        return (
          <Pressable
            key={option.value}
            style={[styles.optionRow, active ? styles.optionRowActive : null]}
            onPress={() => onToggle(option.value)}
          >
            <Text style={[styles.optionMark, active ? styles.optionMarkActive : null]}>
              {active ? "◉" : "○"}
            </Text>
            <View style={styles.optionBody}>
              <Text style={styles.optionLabel}>{option.label}</Text>
              {option.description ? (
                <Text style={styles.optionDescription}>{option.description}</Text>
              ) : null}
            </View>
          </Pressable>
        );
      })}
      <TextInput
        style={styles.input}
        value={customText}
        onChangeText={onCustomTextChange}
        placeholder="补充回答(可选)"
        placeholderTextColor={theme.foregroundSubtle}
        multiline
      />
    </View>
  );
}

export function InteractionCard({
  card,
  busy,
  errorMessage,
  onRespond,
}: {
  card: InteractionCardModel;
  busy: boolean;
  errorMessage?: string;
  onRespond: (answer: InteractionAnswer) => void;
}) {
  const [feedback, setFeedback] = useState("");
  const [selectedByQuestion, setSelectedByQuestion] = useState<Record<string, string[]>>({});
  const [customByQuestion, setCustomByQuestion] = useState<Record<string, string>>({});
  const [legacyOption, setLegacyOption] = useState<string | null>(null);
  const [legacyText, setLegacyText] = useState("");

  const questions = card.kind === "question" ? card.questions : [];
  const selections = useMemo(
    () =>
      questions.map((question) => ({
        question: question.question,
        values: [
          ...(selectedByQuestion[question.question] ?? []),
          ...(customByQuestion[question.question]?.trim()
            ? [customByQuestion[question.question]!.trim()]
            : []),
        ],
      })),
    [questions, selectedByQuestion, customByQuestion],
  );

  const toggleOption = (question: QuestionModel, value: string) => {
    setSelectedByQuestion((current) => {
      const values = current[question.question] ?? [];
      if (!question.multiSelect) {
        return { ...current, [question.question]: values.includes(value) ? [] : [value] };
      }
      return {
        ...current,
        [question.question]: values.includes(value)
          ? values.filter((item) => item !== value)
          : [...values, value],
      };
    });
  };

  const title =
    card.kind === "permission"
      ? "需要你确认"
      : card.kind === "plan"
        ? "计划待批准"
        : "需要你回答";

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        {card.kind === "permission" ? (
          <Text style={styles.badge} numberOfLines={1}>
            {card.toolName}
          </Text>
        ) : null}
      </View>

      {card.kind === "permission" ? (
        <>
          <Text style={styles.summary}>{card.summary}</Text>
          {card.detailText ? (
            <Text style={styles.detail} numberOfLines={8}>
              {card.detailText}
            </Text>
          ) : null}
          <View style={styles.buttonRow}>
            {card.options.map((option) => {
              const deny = isDenyOption(option.kind, option.label, option.optionId);
              return (
                <Pressable
                  key={option.optionId}
                  disabled={busy}
                  style={[styles.button, deny ? styles.buttonDanger : styles.buttonPrimary, busy ? styles.buttonDisabled : null]}
                  onPress={() => onRespond(buildPermissionAnswer(option.optionId, feedback))}
                >
                  <Text style={deny ? styles.buttonDangerText : styles.buttonPrimaryText}>
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {card.freeText ? (
            <TextInput
              style={styles.input}
              value={feedback}
              onChangeText={setFeedback}
              placeholder="备注(随本次选择一起提交,可选)"
              placeholderTextColor={theme.foregroundSubtle}
              multiline
            />
          ) : null}
        </>
      ) : null}

      {card.kind === "plan" ? (
        <>
          <Text style={styles.summary}>{card.prompt}</Text>
          <TextInput
            style={styles.input}
            value={feedback}
            onChangeText={setFeedback}
            placeholder="计划反馈(填写后点拒绝 = 拒绝并说明原因)"
            placeholderTextColor={theme.foregroundSubtle}
            multiline
          />
          <View style={styles.buttonRow}>
            <Pressable
              disabled={busy}
              style={[styles.button, styles.buttonPrimary, busy ? styles.buttonDisabled : null]}
              onPress={() => onRespond(buildPlanAnswer("approve"))}
            >
              <Text style={styles.buttonPrimaryText}>批准并开始实施</Text>
            </Pressable>
            <Pressable
              disabled={busy}
              style={[styles.button, styles.buttonDanger, busy ? styles.buttonDisabled : null]}
              onPress={() => onRespond(buildPlanAnswer("decline", feedback))}
            >
              <Text style={styles.buttonDangerText}>拒绝</Text>
            </Pressable>
          </View>
        </>
      ) : null}

      {card.kind === "question" ? (
        <>
          {card.prompt ? <Text style={styles.summary}>{card.prompt}</Text> : null}
          {questions.length > 0 ? (
            questions.map((question) => (
              <QuestionBlock
                key={question.question}
                question={question}
                selected={selectedByQuestion[question.question] ?? []}
                customText={customByQuestion[question.question] ?? ""}
                onToggle={(value) => toggleOption(question, value)}
                onCustomTextChange={(text) =>
                  setCustomByQuestion((current) => ({ ...current, [question.question]: text }))
                }
              />
            ))
          ) : (
            <>
              {card.options.map((option) => {
                const active = legacyOption === option.optionId;
                return (
                  <Pressable
                    key={option.optionId}
                    style={[styles.optionRow, active ? styles.optionRowActive : null]}
                    onPress={() => setLegacyOption(active ? null : option.optionId)}
                  >
                    <Text style={[styles.optionMark, active ? styles.optionMarkActive : null]}>
                      {active ? "◉" : "○"}
                    </Text>
                    <Text style={styles.optionLabel}>{option.label}</Text>
                  </Pressable>
                );
              })}
              {card.freeText ? (
                <TextInput
                  style={styles.input}
                  value={legacyText}
                  onChangeText={setLegacyText}
                  placeholder={card.sensitive ? "输入内容(敏感)" : "输入回答"}
                  placeholderTextColor={theme.foregroundSubtle}
                  secureTextEntry={card.sensitive}
                  multiline
                />
              ) : null}
            </>
          )}
          <View style={styles.buttonRow}>
            <Pressable
              disabled={busy}
              style={[styles.button, styles.buttonPrimary, busy ? styles.buttonDisabled : null]}
              onPress={() =>
                onRespond(
                  questions.length > 0
                    ? buildQuestionAnswer(selections)
                    : buildLegacyUserInputAnswer({
                        ...(legacyOption ? { optionId: legacyOption } : {}),
                        ...(legacyText.trim() ? { freeText: legacyText } : {}),
                      }),
                )
              }
            >
              <Text style={styles.buttonPrimaryText}>提交</Text>
            </Pressable>
            <Pressable
              disabled={busy}
              style={[styles.button, styles.buttonDanger, busy ? styles.buttonDisabled : null]}
              onPress={() => onRespond(buildDeclineAnswer())}
            >
              <Text style={styles.buttonDangerText}>拒绝</Text>
            </Pressable>
          </View>
        </>
      ) : null}

      {busy ? <Text style={styles.hint}>提交中…</Text> : null}
      {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
    backgroundColor: theme.panel,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 8,
  },
  header: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { color: theme.warning, fontSize: 13, fontWeight: "600" },
  badge: { color: theme.foregroundSubtle, fontSize: 11, flexShrink: 1 },
  summary: { color: theme.foreground, fontSize: 13, lineHeight: 19 },
  detail: { color: theme.foregroundSubtle, fontSize: 11, lineHeight: 16 },
  buttonRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: {
    borderRadius: 9,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderWidth: StyleSheet.hairlineWidth,
  },
  buttonPrimary: { backgroundColor: theme.primary, borderColor: theme.primary },
  buttonPrimaryText: { color: theme.primaryForeground, fontSize: 13, fontWeight: "600" },
  buttonDanger: { borderColor: theme.destructive },
  buttonDangerText: { color: theme.destructive, fontSize: 13, fontWeight: "600" },
  buttonDisabled: { opacity: 0.5 },
  input: {
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    backgroundColor: theme.card,
    color: theme.foreground,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    maxHeight: 100,
  },
  questionBlock: { gap: 6, paddingTop: 4 },
  questionHeader: { color: theme.foregroundSubtle, fontSize: 10 },
  questionText: { color: theme.foreground, fontSize: 13, lineHeight: 19 },
  optionRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  optionRowActive: { borderColor: theme.info, backgroundColor: theme.selected },
  optionMark: { color: theme.foregroundSubtle, fontSize: 13 },
  optionMarkActive: { color: theme.info },
  optionBody: { flex: 1, gap: 2 },
  optionLabel: { color: theme.foreground, fontSize: 13 },
  optionDescription: { color: theme.foregroundSubtle, fontSize: 11, lineHeight: 16 },
  hint: { color: theme.foregroundSubtle, fontSize: 11 },
  error: { color: theme.destructive, fontSize: 11 },
});
