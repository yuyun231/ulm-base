// P4：UlmHarnessCommandFacade。11 条控制命令的类型化路由 → ack。
// wake/judgeResult 经 TurnStarter 触发 OpenClaw turn；运行中控制路由到 active handle。
import { randomUUID } from "node:crypto";

import type {
  UlmAgentIdentity,
  UlmBasePort,
  UlmControlAck,
  UlmControlCommand,
  UlmHarnessCommandFacade,
  UlmWakePayload,
} from "../contracts.js";
import { HarnessState } from "./harness-adapter.js";
import { createTurnStarter, ulmSessionKey, type GatewayRequest } from "./turn-starter.js";
import { WakeRegistry } from "./wake-registry.js";

export interface CommandFacadeDeps {
  identity: UlmAgentIdentity;
  /** openclaw 侧 agent id（chat.send 路由用；缺省 identity.agentId） */
  openclawAgentId?: string;
  gatewayRequest: GatewayRequest;
  registry: WakeRegistry;
  state: HarnessState;
  logger?: (event: string, data: unknown) => void;
}

export function createCommandFacade(deps: CommandFacadeDeps): UlmHarnessCommandFacade {
  const log = deps.logger ?? (() => {});
  const starter = createTurnStarter({
    gatewayRequest: deps.gatewayRequest,
    registry: deps.registry,
    openclawAgentId: deps.openclawAgentId,
    logger: log,
  });
  // 下一个 wake 前应用的 pending 控制
  let pendingModelConfig: Record<string, unknown> | null = null;
  let pendingWhitelist: string[] | null = null;
  let pendingAgentDef: Record<string, unknown> | null = null;
  const pendingCorrections: string[] = [];
  const pendingInjections: string[] = [];

  function ack(cmd: UlmControlCommand, success: boolean, detail?: string, extra?: { result?: unknown }): UlmControlAck {
    return {
      commandId: cmd.commandId,
      agentId: cmd.agentId,
      success,
      ...(detail !== undefined ? { detail } : {}),
      ...(cmd.taskId !== undefined ? { taskId: cmd.taskId } : {}),
      ...(cmd.purposeId !== undefined ? { purposeId: cmd.purposeId } : {}),
      ...(extra?.result !== undefined ? { result: extra.result } : {}),
    };
  }

  /** 判定闭环：合成 judge wake → startTurn → 等 runAttempt 完成回调 → verdict。 */
  async function runJudge(cmd: UlmControlCommand, base: UlmBasePort): Promise<UlmControlAck> {    const payload = cmd.payload as Record<string, unknown>;
    const question = String(payload.question ?? "");
    const context = payload.context;
    const judgeTaskId = `judge-${cmd.taskId ?? randomUUID().slice(0, 8)}-${randomUUID().slice(0, 6)}`;
    const judgeWake: UlmWakePayload = {
      taskId: judgeTaskId,
      task: {
        taskId: judgeTaskId,
        taskType: "judge",
        goal:
          `你是 ULM 判定器。严格对照验收标准审查材料，只输出严格 JSON：{"result":"pass"|"reject","note":"..."}。\n` +
          `判定问题：${question}\n上下文：${JSON.stringify(context ?? {})}`,
        acceptanceCriteria: "输出必须是可解析的 JSON 且 result 为 pass 或 reject；材料不完整或拿不准时必须 reject。",
        dagVersion: 1,
        parentTaskId: null,
        dialogueId: null,
        workspaceId: null,
        nodeId: null,
      },
      dialogue: { dialogueId: null, mode: "new" },
      guidance: [],
      permissions: [],
      workspace: { workspaceId: null },
    };
    deps.registry.register(judgeWake, {
      taskId: cmd.taskId,
      purposeId: cmd.purposeId,
      question,
      context,
    });

    const verdict = await new Promise<{ result: "pass" | "reject"; note?: string }>((resolve) => {
      // 超时兜底：60s 未回来按保守打回
      const timer = setTimeout(() => resolve({ result: "reject", note: "judge-timeout" }), 60_000);
      deps.state.registerJudge({
        taskId: judgeTaskId,
        purposeId: cmd.purposeId,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
      });
      void starter.startTurn(judgeWake, deps.identity).then((turnResult) => {
        if (turnResult.status === "rejected") {
          clearTimeout(timer);
          resolve({ result: "reject", note: `judge turn rejected: ${turnResult.detail ?? ""}` });
        }
      });
    });

    // 判定基线：拿不准=fail；verdict 走 ack 的 result+detail（基座 piercingAcked 丢弃 result 字段，
    // value_compare 投影用 success 布尔 + detail 文本）
    return ack(cmd, verdict.result === "pass", `判定结果：${verdict.result}${verdict.note ? `。${verdict.note}` : ""}`, {
      result: { result: verdict.result, note: verdict.note },
    });
  }

  async function handleCommand(cmd: UlmControlCommand, base: UlmBasePort): Promise<UlmControlAck> {
    const payload = cmd.payload as Record<string, unknown>;
    const handle = deps.state.activeHandle();

    switch (cmd.command) {
      case "wake": {
        // 基座 Phase 0 后载荷：{taskId, nodeId, dag, task{...}, dialogue, guidance, permissions, workspace}
        // （P5 层已把顶层 taskId 并回 payload；这里按 wake 完整形状解析）
        const wake = payload as unknown as UlmWakePayload;
        if (!wake || typeof wake.taskId !== "string") {
          return ack(cmd, false, "wake 载荷缺 taskId");
        }
        // nodeId 兼容：载荷顶层 nodeId（新基座）→ task.nodeId（contracts 形状）
        if (typeof payload.nodeId === "string" && payload.nodeId && wake.task) {
          (wake.task as { nodeId?: string | null }).nodeId = payload.nodeId;
        }
        // pending 控制应用到本任务（写入 registry 前仅记录；具体应用在 handle 创建时经 facade 注入）
        const turn = await starter.startTurn(wake, deps.identity);
        if (turn.status === "rejected") {
          return ack(cmd, false, `turn 触发失败：${turn.detail ?? ""}`);
        }
        // 挂起控制转交新 handle（在下一次 runAttempt 取到 handle 后应用）
        if (pendingModelConfig || pendingWhitelist || pendingAgentDef || pendingCorrections.length || pendingInjections.length) {
          const registeredHandle = deps.state.activeHandle();
          if (registeredHandle) {
            if (pendingModelConfig) registeredHandle.applyModelConfig(pendingModelConfig);
            if (pendingWhitelist) registeredHandle.applyWhitelist(pendingWhitelist);
            if (pendingAgentDef) registeredHandle.applyAgentDef(pendingAgentDef);
            for (const c of pendingCorrections.splice(0)) await registeredHandle.correct(c);
            for (const i of pendingInjections.splice(0)) await registeredHandle.inject(i);
            pendingModelConfig = null;
            pendingWhitelist = null;
            pendingAgentDef = null;
          }
        }
        return ack(cmd, true, `turn 已触发：${turn.sessionKey}`);
      }

      case "sleep": {
        if (handle) return ack(cmd, false, "busy");
        return ack(cmd, true, "进程存活，进入空闲");
      }

      case "interrupt": {
        if (!handle) return ack(cmd, true, "no-active-run");
        await handle.interrupt("base-interrupt");
        await starter.abortTurn(handle.runId, "base-interrupt").catch(() => undefined);
        return ack(cmd, true, "已中止当前 run");
      }

      case "correct": {
        const text = String(payload.content ?? "");
        if (handle) {
          await handle.correct(text);
          await starter.steerTurn(handle.runId, text).catch(() => undefined);
          return ack(cmd, true, "修正已注入运行中任务");
        }
        pendingCorrections.push(text);
        return ack(cmd, true, "无活跃 run，修正已排队待下次 wake");
      }

      case "inject": {
        const text = String(payload.content ?? payload.question ?? "");
        if (handle) {
          await handle.inject(text);
          await starter.injectTurn(handle.runId, text).catch(() => undefined);
          return ack(cmd, true, "注入已送达运行中任务");
        }
        pendingInjections.push(text);
        return ack(cmd, true, "无活跃 run，注入已排队待下次 wake");
      }

      case "redo": {
        if (handle) {
          await handle.redo();
          return ack(cmd, true, "已重跑当前任务");
        }
        const last = deps.registry.last;
        if (last) {
          const turn = await starter.startTurn(last, deps.identity);
          return ack(cmd, turn.status !== "rejected", turn.status === "rejected" ? `重触发失败：${turn.detail ?? ""}` : "已重触发上一任务");
        }
        return ack(cmd, false, "无可重做的任务");
      }

      case "reorder": {
        return ack(cmd, true, "noop:v1-single-active-task");
      }

      case "modelConfig": {
        const config = (payload.config ?? payload) as Record<string, unknown>;
        if (handle) handle.applyModelConfig(config);
        pendingModelConfig = { ...(pendingModelConfig ?? {}), ...config };
        return ack(cmd, true, "模型配置已更新");
      }

      case "whitelist": {
        const tools = payload.whitelist ?? payload.tools;
        if (!Array.isArray(tools)) return ack(cmd, false, "whitelist 载荷缺工具数组");
        const names = tools.map(String);
        if (handle) handle.applyWhitelist(names);
        pendingWhitelist = names;
        return ack(cmd, true, `白名单已更新（${names.length} 项）`);
      }

      case "agentDef": {
        const def = (payload.def ?? payload) as Record<string, unknown>;
        if (handle) handle.applyAgentDef(def);
        pendingAgentDef = def;
        return ack(cmd, true, "agent 定义已更新");
      }

      case "judgeResult": {
        return runJudge(cmd, base);
      }

      default: {
        return ack(cmd, false, `未知命令：${(cmd as { command?: string }).command ?? ""}`);
      }
    }
  }

  return { handleCommand };
}

export { ulmSessionKey };
