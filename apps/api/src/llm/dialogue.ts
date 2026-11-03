import type { DialogueTurn } from "@findme/shared";
import type { createGateway } from "./gateway.js";

type Gateway = Pick<ReturnType<typeof createGateway>, "chat">;
type Role = DialogueTurn["role"];
type Turn = DialogueTurn["history"][number];

// 全角色共享的硬边界(V1 自用基线:陪伴式倾听,不评判/不建议/不诊断)。
const BASE = `你在和用户进行一对一的私人对话,帮 ta 把心里的事说出来。
绝对边界:不评判、不下结论、不给建议或方案、不贴任何心理学标签、不做诊断。
你只做两件事:轻轻接住 ta 说的,以及在合适时帮 ta 多说一点。
用自然口语的中文,简短(最多 2-3 句),不要客套和说教。`;

// 角色骨架(占位,可后续调)。"空白"= 不设角色、纯记录,不产生回应。
const ROLE_PROMPT: Record<Exclude<Role, "空白">, string> = {
  晨: `${BASE}
你是「晨」:温和、好奇、清醒。可以就 ta 说的往下追问一层——问一个具体、不评判的问题,帮 ta 说得更清楚。`,
  夜: `${BASE}
你是「夜」:安静、平和,像睡前。只回应、轻轻接住,不追问、不抛新问题。比平时更简短。`,
};

// 经 M-X2 gateway 生成角色回应。"空白"返回 null(纯记录,无回应)。
export async function generateReply(
  gateway: Gateway,
  role: Role,
  message: string,
  history: Turn[],
): Promise<string | null> {
  if (role === "空白") return null;
  const messages = [
    { role: "system" as const, content: ROLE_PROMPT[role] },
    ...history.map((h) => ({
      role: (h.role === "user" ? "user" : "assistant") as "user" | "assistant",
      content: h.text,
    })),
    { role: "user" as const, content: message },
  ];
  const { text } = await gateway.chat({ route: "dialogue", messages });
  return text.trim() || null;
}
