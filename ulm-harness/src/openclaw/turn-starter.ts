// P4：TurnStarter。wake 到达 → 注册 wake 上下文 → 经进程内 gateway RPC（chat.send）
// 触发一次本地 turn，让 OpenClaw 走正常流程选中 ULM harness 并回调 runAttempt。
// 消息首行携带 ULM_WAKE:<taskId> 标记，runAttempt 凭此取回 wake。
import { randomUUID } from "node:crypto";

import type {
  UlmAgentIdentity,
  UlmStartTurnResult,
  UlmTurnStarter,
  UlmWakePayload,
} from "../contracts.js";
import { WakeRegistry } from "./wake-registry.js";

export type GatewayRequest = (method: string, params?: unknown) => Promise<unknown>;

export interface TurnStarterDeps {
  gatewayRequest: GatewayRequest;
  registry: WakeRegistry;
  /** openclaw 侧 agent id（chat.send 路由用；缺省用 identity.agentId） */
  openclawAgentId?: string;
  logger?: (event: string, data: unknown) => void;
}

export function ulmSessionKey(openclawAgentId: string, taskId: string): string {
  return `agent:${openclawAgentId}:ulm:${taskId}`;
}

/** wake → 触发消息文本（含 ULM_WAKE 标记）。 */
export function buildWakeMessage(wake: UlmWakePayload): string {
  return [
    `ULM_WAKE:${wake.taskId}`,
    "",
    `任务目标：${wake.task.goal ?? "(无)"}`,
    "",
    `验收标准：${wake.task.acceptanceCriteria ?? "(无)"}`,
  ].join("\n");
}

export function createTurnStarter(deps: TurnStarterDeps): UlmTurnStarter {
  const log = deps.logger ?? (() => {});
  const runIdBySessionKey = new Map<string, string>();

  async function startTurn(wake: UlmWakePayload, identity: UlmAgentIdentity): Promise<UlmStartTurnResult> {
    deps.registry.register(wake);
    const openclawAgentId = deps.openclawAgentId ?? identity.agentId;
    const sessionKey = ulmSessionKey(openclawAgentId, wake.taskId);
    const message = buildWakeMessage(wake);
    const idempotencyKey = `ulm-${wake.taskId}-${randomUUID()}`;
    try {
      const response = (await deps.gatewayRequest("chat.send", {
        sessionKey,
        agentId: openclawAgentId,
        message,
        deliver: false,
        idempotencyKey,
      })) as { runId?: string; status?: string } | undefined;
      const runId = typeof response?.runId === "string" ? response.runId : `local-${randomUUID()}`;
      if (response?.runId) runIdBySessionKey.set(sessionKey, response.runId);
      log("turnStarter.started", { sessionKey, runId, status: response?.status });
      return { runId, sessionKey, status: "started" };
    } catch (err) {
      log("turnStarter.error", { sessionKey, error: String(err) });
      return { runId: `local-${randomUUID()}`, sessionKey, status: "rejected", detail: String(err) };
    }
  }

  return {
    startTurn,

    async abortTurn(runId: string, reason?: string): Promise<void> {
      try {
        await deps.gatewayRequest("chat.abort", { runId, ...(reason ? { reason } : {}) });
      } catch (err) {
        log("turnStarter.abort.error", { runId, error: String(err) });
      }
    },

    async steerTurn(runId: string, text: string): Promise<void> {
      // 会话内 steer：sessions.steer 与 sessions.send 同参，落到 sessionKey 上
      const sessionKey = [...runIdBySessionKey.entries()].find(([, rid]) => rid === runId)?.[0];
      if (!sessionKey) {
        log("turnStarter.steer.noSession", { runId });
        return;
      }
      try {
        await deps.gatewayRequest("sessions.steer", { key: sessionKey, message: text });
      } catch (err) {
        log("turnStarter.steer.error", { runId, error: String(err) });
      }
    },

    async injectTurn(runId: string, text: string): Promise<void> {
      const sessionKey = [...runIdBySessionKey.entries()].find(([, rid]) => rid === runId)?.[0];
      if (!sessionKey) {
        log("turnStarter.inject.noSession", { runId });
        return;
      }
      try {
        await deps.gatewayRequest("chat.inject", { sessionKey, message: text });
      } catch (err) {
        log("turnStarter.inject.error", { runId, error: String(err) });
      }
    },
  };
}
