// P3 测试：fake model/tools/base，全离线，验证循环算法与控制语义。
import { describe, expect, it } from "vitest";

import { createControlledLoop } from "../../src/controlled-loop/loop.js";
import { parseJudgeVerdict, fallbackVerdict } from "../../src/controlled-loop/judge.js";
import type {
  UlmEventInput,
  UlmLoopPorts,
  UlmModelMessage,
  UlmModelPort,
  UlmModelTurn,
  UlmRunInput,
  UlmServiceEndpoint,
  UlmServiceResponse,
  UlmToolPort,
  UlmToolResult,
  UlmWakePayload,
} from "../../src/contracts.js";

function makeWake(overrides: Partial<UlmWakePayload> = {}): UlmWakePayload {
  return {
    taskId: "t-1",
    task: {
      taskId: "t-1",
      taskType: "normal",
      goal: "写一段总结",
      acceptanceCriteria: "包含结论",
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
    ...overrides,
  };
}

function makeInput(wake: UlmWakePayload): UlmRunInput {
  return { runId: "run-1", wake };
}

class FakeModel implements UlmModelPort {
  calls: { messages: UlmModelMessage[]; options?: Record<string, unknown> }[] = [];
  script: UlmModelTurn[] = [];
  onCall?: (callIndex: number) => void;

  async call(messages: UlmModelMessage[], options?: Record<string, unknown>): Promise<UlmModelTurn> {
    this.calls.push({ messages: [...messages], options });
    this.onCall?.(this.calls.length);
    const turn = this.script.shift();
    if (!turn) throw new Error("fake model script exhausted");
    return turn;
  }
}

class FakeTools implements UlmToolPort {
  executed: { name: string; args: Record<string, unknown> }[] = [];

  list() {
    return [{ name: "read" }, { name: "write" }];
  }

  async execute(name: string, args: Record<string, unknown>): Promise<UlmToolResult> {
    this.executed.push({ name, args });
    return { content: `tool:${name}`, isError: false };
  }
}

class FakeBase {
  events: UlmEventInput[] = [];
  requests: Array<{ endpoint: UlmServiceEndpoint; args: Record<string, unknown> }> = [];
  responses: Record<string, UlmServiceResponse> = {};

  emitEvent(event: UlmEventInput): void {
    this.events.push(event);
  }

  async request(endpoint: UlmServiceEndpoint, args: Record<string, unknown>): Promise<UlmServiceResponse> {
    this.requests.push({ endpoint, args });
    return this.responses[endpoint] ?? { ok: true, seq: 1 };
  }
}

function makePorts(model: FakeModel, tools = new FakeTools(), base = new FakeBase()): UlmLoopPorts {
  return { model, tools, base };
}

const loop = createControlledLoop();

describe("controlled loop", () => {
  it("正常闭环：一次文本 → done + submitMaterial", async () => {
    const model = new FakeModel();
    model.script = [{ text: "总结：结论 X", toolCalls: [] }];
    const base = new FakeBase();
    const result = await loop.run(makeInput(makeWake()), makePorts(model, new FakeTools(), base));
    expect(result.state).toBe("done");
    expect(result.material).toBe("总结：结论 X");
    expect(base.requests).toEqual([
      { endpoint: "submitMaterial", args: { taskId: "t-1", nodeId: "execute", material: "总结：结论 X", isLastNode: true } },
    ]);
    // 事件：thought 在前
    expect(base.events[0]).toMatchObject({ family: "organ", subtype: "thought", handles: { taskId: "t-1" } });
  });

  it("多步工具调用：toolCall → 工具执行 → 第二轮文本", async () => {
    const model = new FakeModel();
    model.script = [
      { text: "", toolCalls: [{ id: "c1", name: "read", args: { path: "a" } }] },
      { text: "最终答案", toolCalls: [] },
    ];
    const tools = new FakeTools();
    const base = new FakeBase();
    const result = await loop.run(makeInput(makeWake()), makePorts(model, tools, base));
    expect(result.state).toBe("done");
    expect(tools.executed).toEqual([{ name: "read", args: { path: "a" } }]);
    // 第二轮消息包含 tool 结果
    const secondCall = model.calls[1]!;
    expect(secondCall.messages.some((m) => m.role === "tool" && m.content === "tool:read" && m.toolCallId === "c1")).toBe(true);
    expect(base.events.some((e) => e.subtype === "action" && (e.payload as Record<string, unknown>).toolName === "read")).toBe(true);
  });

  it("interrupt：abortSignal 中止 → aborted", async () => {
    const model = new FakeModel();
    const handle = loop.createHandle(makeInput(makeWake()), makePorts(model));
    const waiting = handle.wait();
    await handle.interrupt();
    const result = await waiting;
    expect(result.state).toBe("aborted");
    expect(result.error).toBe("interrupted");
  });

  it("correct：修正文本进入后续 messages", async () => {
    const model = new FakeModel();
    // 第一轮 toolCall 拉长循环，让 correct 落在第二轮模型调用前
    model.script = [
      { text: "", toolCalls: [{ id: "c1", name: "read", args: {} }] },
      { text: "done", toolCalls: [] },
    ];
    const handle = loop.createHandle(makeInput(makeWake()), makePorts(model));
    const waiting = handle.wait();
    await handle.correct("改用英文");
    const result = await waiting;
    expect(result.state).toBe("done");
    const second = model.calls[1]!;
    expect(second.messages.some((m) => m.role === "system" && m.content.includes("改用英文"))).toBe(true);
  });

  it("inject：注入文本进入后续 messages（user 角色）", async () => {
    const model = new FakeModel();
    model.script = [
      { text: "", toolCalls: [{ id: "c1", name: "read", args: {} }] },
      { text: "ok", toolCalls: [] },
    ];
    const handle = loop.createHandle(makeInput(makeWake()), makePorts(model));
    const waiting = handle.wait();
    await handle.inject("用户补充：预算 100");
    await waiting;
    const second = model.calls[1]!;
    expect(second.messages.some((m) => m.role === "user" && m.content.includes("预算 100"))).toBe(true);
  });

  it("redo：清回初始消息重跑，取第二次结果", async () => {
    const model = new FakeModel();
    model.script = [
      { text: "A", toolCalls: [{ id: "c1", name: "read", args: {} }] },
      { text: "B-after-redo", toolCalls: [] },
    ];
    const handle = loop.createHandle(makeInput(makeWake()), makePorts(model));
    const waiting = handle.wait();
    await handle.redo(); // 第一轮消息尚未消费完即请求重做
    const result = await waiting;
    expect(result.state).toBe("done");
    expect(result.finalText).toBe("B-after-redo");
    expect(model.calls.length).toBe(2);
    // 第二轮应回到初始消息（不含第一轮的 assistant 文本 A）
    const secondMessages = model.calls[1]!.messages;
    expect(secondMessages.some((m) => m.content === "A" && m.role === "assistant")).toBe(false);
  });

  it("whitelist：白名单外工具拒绝执行，错误作为 tool result", async () => {
    const model = new FakeModel();
    model.script = [
      { text: "", toolCalls: [{ id: "c1", name: "write", args: { path: "x" } }] },
      { text: "done", toolCalls: [] },
    ];
    const tools = new FakeTools();
    const handle = loop.createHandle(makeInput(makeWake()), makePorts(model, tools));
    const waiting = handle.wait();
    handle.applyWhitelist(["read"]);
    const result = await waiting;
    expect(result.state).toBe("done");
    expect(tools.executed).toEqual([]);
    const secondCall = model.calls[1]!;
    const toolMsg = secondCall.messages.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toContain("不在白名单");
  });

  it("modelConfig：options 透传给模型", async () => {
    const model = new FakeModel();
    model.script = [
      { text: "", toolCalls: [{ id: "c1", name: "read", args: {} }] },
      { text: "x", toolCalls: [] },
    ];
    const handle = loop.createHandle(makeInput(makeWake()), makePorts(model));
    const waiting = handle.wait();
    handle.applyModelConfig({ model: "stepfun/step-3.5-flash", thinking: "high" });
    await waiting;
    const second = model.calls[1]!;
    expect(second.options).toMatchObject({ model: "stepfun/step-3.5-flash", thinking: "high" });
  });

  it("submitMaterial 失败 → reportIssue + state=error", async () => {
    const model = new FakeModel();
    model.script = [{ text: "材料", toolCalls: [] }];
    const base = new FakeBase();
    base.responses["submitMaterial"] = { ok: false, error: "权限拒绝：提交材料" };
    const result = await loop.run(makeInput(makeWake()), makePorts(model, new FakeTools(), base));
    expect(result.state).toBe("error");
    expect(result.error).toBe("权限拒绝：提交材料");
    expect(base.requests.some((r) => r.endpoint === "reportIssue")).toBe(true);
  });

  it("guidance/permissions 写入 system，dialogue continue 前置对话", async () => {
    const model = new FakeModel();
    model.script = [{ text: "x", toolCalls: [] }];
    const wake = makeWake({
      guidance: [{ guidanceId: "g1", content: "注意格式", type: "now" }],
      permissions: [{ subject: "agent:task-admin", action: "task:reportIssue", object: "task:t-1", effect: "allow" }],
      dialogue: { dialogueId: "dlg-1", mode: "continue" },
    });
    await loop.run({ runId: "r", wake, dialogueText: "前文：用户要求简短" }, makePorts(model));
    const system = model.calls[0]!.messages.find((m) => m.role === "system")!;
    expect(system.content).toContain("注意格式");
    expect(system.content).toContain("task:reportIssue");
    expect(system.content).toContain("这是事实陈述");
    const firstUser = model.calls[0]!.messages.find((m) => m.role === "user")!;
    expect(firstUser.content).toContain("前文：用户要求简短");
  });

  it("模型异常 → reportIssue + state=error", async () => {
    const model = new FakeModel();
    model.script = []; // call 即抛错
    const base = new FakeBase();
    const result = await loop.run(makeInput(makeWake()), makePorts(model, new FakeTools(), base));
    expect(result.state).toBe("error");
    expect(base.requests.some((r) => r.endpoint === "reportIssue")).toBe(true);
  });
});

describe("judge verdict parsing", () => {
  it("严格 JSON 直接解析", () => {
    expect(parseJudgeVerdict('{"result":"pass","note":"ok"}')).toEqual({ result: "pass", note: "ok" });
    expect(parseJudgeVerdict('{"result":"reject"}')).toEqual({ result: "reject" });
  });

  it("code fence 与包裹文本容忍", () => {
    expect(parseJudgeVerdict('判定如下：\n```json\n{"result":"pass","note":"达标"}\n```\n以上')).toEqual({ result: "pass", note: "达标" });
    expect(parseJudgeVerdict('前缀说明 {"result":"reject","note":"缺材料"} 后缀说明')).toEqual({ result: "reject", note: "缺材料" });
  });

  it("非法输出返回 null，fallback 为 reject", () => {
    expect(parseJudgeVerdict("我觉得还行")).toBeNull();
    expect(parseJudgeVerdict('{"result":"maybe"}')).toBeNull();
    expect(fallbackVerdict("我觉得还行").result).toBe("reject");
  });
});
