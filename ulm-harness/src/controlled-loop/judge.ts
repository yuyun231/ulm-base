// P3：判定结果解析。严格 JSON {"result":"pass"|"reject","note":"..."}，容忍 code fence；
// 解析不出明确 pass/reject 时按 ULM 判定基线"拿不准=fail"返回 reject。
export interface JudgeVerdict {
  result: "pass" | "reject";
  note?: string;
}

export function parseJudgeVerdict(text: string): JudgeVerdict | null {
  if (!text) return null;
  const candidates: string[] = [];
  // 1) 直接整体解析
  candidates.push(text.trim());
  // 2) markdown code fence 内容
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  // 3) 首个 {...} 平衡块
  const start = text.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < text.length; i += 1) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && (parsed.result === "pass" || parsed.result === "reject")) {
        return {
          result: parsed.result,
          note: typeof parsed.note === "string" ? parsed.note : undefined,
        };
      }
    } catch {
      // 尝试下一个候选
    }
  }
  return null;
}

/** 解析失败时的保守裁决：reject（宁可打回不放水）。 */
export function fallbackVerdict(text: string): JudgeVerdict {
  return { result: "reject", note: `无法解析判定输出，保守打回。原文：${text.slice(0, 200)}` };
}
