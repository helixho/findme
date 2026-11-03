// 证据粒度修复:把模型回引用的语料行序号 [n] 解析为权威 record_id。
// 模型不直接吐 UUID(防幻觉/串改),只回序号;序号→record_id 的映射由代码侧在
// 生成当次的语料快照上建立,并立即解析——避免"保存时语料已变、序号错位"。

// 一行语料对应一条 light_extract;ord 为 buildCorpus 当次的逐行序号(从 1 起)。
export type CorpusIndexEntry = {
  ord: number;
  recordId: string;
  createdAt: string;
  sourceType: string;
};
export type CorpusIndex = CorpusIndexEntry[];

// 解析:过滤越界/无法解析/重复的序号,映射到 record_id 并去重。
// 幻觉或越界序号被静默丢弃(兜底),返回的都是真实存在于当次语料的记录。
export function resolveEvidence(ordinals: number[] | undefined, index: CorpusIndex): string[] {
  if (!ordinals?.length) return [];
  const byOrd = new Map(index.map((e) => [e.ord, e.recordId]));
  const ids = new Set<string>();
  for (const o of ordinals) {
    const rid = byOrd.get(o);
    if (rid) ids.add(rid);
  }
  return [...ids];
}

// 是否为"断言":带 inferences(判断)且自评语料充分。断言必须有可溯证据,否则按未验证处理。
// sufficient=false 且无 inferences = 初步印象,不算断言,允许空证据。
export function isAssertion(c: { inferences?: string[]; sufficient?: boolean }): boolean {
  return (c.sufficient ?? true) && (c.inferences?.length ?? 0) > 0;
}
