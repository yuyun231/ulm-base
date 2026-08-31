// ulm-harness-spike 插件入口。
// Phase 1（S1–S5）已验证 SDK 接缝；本版接入 P3 受控循环 / P4 适配层 / P5 基座链接：
//   - registerAgentHarness('ulm-controlled')：接管显式 model-scoped pin 的 turn
//   - registerService('ulm-base-link')：每配置 agent 一条基座 WS 连接（register/heartbeat/
//     11 指令路由+ack/事件上报/7 端点），wake/judgeResult 经进程内 gateway 触发 turn
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { AgentHarness, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";

import { createUlmBasePort, startCommandDispatch } from "./base/index.js";
import { createControlledLoop } from "./controlled-loop/index.js";
import {
  createCommandFacade,
  createHarnessAdapter,
  createLocalGatewayRpc,
  HarnessState,
  WakeRegistry,
} from "./openclaw/index.js";
import type { GatewayRequest } from "./openclaw/index.js";
import type { UlmAgentIdentity, UlmBasePort } from "./contracts.js";

const LOG_FILE = fileURLToPath(new URL("../spike.log", import.meta.url));

function log(event: string, data: unknown): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, data });
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, line + "\n", "utf-8");
  } catch {
    // 日志失败不能破坏插件加载
  }
}

// ---------------------------------------------------------------------------
// 插件配置（openclaw.json → plugins.entries.ulm-harness-spike.config）
// ---------------------------------------------------------------------------

export interface UlmHarnessAgentConfig extends UlmAgentIdentity {
  /** openclaw 侧 agent id（基座 agentId 与 openclaw agentId 不同时指定） */
  openclawAgentId?: string;
}

export interface UlmHarnessPluginConfig {
  /** 基座 WS 地址；缺省 ULM_WS_URL 或 ws://localhost:8080 */
  wsUrl?: string;
  /** 本地 OpenClaw Gateway WS 地址（自连触发 turn 用）；缺省 ws://127.0.0.1:18789 */
  gatewayUrl?: string;
  /** Gateway token（gateway.auth.token）；缺省读配置运行时 */
  gatewayToken?: string;
  /** 接管的 agent 清单（基座身份） */
  agents?: UlmHarnessAgentConfig[];
}

const DEFAULT_AGENTS: UlmHarnessAgentConfig[] = [
  {
    agentId: "task-admin",
    role: "task-admin",
    capabilities: ["task:judge", "task:publishChild", "task:restructure"],
    openclawAgentId: "task-admin",
  },
];

function normalizeConfig(raw: unknown): Required<UlmHarnessPluginConfig> {
  const cfg = (raw ?? {}) as UlmHarnessPluginConfig;
  return {
    wsUrl: cfg.wsUrl ?? process.env.ULM_WS_URL ?? "ws://localhost:8080",
    gatewayUrl: cfg.gatewayUrl ?? process.env.ULM_GATEWAY_URL ?? "ws://127.0.0.1:18789",
    gatewayToken: cfg.gatewayToken ?? process.env.ULM_GATEWAY_TOKEN ?? "",
    agents: cfg.agents?.length ? cfg.agents : DEFAULT_AGENTS,
  };
}

// ---------------------------------------------------------------------------
// per-agent 装配（模块级共享：service.start 与 harness.runAttempt 之间传递）
// ---------------------------------------------------------------------------

interface AgentRuntime {
  config: UlmHarnessAgentConfig;
  identity: UlmAgentIdentity;
  openclawAgentId: string;
  basePort: UlmBasePort;
  registry: WakeRegistry;
  state: HarnessState;
  stopDispatch: () => void;
  harness: AgentHarness;
  connected: boolean;
}

const runtimesByBaseId = new Map<string, AgentRuntime>();
const runtimesByOpenclawId = new Map<string, AgentRuntime>();
const loop = createControlledLoop();
const gatewayRpcs: Array<GatewayRequest & { stop(): Promise<void> }> = [];

function buildAgentRuntime(config: UlmHarnessAgentConfig, wsUrl: string, gatewayRequest: GatewayRequest): AgentRuntime {
  const openclawAgentId = config.openclawAgentId ?? config.agentId;
  const identity: UlmAgentIdentity = {
    agentId: config.agentId,
    role: config.role,
    capabilities: config.capabilities ?? [],
  };
  const basePort = createUlmBasePort({
    wsUrl,
    logger: (event, data) => log(`base.${config.agentId}.${event}`, data),
  });
  const registry = new WakeRegistry();
  const state = new HarnessState();
  const facade = createCommandFacade({
    identity,
    openclawAgentId,
    gatewayRequest,
    registry,
    state,
    logger: (event, data) => log(`facade.${config.agentId}.${event}`, data),
  });
  const stopDispatch = startCommandDispatch(basePort, (cmd) => facade.handleCommand(cmd, basePort));
  // 每 agent 一个 harness 实例（同一 id 注册多个由 OpenClaw 取最后注册者；
  // runAttempt 通过 basePortFor/registry 天然隔离）
  const harness = createHarnessAdapter({
    loop,
    registry,
    state,
    basePortFor: () => basePort,
    logger: (event, data) => log(`harness.${config.agentId}.${event}`, data),
  });
  return { config, identity, openclawAgentId, basePort, registry, state, stopDispatch, harness, connected: false };
}

async function startAllAgentRuntimes(config: Required<UlmHarnessPluginConfig>, gatewayRequest: GatewayRequest): Promise<void> {
  for (const agentConfig of config.agents) {
    let runtime = runtimesByBaseId.get(agentConfig.agentId);
    if (runtime?.connected) continue; // 已连接，幂等跳过
    if (!runtime) {
      runtime = buildAgentRuntime(agentConfig, config.wsUrl, gatewayRequest);
      runtimesByBaseId.set(agentConfig.agentId, runtime);
      runtimesByOpenclawId.set(runtime.openclawAgentId, runtime);
    }
    log("link.connecting", { agentId: agentConfig.agentId, wsUrl: config.wsUrl });
    try {
      await runtime.basePort.connect(runtime.identity);
      runtime.connected = true;
      log("link.registered", { agentId: agentConfig.agentId, openclawAgentId: runtime.openclawAgentId, wsUrl: config.wsUrl });
    } catch (err) {
      // 注册失败（基座未起/白名单未登记）：registerRejected 是显式失败，不自动重连；
      // 基座就绪后重启 gateway 恢复
      log("link.register.failed", { agentId: agentConfig.agentId, error: String(err) });
    }
  }
}

async function stopAllAgentRuntimes(): Promise<void> {
  for (const [agentId, rt] of runtimesByBaseId) {
    rt.stopDispatch();
    try {
      await rt.basePort.close();
    } catch (err) {
      log("link.close.error", { agentId, error: String(err) });
    }
  }
  runtimesByBaseId.clear();
  runtimesByOpenclawId.clear();
  for (const rpc of gatewayRpcs.splice(0)) {
    try {
      await rpc.stop();
    } catch {
      // 关闭失败忽略
    }
  }
}

// ---------------------------------------------------------------------------
// 插件注册
// ---------------------------------------------------------------------------

export default definePluginEntry({
  id: "ulm-harness-spike",
  name: "ULM Harness",
  description: "ULM controlled agent harness: base link service + controlled loop harness adapter.",

  register(api) {
    const pluginConfig = normalizeConfig((api as unknown as { pluginConfig?: unknown }).pluginConfig);
    log("plugin.register", { agents: pluginConfig.agents.map((a) => a.agentId), wsUrl: pluginConfig.wsUrl, gatewayUrl: pluginConfig.gatewayUrl });

    // 本地 gateway RPC：第三方插件无 runtime.gateway.request 权限，自连 loopback WS。
    // token 优先取插件配置，缺省由 gateway-rpc 从 ~/.openclaw/openclaw.json 解析。
    const gatewayRequest = createLocalGatewayRpc({
      url: pluginConfig.gatewayUrl,
      ...(pluginConfig.gatewayToken ? { token: pluginConfig.gatewayToken } : {}),
      logger: (event, data) => log(`gatewayRpc.${event}`, data),
    });
    gatewayRpcs.push(gatewayRequest as GatewayRequest & { stop(): Promise<void> });

    // 预构建全部 agent 运行时（register 阶段完成装配；WS 连接在 service.start 里发起，
    // 避免 register 期间阻塞插件加载）
    for (const agentConfig of pluginConfig.agents) {
      if (!runtimesByBaseId.has(agentConfig.agentId)) {
        const runtime = buildAgentRuntime(agentConfig, pluginConfig.wsUrl, gatewayRequest);
        runtimesByBaseId.set(agentConfig.agentId, runtime);
        runtimesByOpenclawId.set(runtime.openclawAgentId, runtime);
      }
    }
    // harness 注册：全部 agent 共用入口；runAttempt 内经 wake registry 匹配——
    // 各 agent registry 独立，只有持有该 wake 的 runtime 能接住，其余返回空结果。
    // 为避免"未命中 wake 的 turn 被别的 agent runtime 误吞"，用一个代理 harness 依次询问。
    const candidateHarnesses = [...runtimesByBaseId.values()].map((rt) => rt.harness);
    const dispatchHarness: AgentHarness = {
      id: "ulm-controlled",
      label: "ULM controlled agent harness",
      supports(ctx) {
        // 任一候选支持即支持（当前所有候选 supports 逻辑一致：显式 pin）
        for (const harness of candidateHarnesses) {
          const result = harness.supports(ctx);
          if (result.supported) return result;
        }
        return { supported: false, reason: "only explicit ulm-controlled runtime" };
      },
      async runAttempt(params) {
        // 按参数里的 openclaw agentId 路由到对应 runtime
        const anyParams = params as unknown as Record<string, unknown>;
        const openclawAgentId = (anyParams.agentId as string | undefined) ?? "";
        const runtime = runtimesByOpenclawId.get(openclawAgentId);
        if (runtime) return runtime.harness.runAttempt(params);
        // 无匹配 runtime（如 ulm-spike 试验 agent）：轮流试（registry 未命中者会安全返回空结果）
        for (const harness of candidateHarnesses) {
          return await harness.runAttempt(params);
        }
        throw new Error("no ulm runtime registered");
      },
    };
    api.registerAgentHarness(dispatchHarness);

    const service = {
      id: "ulm-harness-spike-service",
      async start(_ctx: OpenClawPluginServiceContext) {
        log("service.start.invoked", {});
        try {
          await startAllAgentRuntimes(pluginConfig, gatewayRequest);
          log("service.start.done", {});
        } catch (err) {
          log("service.start.error", { error: String(err) });
        }
      },
      async stop() {
        await stopAllAgentRuntimes();
        log("service.stop", {});
      },
    };
    api.registerService(service as never);

    log("plugin.register.done", { harnessId: "ulm-controlled", serviceId: service.id });
  },
});
