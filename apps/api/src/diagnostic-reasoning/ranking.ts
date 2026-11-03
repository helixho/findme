// Retrieval scores choose what to inspect, not what is true or independent.
const STOP = new Set([
  "the",
  "and",
  "this",
  "that",
  "what",
  "which",
  "does",
  "have",
  "with",
  "for",
  "are",
  "how",
  "why",
  "should",
  "ai",
  "哪些",
  "有哪",
  "什么",
  "如何",
  "是否",
  "现在",
  "目前",
  "这些",
  "这个",
  "那个",
  "之间",
  "对于",
  "关于",
  "我们",
  "我的",
  "你的",
  "用户",
  "可以",
  "需要",
  "要求",
  "问题",
  "给出",
  "分析",
  "理解",
  "一些",
  "一下",
  "怎样",
  "怎么",
  "能够",
  "还有",
  "以及",
  "相关",
  "进行",
  "通过",
  "处理",
  "情况",
  "中的",
  "有什么",
  "的是",
  "得出",
  "说明",
  "哪些",
  "时候",
  "自己",
]);
const WORDS = new Intl.Segmenter("zh-CN", { granularity: "word" });
export function informativeTerms(text: string): Set<string> {
  const normalized = text.normalize("NFKC").toLowerCase();
  const terms: string[] = [];
  for (const segment of WORDS.segment(normalized)) {
    if (!segment.isWordLike || segment.segment.length < 2 || STOP.has(segment.segment)) continue;
    terms.push(segment.segment);
    if (/^[\p{Script=Han}]+$/u.test(segment.segment) && segment.segment.length > 2) {
      for (let i = 0; i < segment.segment.length - 1; i++) {
        const pair = segment.segment.slice(i, i + 2);
        if (!STOP.has(pair)) terms.push(pair);
      }
    }
  }
  return new Set(terms);
}
export type RankRow = { id: string; quote: string };
export type LexicalScore = { score: number; terms: string[] };
export function lexicalScores(question: string, rows: RankRow[]): Map<string, LexicalScore> {
  const query = informativeTerms(question);
  const terms = rows.map((row) => ({ row, terms: informativeTerms(row.quote) }));
  const documentFrequency = new Map<string, number>();
  for (const item of terms)
    for (const term of item.terms) {
      if (query.has(term)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  return new Map(
    terms.map(({ row, terms }) => {
      const matches = [...terms].filter((term) => query.has(term));
      const score = matches.reduce(
        (sum, term) =>
          sum +
          Math.min(3, Math.log(1 + (rows.length + 1) / ((documentFrequency.get(term) ?? 0) + 1))),
        0,
      );
      return [
        row.id,
        { score: query.size >= 3 && matches.length === 1 ? score * 0.5 : score, terms: matches },
      ];
    }),
  );
}

export type DiverseRow = {
  id: string;
  quote: string;
  score: number;
  use: string;
  source: { group_id: string; session_id: string };
};
const contrast = (text: string) =>
  /\b(?:not|never|unless|however|instead)\b|并非|但是|然而|除非|不代表|不等于|未经|不允许|不需要|确认后|擅自/iu.test(
    text,
  );
export function relevanceFirstOrder<T extends DiverseRow>(rows: T[], limit: number): T[] {
  if (!rows.length) return [];
  const max = Math.max(...rows.map((row) => row.score));
  // Heuristic floor is declared; a low-quality new group cannot beat relevant material.
  const remaining = rows.filter((row) => row.score > 0 && row.score >= max * 0.25);
  const result: T[] = [];
  const groups = new Map<string, number>();
  const sessions = new Map<string, number>();
  let contexts = 0;
  while (remaining.length && result.length < limit) {
    const adjusted = (row: T) =>
      row.score *
      0.88 ** (groups.get(row.source.group_id) ?? 0) *
      0.8 ** (sessions.get(row.source.session_id) ?? 0) *
      (row.use === "personal_expression" ? 1 : 0.65) *
      (contrast(row.quote) && !result.some((item) => contrast(item.quote)) ? 1.08 : 1);
    remaining.sort((a, b) => adjusted(b) - adjusted(a) || a.id.localeCompare(b.id));
    const index = remaining.findIndex(
      (row) =>
        row.use === "personal_expression" ||
        contexts < 3 ||
        !remaining.some((item) => item.use === "personal_expression"),
    );
    if (index < 0) break;
    const row = remaining.splice(index, 1)[0];
    if (!row) break;
    result.push(row);
    if (row.use !== "personal_expression") contexts++;
    groups.set(row.source.group_id, (groups.get(row.source.group_id) ?? 0) + 1);
    sessions.set(row.source.session_id, (sessions.get(row.source.session_id) ?? 0) + 1);
  }
  return result;
}
