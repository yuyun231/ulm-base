// P3：把 UlmWakePayload 组装成初始 UlmModelMessage[]。
import type { UlmModelMessage, UlmRunInput, UlmWakePayload } from "../contracts.js";

function guidanceLines(wake: UlmWakePayload): string[] {
  if (!wake.guidance?.length) return [];
  const lines = ["## 指导（必须遵循）"];
  for (const g of wake.guidance) {
    lines.push(`- [${g.type}] ${g.content}`);
  }
  return lines;
}

function permissionLines(wake: UlmWakePayload): string[] {
  if (!wake.permissions?.length) return [];
  const lines = ["## 权限事实（这是事实陈述，不是可更改的建议）"];
  for (const p of wake.permissions) {
    lines.push(`- ${p.subject} → ${p.action}：${p.effect}`);
  }
  return lines;
}

/** 组装受控循环初始消息：system（任务上下文）+ user（goal+AC），可选对话前文。 */
export function buildInitialMessages(input: UlmRunInput): UlmModelMessage[] {
  const wake = input.wake;
  const sections: string[] = [
    "你是 ULM 受控执行 agent。严格按任务目标工作，最终回复即为提交给基座的材料。",
    `## 任务\n- taskId: ${wake.taskId}\n- taskType: ${wake.task.taskType}\n- workspaceId: ${wake.task.workspaceId ?? "无"}`,
  ];
  if (wake.task.goal) sections.push(`## 目标\n${wake.task.goal}`);
  if (wake.task.acceptanceCriteria) sections.push(`## 验收标准\n${wake.task.acceptanceCriteria}`);
  sections.push(...guidanceLines(wake));
  sections.push(...permissionLines(wake));

  const messages: UlmModelMessage[] = [{ role: "system", content: sections.join("\n\n") }];
  if (wake.dialogue.mode === "continue" && input.dialogueText) {
    messages.push({ role: "user", content: input.dialogueText });
  }
  messages.push({
    role: "user",
    content: `任务目标：${wake.task.goal ?? "(无)"}\n\n验收标准：${wake.task.acceptanceCriteria ?? "(无)"}`,
  });
  return messages;
}
