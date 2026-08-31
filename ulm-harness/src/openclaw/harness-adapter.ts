// P4：HarnessAdapter。AgentHarness.runAttempt(params) → 解析 ULM_WAKE 标记 →
// 取回 wake 上下文 → 组装 ports（模型/工具/基座）→ 跑 P3 受控循环 → 回填 result。
import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness";

import type {
  UlmAgentIdentity,
  UlmBasePort,
  UlmControlledLoop,
  UlmEventInput,
  UlmLoopPorts,
  UlmRunHandle,
  UlmRunResult,
  UlmServiceEndpoint,
  UlmServiceResponse,
  UlmWakePayload,
} from "../contracts.js";
import { parseJudgeVerdict, fallbackVerdict } from "../controlled-loop/judge.js";
import { createOpenClawModelPort } from "./model-port.js";
import { createOpenClawToolPort } from "./tool-port.js";
import { WakeRegistry } from "./wake-registry.js";

export const ULM_WAKE_MARKER = /ULM_WAKE:([A-Za-z0-9_\-.]+)/;

export interface HarnessAdapterDeps {
  loop: UlmControlledLoop;
  registry: WakeRegistry;
  /** agentId（openclaw 侧）→ 基座链接端口；多 agent 部署时各自独立 */
  basePortFor: (agentId: string) => UlmBasePort | null;
  state: HarnessState;
  logger?: (event: string, data: unknown) => void;
}

/** 判定 turn 的完成回调：facade 在 startTurn 前注册，runAttempt 结束时取走结果。 */
interface JudgeCompletion {
  taskId: string;
  purposeId?: string;
  resolve: (verdict: { result: "pass" | "reject"; note?: string }) => void;
}

export class HarnessState {
  private activeHandles = new Map<string, UlmRunHandle>(); // runId → handle
  private judgeWaiters = new Map<string, JudgeCompletion>(); // judge taskId → completion

  registerHandle(runId: string, handle: UlmRunHandle): void {
    this.activeHandles.set(runId, handle);
  }

  removeHandle(runId: string): void {
    this.activeHandles.delete(runId);
  }

  activeHandle(): UlmRunHandle | null {
    for (const handle of this.activeHandles.values()) return handle;
    return null;
  }

  registerJudge(completion: JudgeCompletion): void {
    this.judgeWaiters.set(completion.taskId, completion);
  }

  takeJudge(taskId: string): JudgeCompletion | undefined {
    const completion = this.judgeWaiters.get(taskId);
    if (completion) this.judgeWaiters.delete(taskId);
    return completion;
  }
}

function emptyResult(params: { sessionId: string }, classification: "empty" | "reasoning-only" | "planning-only" | undefined) {
  return {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    promptError: null,
    promptErrorSource: null,
    sessionIdUsed: params.sessionId,
    messagesSnapshot: [],
    ...(classification ? { agentHarnessResultClassification: classification } : {}),
  } as Record<string, unknown>;
}

export function createHarnessAdapter(deps: HarnessAdapterDeps): AgentHarness {
  const log = deps.logger ?? (() => {});
  const state = deps.state;

  return {
    id: "ulm-controlled",
    label: "ULM controlled agent harness",

    supports(ctx) {
      if (ctx.requestedRuntime === "ulm-controlled") {
        return { supported: true, priority: 100, reason: "ulm controlled runtime" };
      }
      return { supported: false, reason: "only explicit ulm-controlled runtime" };
    },

    async runAttempt(params) {
      const anyParams = params as unknown as Record<string, unknown>;
      const sessionId = params.sessionId;
      const sessionKey = (anyParams.sessionKey as string | undefined) ?? "";
      const agentId = (anyParams.agentId as string | undefined) ?? "";
      log("runAttempt.invoked", {
        sessionId,
        sessionKey,
        agentId,
        modelId: params.modelId,
        promptLength: params.prompt?.length ?? 0,
        promptPreview: params.prompt?.slice(0, 120),
      });

      // 1) 提取 ULM_WAKE 标记 → 取回 wake 上下文
      const marker = ULM_WAKE_MARKER.exec(params.prompt ?? "");
      const registered = marker ? deps.registry.take(marker[1]!) : undefined;
      if (!registered) {
        // 非 ULM 触发的 turn（人工聊天等）：不接管业务语义，返回空结果
        log("runAttempt.noWakeContext", { sessionKey });
        return emptyResult(params, "empty") as never;
      }
      const wake = registered.wake;
      const basePort = deps.basePortFor(agentId);

      // 2) 组装 ports
      const modelPort = createOpenClawModelPort({
        model: params.model,
        apiKey: params.resolvedApiKey,
      });
      const toolPort = createOpenClawToolPort({
        agentId,
        workspaceDir: params.workspaceDir,
        cwd: (anyParams.cwd as string | undefined) ?? params.workspaceDir,
        sessionKey,
        sessionId,
        runId: (anyParams.runId as string | undefined) ?? wake.taskId,
        abortSignal: params.abortSignal,
        logger: log,
      });
      // 判定 turn 不给工具
      const isJudge = registered.judge !== undefined;
      const baseAdapter = basePort
        ? {
            emitEvent(event: UlmEventInput): void {
              try {
                basePort.emitEvent(event);
              } catch (err) {
                log("base.emitEvent.error", { error: String(err) });
              }
            },
            async request(endpoint: UlmServiceEndpoint, args: Record<string, unknown>): Promise<UlmServiceResponse> {
              if (!basePort) return { ok: false, error: "base port 未就绪" };
              return basePort.request(endpoint, args);
            },
          }
        : {
            emitEvent(event: UlmEventInput): void {
              log("base.emitEvent.skipped", { family: event.family, subtype: event.subtype });
            },
            async request(): Promise<UlmServiceResponse> {
              return { ok: false, error: "base port 未就绪" };
            },
          };

      const ports: UlmLoopPorts = {
        model: modelPort,
        tools: isJudge
          ? {
              list: () => [],
              async execute() {
                return { content: "判定模式无工具", isError: true };
              },
            }
          : toolPort,
        base: baseAdapter,
      };

      // 3) 跑循环
      const handle = deps.loop.createHandle(
        { runId: (anyParams.runId as string | undefined) ?? `ulm-${wake.taskId}`, wake },
        ports,
      );
      const runIdKey = (anyParams.runId as string | undefined) ?? sessionId;
      state.registerHandle(runIdKey, handle);
      const onAbort = () => void handle.interrupt("openclaw-abort");
      params.abortSignal?.addEventListener("abort", onAbort, { once: true });

      let result: UlmRunResult;
      try {
        result = await handle.wait();
      } finally {
        params.abortSignal?.removeEventListener("abort", onAbort);
        state.removeHandle(runIdKey);
      }

      log("runAttempt.finished", { sessionKey, state: result.state, error: result.error ?? null });

      // 4) 判定 turn：解析 verdict 并唤醒等待的 facade
      if (isJudge) {
        const verdict = parseJudgeVerdict(result.finalText) ?? fallbackVerdict(result.finalText);
        const completion = state.takeJudge(wake.taskId);
        completion?.resolve(verdict);
      }

      // 5) 流式回执（可选）
      if (result.finalText) {
        try {
          await params.onPartialReply?.({ text: result.finalText } as never);
        } catch (err) {
          log("runAttempt.onPartialReply.error", { error: String(err) });
        }
      }

      // 6) 回填 OpenClaw result
      const aborted = result.state === "aborted";
      return {
        aborted,
        externalAbort: aborted,
        timedOut: false,
        idleTimedOut: false,
        timedOutDuringCompaction: false,
        promptError: result.state === "error" ? new Error(result.error ?? "ulm loop error") : null,
        promptErrorSource: result.state === "error" ? "prompt" : null,
        sessionIdUsed: sessionId,
        messagesSnapshot: [],
        assistantTexts: result.finalText ? [result.finalText] : [],
        lastAssistant: undefined,
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
        cloudCodeAssistFormatError: false,
        toolMetas: [],
        replayMetadata: { replaySafe: false } as never,
        itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
      } as never;
    },
  };
}
