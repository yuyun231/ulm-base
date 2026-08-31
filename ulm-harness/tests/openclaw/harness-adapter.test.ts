// P4 测试：全部用 fake（loop/gateway/模型/工具），不加载 OpenClaw 运行时类型之外的任何真实实现。
import { describe, expect, it } from "vitest";

import { createHarnessAdapter, HarnessState, ULM_WAKE_MARKER } from "../../src/openclaw/harness-adapter.js";
import { WakeRegistry } from "../../src/openclaw/wake-registry.js";
import type {
  UlmAgentIdentity,
  UlmBasePort,
  UlmControlledLoop,
  UlmEventInput,
  UlmLoopPorts,
  UlmRunHandle,
  UlmRunInput,
  UlmRunResult,
  UlmServiceEndpoint,
  UlmServiceResponse,
  UlmWakePayload,
} from "../../src/contracts.js";

const identity: UlmAgentIdentity = { agentId: "task-admin", role: "task-admin", capabilities: [] };

function makeWake(taskId = "t-1"): UlmWakePayload {
  return {
    taskId,
    task: {
      taskId,
      taskType: "normal",
      goal: "G",
      acceptanceCriteria: "AC",
      dagVersion: 1,
      parentTaskId: null,
      dialogueId: null,
      workspaceId: null,
      nodeId: "execute",
    },
    dialogue: { dialogueId: null, mode: "new" },
    guidance: [],
    permissions: [],
    workspace: { workspaceId: null },
  };
}

class FakeBase implements UlmBasePort {
  events: UlmEventInput[] = [];
  requests: Array<{ endpoint: UlmServiceEndpoint; args: Record<string, unknown> }> = [];

  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  onCommand(): () => void { return () => undefined; }
  sendAck(): void {}
  emitEvent(event: UlmEventInput): void { this.events.push(event); }
  async request(endpoint: UlmServiceEndpoint, args: Record<string, unknown>): Promise<UlmServiceResponse> {
    this.requests.push({ endpoint, args });
    return { ok: true, seq: 1 };
  }
}

class FakeLoop implements UlmControlledLoop {
  inputs: UlmRunInput[] = [];
  portRefs: UlmLoopPorts[] = [];
  result: UlmRunResult = { state: "done", finalText: "FINAL", material: "FINAL" };
  handles: FakeHandle[] = [];

  async run(input: UlmRunInput, ports: UlmLoopPorts): Promise<UlmRunResult> {
    this.inputs.push(input);
    this.portRefs.push(ports);
    return this.result;
  }

  createHandle(input: UlmRunInput, ports: UlmLoopPorts): UlmRunHandle {
    this.inputs.push(input);
    this.portRefs.push(ports);
    const handle = new FakeHandle(input, this.result);
    this.handles.push(handle);
    return handle;
  }
}

class FakeHandle implements UlmRunHandle {
  get runId(): string { return this.input.runId; }
  get wake(): UlmWakePayload { return this.input.wake; }
  interrupted: string[] = [];
  constructor(private input: UlmRunInput, private result: UlmRunResult) {}
  state(): "idle" | "running" | "done" | "aborted" | "error" { return "done"; }
  async wait(): Promise<UlmRunResult> { return this.result; }
  async interrupt(reason?: string): Promise<void> { this.interrupted.push(reason ?? ""); }
  async correct(): Promise<void> {}
  async inject(): Promise<void> {}
  async redo(): Promise<void> {}
  applyModelConfig(): void {}
  applyWhitelist(): void {}
  applyAgentDef(): void {}
  async sleep(): Promise<void> {}
}

function makeAttemptParams(prompt: string, overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "sess-1",
    sessionKey: "agent:task-admin:ulm:t-1",
    agentId: "task-admin",
    provider: "stepfun",
    modelId: "step-3.7-flash",
    prompt,
    workspaceDir: "C:/tmp/ws",
    runId: "run-1",
    model: { id: "step-3.7-flash", name: "x", api: "openai-completions", provider: "stepfun", baseUrl: "https://x", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 4096 },
    abortSignal: new AbortController().signal,
    onPartialReply: undefined,
    ...overrides,
  } as never;
}

describe("harness adapter", () => {
  it("ULM_WAKE 标记正则提取 taskId", () => {
    expect(ULM_WAKE_MARKER.exec("ULM_WAKE:t-1\n\n任务目标：G")?.[1]).toBe("t-1");
    expect(ULM_WAKE_MARKER.exec("随便聊聊")).toBeNull();
  });

  it("supports 只认显式 ulm-controlled pin", () => {
    const adapter = createHarnessAdapter({ loop: new FakeLoop(), registry: new WakeRegistry(), basePortFor: () => null, state: new HarnessState() });
    expect(adapter.supports({ requestedRuntime: "ulm-controlled" } as never)).toMatchObject({ supported: true, priority: 100 });
    expect(adapter.supports({ requestedRuntime: "auto" } as never)).toMatchObject({ supported: false });
  });

  it("runAttempt：无 wake 上下文 → 空结果不接管", async () => {
    const loop = new FakeLoop();
    const adapter = createHarnessAdapter({ loop, registry: new WakeRegistry(), basePortFor: () => null, state: new HarnessState() });
    const result = (await adapter.runAttempt(makeAttemptParams("普通聊天消息"))) as Record<string, unknown>;
    expect(loop.inputs.length).toBe(0);
    expect(result.promptError).toBeNull();
    expect(result.aborted).toBe(false);
  });

  it("runAttempt：有 wake 上下文 → 跑循环并回填 result", async () => {
    const loop = new FakeLoop();
    const registry = new WakeRegistry();
    registry.register(makeWake("t-1"));
    const base = new FakeBase();
    const state = new HarnessState();
    const adapter = createHarnessAdapter({ loop, registry, basePortFor: () => base, state });
    const result = (await adapter.runAttempt(makeAttemptParams("ULM_WAKE:t-1\n\n任务目标：G"))) as Record<string, unknown>;
    expect(loop.inputs.length).toBe(1);
    expect(loop.inputs[0]!.wake.taskId).toBe("t-1");
    expect(result.assistantTexts).toEqual(["FINAL"]);
    expect(result.promptError).toBeNull();
    // handle 已注册又移除
    expect(state.activeHandle()).toBeNull();
  });

  it("runAttempt：abortSignal 触发 handle.interrupt", async () => {
    const loop = new FakeLoop();
    const registry = new WakeRegistry();
    registry.register(makeWake("t-1"));
    const controller = new AbortController();
    const state = new HarnessState();
    // 构造一个等待型 handle：wait 挂起直到 abort
    let releaseInterrupt: (() => void) | null = null;
    const handle = new FakeHandle({ runId: "run-1", wake: makeWake() }, { state: "aborted", finalText: "" });
    handle.interrupt = () => { controller.abort(); releaseInterrupt?.(); };
    loop.createHandle = () => handle;
    handle.wait = () => new Promise((resolve) => { releaseInterrupt = () => resolve({ state: "aborted", finalText: "" }); });
    const adapter = createHarnessAdapter({ loop, registry, basePortFor: () => null, state });
    const pending = adapter.runAttempt(makeAttemptParams("ULM_WAKE:t-1", { abortSignal: controller.signal }));
    // 等 runAttempt 注册 abort 监听后手动触发 abort 路径
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    const result = (await pending) as Record<string, unknown>;
    expect(result.aborted).toBe(true);
    expect(handle.interrupted).toEqual([]);
  });

  it("runAttempt：judge turn 完成 → verdict 回调到 waiter", async () => {
    const loop = new FakeLoop();
    loop.result = { state: "done", finalText: '```json\n{"result":"pass","note":"达标"}\n```' };
    const registry = new WakeRegistry();
    const judgeWake = makeWake("judge-t-1");
    registry.register(judgeWake, { taskId: "t-1", purposeId: "p-1", question: "Q" });
    const state = new HarnessState();
    const verdictPromise = new Promise<{ result: string; note?: string }>((resolve) => {
      state.registerJudge({ taskId: "judge-t-1", purposeId: "p-1", resolve });
    });
    const adapter = createHarnessAdapter({ loop, registry, basePortFor: () => null, state });
    await adapter.runAttempt(makeAttemptParams("ULM_WAKE:judge-t-1", { sessionKey: "agent:task-admin:ulm:judge-t-1" }));
    await expect(verdictPromise).resolves.toEqual({ result: "pass", note: "达标" });
  });
});
