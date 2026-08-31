// P3：ControlledRunHandle——单次受控运行的控制面。
import type {
  UlmLoopPorts,
  UlmModelMessage,
  UlmRunHandle,
  UlmRunInput,
  UlmRunResult,
  UlmRunState,
} from "../contracts.js";
import { buildInitialMessages } from "./messages.js";

const MAX_ROUNDS = 8;

interface ControlQueue {
  corrections: string[]; // correct：system 消息，最高优先级
  injections: string[]; // inject：user 消息
  redoRequested: boolean;
  modelConfig: Record<string, unknown> | null;
  whitelist: string[] | null;
  agentDefText: string | null;
}

export class ControlledRunHandle implements UlmRunHandle {
  readonly runId: string;
  readonly wake: UlmRunInput["wake"];

  private stateValue: UlmRunState = "idle";
  private abortController = new AbortController();
  private done: Promise<UlmRunResult>;
  private queue: ControlQueue = { corrections: [], injections: [], redoRequested: false, modelConfig: null, whitelist: null, agentDefText: null };
  private extraSystem: string[] = [];

  constructor(input: UlmRunInput, private ports: UlmLoopPorts, private dialogueText?: string) {
    this.runId = input.runId;
    this.wake = input.wake;
    this.done = this.execute(input);
  }

  state(): UlmRunState {
    return this.stateValue;
  }

  wait(): Promise<UlmRunResult> {
    return this.done;
  }

  async interrupt(reason?: string): Promise<void> {
    if (reason) {
      // 中断原因落审计：作为后续（可能的）重跑轮次的修正上下文
      this.queue.corrections.push(`[中断] ${reason}`);
    }
    this.abortController.abort();
  }

  async correct(text: string): Promise<void> {
    this.queue.corrections.push(`最高优先级修正指令，必须执行：${text}`);
  }

  async inject(text: string): Promise<void> {
    this.queue.injections.push(`系统注入：${text}`);
  }

  async redo(): Promise<void> {
    this.queue.redoRequested = true;
  }

  applyModelConfig(config: Record<string, unknown>): void {
    this.queue.modelConfig = { ...(this.queue.modelConfig ?? {}), ...config };
  }

  applyWhitelist(toolNames: string[]): void {
    this.queue.whitelist = toolNames;
  }

  applyAgentDef(def: Record<string, unknown>): void {
    this.queue.agentDefText = JSON.stringify(def);
  }

  async sleep(): Promise<void> {
    if (this.stateValue === "running") throw new Error("busy");
  }

  private settle(result: UlmRunResult): UlmRunResult {
    this.stateValue = result.state === "done" ? "done" : result.state === "aborted" ? "aborted" : "error";
    return result;
  }

  private async execute(input: UlmRunInput): Promise<UlmRunResult> {
    this.stateValue = "running";
    const { wake } = input;
    const base = this.ports.base;
    try {
      let messages = buildInitialMessages({ ...input, dialogueText: this.dialogueText });
      let finalText = "";

      for (let round = 1; round <= MAX_ROUNDS; round += 1) {
        if (this.abortController.signal.aborted) {
          return this.settle({ state: "aborted", finalText: "", error: "interrupted" });
        }

        // redo：回滚到初始消息重跑
        if (this.queue.redoRequested) {
          this.queue.redoRequested = false;
          messages = buildInitialMessages({ ...input, dialogueText: this.dialogueText });
          this.extraSystem = [];
        }

        // agentDef：追加到 system 尾部（一次性）
        if (this.queue.agentDefText) {
          this.extraSystem.push(`## Agent 定义更新\n${this.queue.agentDefText}`);
          this.queue.agentDefText = null;
        }

        // 控制注入：correct → system 前插；inject → user 追加
        const roundMessages: UlmModelMessage[] = [...messages];
        for (const correction of this.queue.corrections.splice(0)) {
          roundMessages.push({ role: "system", content: correction });
        }
        for (const agentDef of this.extraSystem.splice(0)) {
          roundMessages.push({ role: "system", content: agentDef });
        }
        for (const injection of this.queue.injections.splice(0)) {
          roundMessages.push({ role: "user", content: injection });
        }
        messages = roundMessages;

        // 事件：每轮模型调用前上报 thought
        base.emitEvent({
          family: "organ",
          subtype: "thought",
          handles: { taskId: wake.taskId },
          payload: { stage: "modelCall", round },
        });

        const modelConfig = (this.queue.modelConfig ?? {}) as { model?: string; thinking?: string; responseFormat?: Record<string, unknown> };
        const turn = await this.ports.model.call(messages, {
          model: modelConfig.model,
          thinking: modelConfig.thinking,
          responseFormat: modelConfig.responseFormat,
          signal: this.abortController.signal,
        });

        if (this.abortController.signal.aborted) {
          return this.settle({ state: "aborted", finalText: "", error: "interrupted" });
        }

        if (turn.toolCalls.length > 0) {
          for (const call of turn.toolCalls) {
            base.emitEvent({
              family: "organ",
              subtype: "action",
              handles: { taskId: wake.taskId },
              payload: { toolName: call.name, args: call.args, round },
            });
            let resultContent: string;
            let isError = false;
            const whitelist = this.queue.whitelist;
            if (whitelist && !whitelist.includes(call.name)) {
              resultContent = `工具 ${call.name} 不在白名单内，拒绝执行`;
              isError = true;
            } else {
              try {
                const executed = await this.ports.tools.execute(call.name, call.args, { signal: this.abortController.signal });
                resultContent = executed.content;
                isError = executed.isError;
              } catch (err) {
                resultContent = `工具执行异常：${String(err)}`;
                isError = true;
              }
            }
            messages.push(
              { role: "assistant", content: turn.text ?? "", toolCallId: call.id },
              { role: "tool", content: resultContent, toolCallId: call.id, name: call.name },
            );
          }
          continue;
        }

        finalText = turn.text;
        break;
      }

      if (!finalText) {
        const error = "模型在最大轮次内未给出最终文本";
        await base.request("reportIssue", { taskId: wake.taskId, issue: error }).catch(() => undefined);
        return this.settle({ state: "error", finalText: "", error });
      }

      const res = await base.request("submitMaterial", {
        taskId: wake.taskId,
        nodeId: wake.task.nodeId ?? "main",
        material: finalText,
        isLastNode: true,
      });
      if (res.ok) {
        return this.settle({ state: "done", finalText, material: finalText });
      }
      await base.request("reportIssue", { taskId: wake.taskId, issue: res.error ?? "submitMaterial failed" }).catch(() => undefined);
      return this.settle({ state: "error", finalText, error: res.error ?? "submitMaterial failed" });
    } catch (err) {
      const error = String(err);
      await base.request("reportIssue", { taskId: wake.taskId, issue: error }).catch(() => undefined);
      if (this.abortController.signal.aborted) {
        return this.settle({ state: "aborted", finalText: "", error: "interrupted" });
      }
      return this.settle({ state: "error", finalText: "", error });
    }
  }
}
