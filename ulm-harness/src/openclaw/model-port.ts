// P4：OpenClawModelPort。把 OpenClaw 已解析的模型/鉴权（runAttempt params.model +
// resolvedApiKey）适配成 UlmModelPort，用 plugin-sdk/llm 的 completeSimple 调模型。
import {
  completeSimple,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
} from "openclaw/plugin-sdk/llm";

import type {
  UlmModelCallOptions,
  UlmModelMessage,
  UlmModelPort,
  UlmModelTurn,
  UlmToolCall,
} from "../contracts.js";

function toLlmMessages(messages: UlmModelMessage[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      // completeSimple 走 Context.systemPrompt，system 消息已在调用方抽出
      continue;
    }
    if (m.role === "user") {
      out.push({ role: "user", content: m.content, timestamp: Date.now() });
    } else if (m.role === "assistant") {
      const zeroUsage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      out.push({
        role: "assistant",
        content: [{ type: "text", text: m.content }],
        api: "openai-completions",
        provider: "openai",
        model: "",
        usage: zeroUsage,
        stopReason: "stop",
        timestamp: Date.now(),
      });
    } else if (m.role === "tool") {
      // 历史工具结果以文本形式回灌（受控循环自己维护工具轮次状态）
      out.push({
        role: "toolResult",
        toolCallId: m.toolCallId ?? "",
        toolName: m.name ?? "",
        content: [{ type: "text", text: m.content }],
        isError: false,
        timestamp: Date.now(),
      });
    }
  }
  return out;
}

function extractText(message: AssistantMessage): string {
  const parts: string[] = [];
  for (const block of message.content ?? []) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n");
}

function extractToolCalls(message: AssistantMessage): UlmToolCall[] {
  const calls: UlmToolCall[] = [];
  for (const block of message.content ?? []) {
    if (block.type === "toolCall") {
      calls.push({
        id: block.id,
        name: block.name,
        args: block.arguments ?? {},
      });
    }
  }
  return calls;
}

export interface OpenClawModelPortOptions {
  model: Model;
  apiKey?: string;
}

export function createOpenClawModelPort(options: OpenClawModelPortOptions): UlmModelPort {
  const { model, apiKey } = options;
  if (!model || typeof model !== "object") {
    throw new Error("OpenClawModelPort unavailable: params.model missing");
  }
  return {
    async call(messages: UlmModelMessage[], callOptions?: UlmModelCallOptions): Promise<UlmModelTurn> {
      const system = messages.find((m) => m.role === "system");
      const context: Context = {
        systemPrompt: system?.content,
        messages: toLlmMessages(messages),
      };
      const assistant = await completeSimple(model, context, {
        ...(apiKey ? { apiKey } : {}),
        ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
      });
      // completeSimple 契约：错误不抛出，编码在 AssistantMessage（stopReason=error + errorMessage）
      if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
        throw new Error(
          `模型调用失败（${assistant.stopReason}）：${assistant.errorMessage ?? "unknown"} code=${assistant.errorCode ?? ""}`,
        );
      }
      return {
        text: extractText(assistant),
        toolCalls: extractToolCalls(assistant),
        raw: assistant,
      };
    },
  };
}
