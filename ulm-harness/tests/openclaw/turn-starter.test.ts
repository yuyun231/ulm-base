// P4 测试：TurnStarter + CommandFacade（fake gatewayRequest）。
import { describe, expect, it } from "vitest";

import { createCommandFacade } from "../../src/openclaw/command-facade.js";
import { HarnessState } from "../../src/openclaw/harness-adapter.js";
import { createTurnStarter, ulmSessionKey } from "../../src/openclaw/turn-starter.js";
import { WakeRegistry } from "../../src/openclaw/wake-registry.js";
import type {
  UlmAgentIdentity,
  UlmBasePort,
  UlmControlCommand,
  UlmEventInput,
  UlmServiceEndpoint,
  UlmServiceResponse,
  UlmWakePayload,
} from "../../src/contracts.js";

const identity: UlmAgentIdentity = { agentId: "task-admin", role: "task-admin", capabilities: [] };

function makeWake(taskId = "t-1"): UlmWakePayload {
  return {
    taskId,
    task: { taskId, taskType: "normal", goal: "G", acceptanceCriteria: "AC", dagVersion: 1, parentTaskId: null, dialogueId: null, workspaceId: null, nodeId: "execute" },
    dialogue: { dialogueId: null, mode: "new" },
    guidance: [],
    permissions: [],
    workspace: { workspaceId: null },
  };
}

function makeCmd(command: string, payload: Record<string, unknown>, extra: Partial<UlmControlCommand> = {}): UlmControlCommand {
  return { commandId: `cmd-${command}`, command: command as UlmControlCommand["command"], agentId: identity.agentId, payload, ...extra };
}

class FakeBase implements UlmBasePort {
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  onCommand(): () => void { return () => undefined; }
  sendAck(): void {}
  emitEvent(_event: UlmEventInput): void {}
  async request(_endpoint: UlmServiceEndpoint, _args: Record<string, unknown>): Promise<UlmServiceResponse> { return { ok: true, seq: 1 }; }
}

function fakeGateway(calls: Array<{ method: string; params: unknown }>, response: unknown = { runId: "run-xyz", status: "accepted" }) {
  return async (method: string, params?: unknown) => {
    calls.push({ method, params });
    return response;
  };
}

describe("turn starter", () => {
  it("startTurn：注册 wake、sessionKey 格式、消息含标记、chat.send 参数", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const registry = new WakeRegistry();
    const starter = createTurnStarter({ gatewayRequest: fakeGateway(calls), registry });
    const result = await starter.startTurn(makeWake("t-9"), identity);
    expect(result.status).toBe("started");
    expect(result.runId).toBe("run-xyz");
    expect(result.sessionKey).toBe("agent:task-admin:ulm:t-9");
    expect(calls[0]!.method).toBe("chat.send");
    const params = calls[0]!.params as Record<string, unknown>;
    expect(params.sessionKey).toBe("agent:task-admin:ulm:t-9");
    expect(params.agentId).toBe("task-admin");
    expect(params.deliver).toBe(false);
    expect(typeof params.idempotencyKey).toBe("string");
    expect(String(params.message)).toContain("ULM_WAKE:t-9");
    expect(registry.take("t-9")?.wake.taskId).toBe("t-9");
  });

  it("startTurn 失败 → rejected 带原因", async () => {
    const starter = createTurnStarter({
      gatewayRequest: async () => { throw new Error("gateway down"); },
      registry: new WakeRegistry(),
    });
    const result = await starter.startTurn(makeWake(), identity);
    expect(result.status).toBe("rejected");
    expect(result.detail).toContain("gateway down");
  });

  it("ulmSessionKey 约定", () => {
    expect(ulmSessionKey("task-admin", "t-1")).toBe("agent:task-admin:ulm:t-1");
  });
});

describe("command facade", () => {
  function makeFacade(calls: Array<{ method: string; params: unknown }>, state = new HarnessState()) {
    const registry = new WakeRegistry();
    const facade = createCommandFacade({
      identity,
      gatewayRequest: fakeGateway(calls),
      registry,
      state,
    });
    return { facade, registry, state };
  }

  it("wake：触发 turn 并 ack success", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const { facade } = makeFacade(calls);
    const ack = await facade.handleCommand(makeCmd("wake", { taskId: "t-1", ...makeWake("t-1") } as unknown as Record<string, unknown>, { taskId: "t-1" }), new FakeBase());
    expect(ack.success).toBe(true);
    expect(ack.taskId).toBe("t-1");
    expect(calls[0]!.method).toBe("chat.send");
  });

  it("wake 载荷缺 taskId → ack fail", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const { facade } = makeFacade(calls);
    const ack = await facade.handleCommand(makeCmd("wake", {}), new FakeBase());
    expect(ack.success).toBe(false);
    expect(ack.detail).toContain("taskId");
    expect(calls.length).toBe(0);
  });

  it("sleep 无活跃 run → success；interrupt 无活跃 run → no-active-run", async () => {
    const { facade } = makeFacade([]);
    expect((await facade.handleCommand(makeCmd("sleep", {}), new FakeBase())).success).toBe(true);
    const interruptAck = await facade.handleCommand(makeCmd("interrupt", {}), new FakeBase());
    expect(interruptAck.success).toBe(true);
    expect(interruptAck.detail).toBe("no-active-run");
  });

  it("correct/inject 无活跃 run → 排队并 ack", async () => {
    const { facade } = makeFacade([]);
    const correctAck = await facade.handleCommand(makeCmd("correct", { content: "C1", taskId: "t-1" }, { taskId: "t-1" }), new FakeBase());
    expect(correctAck.success).toBe(true);
    expect(correctAck.detail).toContain("排队");
    const injectAck = await facade.handleCommand(makeCmd("inject", { dialogueId: "d-1", content: "I1" }), new FakeBase());
    expect(injectAck.success).toBe(true);
  });

  it("reorder → noop ack", async () => {
    const { facade } = makeFacade([]);
    const ack = await facade.handleCommand(makeCmd("reorder", {}), new FakeBase());
    expect(ack.success).toBe(true);
    expect(ack.detail).toBe("noop:v1-single-active-task");
  });

  it("modelConfig/whitelist/agentDef → ack success", async () => {
    const { facade } = makeFacade([]);
    expect((await facade.handleCommand(makeCmd("modelConfig", { config: { model: "m2" } }), new FakeBase())).success).toBe(true);
    expect((await facade.handleCommand(makeCmd("whitelist", { whitelist: ["read", "write"] }), new FakeBase())).success).toBe(true);
    expect((await facade.handleCommand(makeCmd("agentDef", { def: { role: "worker" } }), new FakeBase())).success).toBe(true);
    // whitelist 载荷非法 → fail
    const bad = await facade.handleCommand(makeCmd("whitelist", {}), new FakeBase());
    expect(bad.success).toBe(false);
  });

  it("redo 无活跃 run 无历史 → fail；有历史 → 重触发", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const { facade } = makeFacade(calls);
    const noHistory = await facade.handleCommand(makeCmd("redo", {}), new FakeBase());
    expect(noHistory.success).toBe(false);
    // 注册一个历史 wake
    const { facade: f2 } = (() => {
      const registry = new WakeRegistry();
      registry.register(makeWake("t-7"));
      const facade2 = createCommandFacade({ identity, gatewayRequest: fakeGateway(calls), registry, state: new HarnessState() });
      return { facade: facade2 };
    })();
    const redoAck = await f2.handleCommand(makeCmd("redo", {}), new FakeBase());
    expect(redoAck.success).toBe(true);
    expect(calls.some((c) => c.method === "chat.send")).toBe(true);
  });

  it("judgeResult：turn 完成回调 pass → ack success + result", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const state = new HarnessState();
    const registry = new WakeRegistry();
    const facade = createCommandFacade({ identity, gatewayRequest: fakeGateway(calls), registry, state });
    const ackPromise = facade.handleCommand(
      makeCmd("judgeResult", { question: "材料是否达标？", context: { material: "M" } }, { taskId: "t-1", purposeId: "p-1" }),
      new FakeBase(),
    );
    // startTurn 已发出；模拟 runAttempt 完成回调 verdict
    await new Promise((r) => setTimeout(r, 10));
    const judgeTaskId = (calls.find((c) => c.method === "chat.send")?.params as { message: string }).message.match(/ULM_WAKE:([\w\-.]+)/)![1];
    state.takeJudge(judgeTaskId)?.resolve({ result: "pass", note: "达标" });
    const ack = await ackPromise;
    expect(ack.success).toBe(true);
    expect(ack.result).toEqual({ result: "pass", note: "达标" });
    expect(ack.taskId).toBe("t-1");
    expect(ack.purposeId).toBe("p-1");
    expect(ack.detail).toContain("pass");
  });

  it("judgeResult：无回调（超时前 reject 路径）→ startTurn rejected 时保守打回", async () => {
    const state = new HarnessState();
    const registry = new WakeRegistry();
    const facade = createCommandFacade({
      identity,
      gatewayRequest: async () => { throw new Error("down"); },
      registry,
      state,
    });
    const ack = await facade.handleCommand(
      makeCmd("judgeResult", { question: "Q" }, { taskId: "t-2" }),
      new FakeBase(),
    );
    expect(ack.success).toBe(false);
    expect(ack.detail).toContain("judge turn rejected");
  });
});
