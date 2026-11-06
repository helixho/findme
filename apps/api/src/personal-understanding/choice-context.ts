/** Exact question/option spans preserve short answers without importing old interpretations. */
export function questionBackgroundSpans(text: string) {
  const options = [
    ...text.matchAll(
      /^[ \t]*(?:[-+*][ \t]+)?(?:\*\*|__)?[A-Ha-hＡ-Ｈａ-ｈ](?:\*\*|__)?[ \t]*[.、．:：)](?:\*\*|__)?[ \t]*[^\r\n]*/gm,
    ),
  ];
  const spans = [...text.matchAll(/[^。！？\n]*[?？]/g), ...options].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    text: match[0],
  }));
  for (const [i, option] of options.entries()) {
    const start = option.index ?? 0;
    const previous = options[i - 1];
    // Only the first option in a block owns the immediately preceding prompt.
    if (previous && !text.slice((previous.index ?? 0) + previous[0].length, start).trim()) continue;
    const prefix = text.slice(0, start).trimEnd();
    if (!/[:：](?:\*\*|__)?$/.test(prefix)) continue;
    const breaks = [...prefix.matchAll(/\r?\n[ \t]*\r?\n/g)];
    const boundary = breaks.at(-1);
    const paragraphStart = boundary ? (boundary.index ?? 0) + boundary[0].length : 0;
    const raw = prefix.slice(paragraphStart);
    const prompt = raw.trimStart();
    // Keep the question paragraph, never an unbounded preceding analysis.
    if (!prompt || prompt.length > 360 || prompt.split(/\r?\n/).length > 4) continue;
    spans.push({
      start: paragraphStart + raw.length - prompt.length,
      end: prefix.length,
      text: prompt,
    });
  }
  // Merge overlapping question/prompt matches without duplicating their text.
  return spans
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .reduce<typeof spans>((all, span) => {
      const previous = all.at(-1);
      if (previous && span.start < previous.end) {
        previous.end = Math.max(previous.end, span.end);
        previous.text = text.slice(previous.start, previous.end);
      } else all.push({ ...span });
      return all;
    }, []);
}
export function questionBackground(text: string) {
  return questionBackgroundSpans(text)
    .map((span) => span.text)
    .join("\n");
}

export type ChoiceBindingTurn = {
  id: string;
  role: string;
  content: string;
  sourceItemId?: string | null;
};
export type ChoiceOptionSpan = {
  label: string;
  start: number;
  end: number;
  text: string;
};
export type ChoiceBinding = {
  kind: "derived_selection";
  not_spontaneous_quote: true;
  scope: "question_conditions_only";
  answer_turn_id: string;
  answer_source_id: string | null;
  original_answer: string;
  question_turn_id: string;
  question_source_id: string | null;
  question_role: "assistant";
  question_text: string;
  question_spans: Array<{ start: number; end: number; text: string }>;
  options: ChoiceOptionSpan[];
  selected_labels: string[];
  selected_options: ChoiceOptionSpan[];
};

/** Conservative parsing: an explanation, correction, slash alternative or unknown label stays unbound. */
export function explicitChoiceLabels(text: string): string[] | null {
  const normalized = text.trim().normalize("NFKC").toUpperCase();
  if (!/^[A-H](?:[\s、,，+&和及与]+[A-H])*(?:[。.!！])?$/.test(normalized)) return null;
  return [...new Set(normalized.match(/[A-H]/g) ?? [])];
}

function choiceOptions(text: string): ChoiceOptionSpan[] {
  const options = [
    ...text.matchAll(
      /^[ \t]*(?:[-+*][ \t]+)?(?:\*\*|__)?([A-Ha-hＡ-Ｈａ-ｈ])(?:\*\*|__)?[ \t]*[.、．:：)](?:\*\*|__)?[ \t]*([^\r\n]*)/gm,
    ),
  ];
  if (options.length < 2 || options.some((option) => !option[2]?.replace(/[*_`]/g, "").trim()))
    return [];
  const spans = options.map((option) => ({
    label: (option[1] ?? "").normalize("NFKC").toUpperCase(),
    start: option.index ?? 0,
    end: (option.index ?? 0) + option[0].length,
    text: option[0],
  }));
  // More than one question with repeated A/B labels must not be guessed into a single question.
  return new Set(spans.map((option) => option.label)).size === spans.length ? spans : [];
}

/** A binding states what was selected, never why the person selected it. Empty turns are barriers. */
export function deriveChoiceBindings(turns: readonly ChoiceBindingTurn[]): ChoiceBinding[] {
  const bindings: ChoiceBinding[] = [];
  for (let i = 1; i < turns.length; i++) {
    const answer = turns[i];
    const question = turns[i - 1];
    if (!answer || !question || answer.role !== "user" || question.role !== "assistant") continue;
    const labels = explicitChoiceLabels(answer.content);
    if (!labels) continue;
    const options = choiceOptions(question.content);
    if (
      !options.length ||
      labels.some((label) => !options.some((option) => option.label === label))
    )
      continue;
    const first = options[0];
    const last = options.at(-1);
    if (!first || !last) continue;
    const backgrounds = questionBackgroundSpans(question.content);
    const preceding = backgrounds
      .filter(
        (span) => span.end <= first.start && !question.content.slice(span.end, first.start).trim(),
      )
      .at(-1);
    const following = backgrounds.find(
      (span) => span.start >= last.end && !question.content.slice(last.end, span.start).trim(),
    );
    const questionSpans = [
      ...(preceding ? [preceding] : []),
      ...options.map(({ start, end, text }) => ({ start, end, text })),
      ...(following ? [following] : []),
    ];
    bindings.push({
      kind: "derived_selection",
      not_spontaneous_quote: true,
      scope: "question_conditions_only",
      answer_turn_id: answer.id,
      answer_source_id: answer.sourceItemId ?? null,
      original_answer: answer.content,
      question_turn_id: question.id,
      question_source_id: question.sourceItemId ?? null,
      question_role: "assistant",
      question_text: questionSpans.map((span) => span.text).join("\n"),
      question_spans: questionSpans,
      options,
      selected_labels: labels,
      selected_options: labels.flatMap((label) =>
        options.filter((option) => option.label === label),
      ),
    });
  }
  return bindings;
}
