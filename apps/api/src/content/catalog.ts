import { ContentBundle, type ContentCardVersion, isReleaseReady } from "@findme/core";

// Public method material is versioned with the application. Keep published
// versions immutable; a future correction is a new version or a withdrawal.
const aNewEarthV1: ContentCardVersion = ContentBundle.shape.versions.element.parse({
  content_id: "perspective.a-new-earth",
  version: "1.0.0",
  status: "published",
  title: "《新世界》：自我叙事与角色",
  summary:
    "一张有限的文学反思卡：借作品中关于 ego 与角色扮演的章节，询问某个自我叙事或角色是否影响了当下理解；不把作品观点当作对个人的解释。",
  sources: [
    {
      id: "source.a-new-earth.book",
      title: "A New Earth: Awakening to Your Life's Purpose",
      creator: "Eckhart Tolle",
      source_type: "book",
      url: "https://www.penguinrandomhouse.com/books/291884/a-new-earth-by-eckhart-tolle/9780452289963/",
      edition: "Chapters Two and Four; page numbers vary by edition.",
    },
    {
      id: "source.a-new-earth.loc-catalog",
      title: "A New Earth — Table of Contents",
      creator: "Library of Congress",
      source_type: "other",
      url: "https://catdir.loc.gov/catdir/toc/ecip0518/2005023358.html",
    },
  ],
  evidence_chunks: [
    {
      id: "chunk.a-new-earth.chapter-two",
      source_id: "source.a-new-earth.loc-catalog",
      source_version:
        "Library of Congress prepublication table of contents; printed editions may differ",
      locator: "Chapter Two: Ego: The Current State of Humanity",
      fragment: "该章标题将 ego 与人类当下状态并置为讨论主题。",
      fragment_kind: "bibliographic",
      attribution: "章节标题据 Library of Congress 目录核对；未引用正文。",
    },
    {
      id: "chunk.a-new-earth.chapter-four",
      source_id: "source.a-new-earth.loc-catalog",
      source_version:
        "Library of Congress prepublication table of contents; printed editions may differ",
      locator: "Chapter Four: Role-playing: The Many Faces of the Ego",
      fragment: "该章标题把 role-playing 作为 ego 的一个讨论主题。",
      fragment_kind: "bibliographic",
      attribution: "章节标题据 Library of Congress 目录核对；未引用正文。",
    },
  ],
  claims: [
    {
      id: "claim.a-new-earth.role-and-self-narrative",
      text: "作品中关于 ego 与角色扮演的章节可作为一个有限提问视角：某个自我叙事或承担的角色，是否影响了本人对这件具体处境的理解？",
      applicability_keys: ["voluntary_perspective", "concrete_situation", "role_or_self_narrative"],
      not_applicable_keys: [
        "no_consent",
        "no_concrete_situation",
        "urgent_or_crisis_support",
        "clinical_decision",
      ],
      evidence_chunk_ids: ["chunk.a-new-earth.chapter-two", "chunk.a-new-earth.chapter-four"],
      applicable_when: [
        "用户主动开启《新世界》视角，并提供一件具体处境。",
        "用户希望检查某个角色或自我叙事是否影响了当下理解。",
      ],
      not_applicable_when: [
        "用户未开启作品视角或没有提供具体处境。",
        "当前需要的是事实核验、紧急支持或专业判断。",
        "用户不认同或不想使用作品中的 ego / role-playing 词汇。",
      ],
      alternative_explanations: [
        "用户的理解也可能准确反映当前事实、责任或现实约束，不需要借助自我叙事解释。",
        "承担某个角色可能是用户主动选择并认可的，不必然带来误解或困扰。",
      ],
      candidate_options: ["回看一个具体处境：有没有某个自我叙事或角色影响了你当时的理解？"],
      burdens: ["回想处境并比较不同理解可能需要额外时间和注意力。"],
      costs: ["若继续探索，可能触及用户不想展开的身份或关系问题；用户可跳过。"],
      unknowns: ["章节目录只能核对主题定位，不能单独确定作品论证或用户处境。"],
      limits: [
        "这是对作品章节主题的有限现代转述，不是作者对用户的判断。",
        "它不证明用户由 ego 驱动、误解处境或具有任何人格特征。",
        "卡片不输出分数、等级、诊断或事实结论。",
      ],
    },
  ],
  review: {
    source_verified: true,
    locator_verified: true,
    claims_match_sources: true,
    applicability_and_limits_reviewed: true,
    alternatives_reviewed: true,
    no_personal_diagnosis_or_rating: true,
    release_approved: true,
    reviewer: "independent-agent-content-review",
    reviewed_at: "2026-10-22T15:08:45Z",
  },
  published_at: "2026-10-22T15:08:45Z",
  withdrawn_at: null,
});

const adhdEnvironmentalAdjustmentV1: ContentCardVersion =
  ContentBundle.shape.versions.element.parse({
    content_id: "support.adhd-environmental-adjustments",
    version: "1.0.0",
    status: "published",
    title: "按实际困难尝试一项环境调整",
    summary:
      "依据 NICE NG87 的环境调整建议，围绕一个具体场景选择低负担候选；选择不表示诊断，也不承诺有效。",
    sources: [
      {
        id: "source.nice.ng87",
        title: "Attention deficit hyperactivity disorder: diagnosis and management (NG87)",
        creator: "National Institute for Health and Care Excellence (NICE)",
        source_type: "article",
        url: "https://www.nice.org.uk/guidance/ng87/chapter/recommendations",
        edition: "Recommendations; Terms used in this guideline > Environmental modifications",
      },
    ],
    evidence_chunks: [
      {
        id: "chunk.nice.ng87.environmental-modifications",
        source_id: "source.nice.ng87",
        source_version: "NICE guideline NG87, recommendations page; checked 2026-10-22",
        locator: "Terms used in this guideline > Environmental modifications",
        fragment:
          "NICE 将环境调整描述为按个人需要评估的、针对日常影响的物理环境变化；举例包括座位、照明与噪声、减少干扰、缩短专注时段并安排活动休息，以及用书面说明补充口头请求。",
        fragment_kind: "paraphrase",
        attribution: "NICE NG87 recommendation 术语段落转述；本卡不复制原文。",
      },
    ],
    claims: [
      {
        id: "claim.nice.ng87.environmental-adjustments",
        text: "当一个具体任务受到环境干扰或持续专注负担影响时，可与本人一起从环境和任务安排中挑选一项调整试行，再看实际作用。",
        applicability_keys: [
          "concrete_task",
          "task_sustain",
          "distraction",
          "noise",
          "light",
          "seating",
          "movement_break",
          "written_instructions",
        ],
        not_applicable_keys: [
          "urgent_or_crisis_support",
          "clinical_decision",
          "safety_constraint",
          "no_concrete_task",
          "no_consent",
        ],
        evidence_chunk_ids: ["chunk.nice.ng87.environmental-modifications"],
        applicable_when: [
          "用户主动要求支持，描述了具体任务、环境和遇到的困难。",
          "调整适用于该场景，并且可由用户选择、跳过或撤回。",
        ],
        not_applicable_when: [
          "用户没有描述具体困难，或暂时不想尝试调整。",
          "调整会影响安全、他人权益或岗位的必要职责，且尚未和相关方确认。",
          "需要临床判断、诊断或治疗选择的情形。",
        ],
        alternative_explanations: [
          "困难也可能主要来自任务目标不清、资源不足、睡眠或其他健康状况；环境改变未必触及原因。",
          "当前环境可能本来就适合用户；不调整也可以是合适选择。",
        ],
        candidate_options: [
          "按具体场景调整座位、光线或噪声，减少干扰。",
          "试用较短的专注时段并安排活动休息。",
          "用书面说明补充口头提出的任务要求。",
        ],
        burdens: [
          "记录一次任务前后的差异需要少量注意力；用户可不记录或随时停止。",
          "向工作或学习场所提出调整可能需要沟通精力。",
        ],
        costs: [
          "耳机、换座位或休息安排可能带来金钱、协作或时间成本，具体依场景而定。",
          "较短专注时段可能减少连续工作时间；口头信息改为书面信息也会增加整理成本。",
        ],
        unknowns: [
          "尚不知道哪一项调整适合这个人、这个任务和这个场景。",
          "单次尝试不能证明长期疗效，也不能确定困难的诊断原因。",
        ],
        limits: [
          "NICE NG87 面向 ADHD 的识别与管理；使用本卡不代表用户有 ADHD。",
          "候选调整不是诊断、治疗或疗效承诺；实际效果由用户观察并决定是否保留。",
          "专业或工作场景中的安排须结合个人需求与场所条件判断。",
        ],
      },
    ],
    review: {
      source_verified: true,
      locator_verified: true,
      claims_match_sources: true,
      applicability_and_limits_reviewed: true,
      alternatives_reviewed: true,
      no_personal_diagnosis_or_rating: true,
      release_approved: true,
      reviewer: "independent-agent-content-review",
      reviewed_at: "2026-10-22T15:08:45Z",
    },
    published_at: "2026-10-22T15:08:45Z",
    withdrawn_at: null,
  });

const bundles = [
  ContentBundle.parse({
    content_id: "perspective.a-new-earth",
    current_version: aNewEarthV1.version,
    versions: [aNewEarthV1],
  }),
  ContentBundle.parse({
    content_id: "support.adhd-environmental-adjustments",
    current_version: adhdEnvironmentalAdjustmentV1.version,
    versions: [adhdEnvironmentalAdjustmentV1],
  }),
] as const;

/** Returns only released versions eligible for new requests. */
export function listPublishedContent(): ContentCardVersion[] {
  return bundles.flatMap((bundle) => {
    const current = bundle.versions.find((version) => version.version === bundle.current_version);
    return current && isReleaseReady(current) ? [current] : [];
  });
}

/** Resolves the current released version for a new request. */
export function getPublishedContent(contentId: string): ContentCardVersion | null {
  return listPublishedContent().find((candidate) => candidate.content_id === contentId) ?? null;
}

/** Exact historical lookup; callers must not use this to select new content. */
export function getContentVersion(contentId: string, version: string) {
  return (
    bundles
      .find((bundle) => bundle.content_id === contentId)
      ?.versions.find((candidate) => candidate.version === version) ?? null
  );
}

/** Resolves a claim only from the currently released version. */
export function getPublishedClaim(contentId: string, claimId: string) {
  const version = getPublishedContent(contentId);
  if (!version) return null;
  const claim = version.claims.find((candidate) => candidate.id === claimId);
  return claim ? { version, claim } : null;
}
