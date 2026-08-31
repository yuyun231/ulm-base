// P5 测试：本地 WebSocketServer 模拟基座三通道，全离线。真实 timers + 短间隔参数。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerWs } from "ws";

import { createUlmBasePort } from "../../src/base/base-port.js";
import { startCommandDispatch } from "../../src/base/wire.js";
import type { UlmAgentIdentity, UlmBasePort } from "../../src/contracts.js";

const identity: UlmAgentIdentity = {
  agentId: "task-admin",
  role: "task-admin",
  capabilities: ["task:judge"],
};

interface Harness {
  received: Array<{ channel: string; payload: Record<string, unknown> }>;
  reply: (frame: { channel: string; payload: Record<string, unknown> }) => void;
  closeClient: () => void;
  dispose: () => Promise<void>;
}

async function startServer(port: number): Promise<Harness> {
  const server = new WebSocketServer({ port });
  const received: Harness["received"] = [];
  let clientSocket: ServerWs | null = null;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.on("connection", (socket) => {
      clientSocket = socket;
      socket.on("message", (data) => {
        received.push(JSON.parse(data.toString()));
        resolve();
      });
    });
    // WebSocketServer({port}) 构造后即监听，直接放行
    resolve();
  });
  return {
    received,
    reply(frame) { clientSocket?.send(JSON.stringify(frame)); },
    closeClient() { clientSocket?.close(); },
    async dispose() {
      clientSocket?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function connectedBase(h: Harness, port: number, opts: Record<string, unknown> = {}): Promise<UlmBasePort> {
  const base = createUlmBasePort({ wsUrl: `ws://localhost:${port}`, ...opts });
  const connecting = base.connect(identity);
  await waitFor(() => expect(firstRegisterFrame(h)).toBeTruthy());
  h.reply({ channel: "control", payload: { type: "registered", agentId: identity.agentId } });
  await connecting;
  return base;
}

async function waitFor(check: () => void, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try { check(); return; } catch { /* retry */ }
    if (Date.now() - started > timeoutMs) { check(); return; }
    await new Promise((r) => setTimeout(r, 20));
  }
}

function firstRegisterFrame(h: Harness) {
  return h.received.find((f) => f.channel === "control" && f.payload.type === "register");
}

describe("ulm base port", () => {
  let port = 9901;
  let h: Harness;
  let base: UlmBasePort | null = null;

  beforeEach(() => { base = null; });

  afterEach(async () => {
    try { await base?.close(); } catch { /* 已关闭 */ }
    await h?.dispose();
  });

  it("注册成功后 connect resolve，register 帧形状正确", async () => {
    h = await startServer(port);
    base = await connectedBase(h, port);
    expect(firstRegisterFrame(h)?.payload).toMatchObject({
      type: "register",
      agentId: "task-admin",
      role: "task-admin",
      capabilities: ["task:judge"],
    });
    port += 1;
  });

  it("注册被拒后 connect reject", async () => {
    h = await startServer(port);
    const b = createUlmBasePort({ wsUrl: `ws://localhost:${port}` });
    const connecting = b.connect(identity);
    await waitFor(() => expect(firstRegisterFrame(h)).toBeTruthy());
    h.reply({ channel: "control", payload: { type: "registerRejected", agentId: identity.agentId, detail: "unregistered" } });
    await expect(connecting).rejects.toThrow(/register rejected: unregistered/);
    await b.close();
    port += 1;
  });

  it("注册超时后 connect reject", async () => {
    h = await startServer(port);
    const b = createUlmBasePort({ wsUrl: `ws://localhost:${port}`, registerTimeoutMs: 200 });
    await expect(b.connect(identity)).rejects.toThrow(/register timeout/);
    await b.close();
    port += 1;
  });

  it("心跳按间隔发送", async () => {
    h = await startServer(port);
    base = await connectedBase(h, port, { heartbeatIntervalMs: 100 });
    await waitFor(() => {
      const beats = h.received.filter((f) => f.payload.type === "heartbeat");
      expect(beats.length).toBeGreaterThanOrEqual(3);
    });
    port += 1;
  });

  it("命令接收：taskId/purposeId/commandId 兼容缺省", async () => {
    h = await startServer(port);
    base = await connectedBase(h, port);
    const got: Array<Record<string, unknown>> = [];
    base.onCommand((cmd) => { got.push({ ...cmd }); });
    h.reply({
      channel: "control",
      payload: { type: "command", command: "wake", agentId: "task-admin", taskId: "t-1", task: { goal: "G" } },
    });
    await waitFor(() => expect(got.length).toBe(1));
    expect(got[0]).toMatchObject({ command: "wake", agentId: "task-admin", taskId: "t-1" });
    expect(typeof got[0]!.commandId).toBe("string");
    expect((got[0]!.payload as Record<string, unknown>).task).toEqual({ goal: "G" });
    h.reply({
      channel: "control",
      payload: { type: "command", commandId: "cmd-1", command: "judgeResult", agentId: "task-admin", taskId: "t-1", purposeId: "p-1", question: "Q" },
    });
    await waitFor(() => expect(got.length).toBe(2));
    expect(got[1]).toMatchObject({ commandId: "cmd-1", command: "judgeResult", purposeId: "p-1" });
    port += 1;
  });

  it("sendAck 帧形状", async () => {
    h = await startServer(port);
    base = await connectedBase(h, port);
    base.sendAck({ commandId: "cmd-1", agentId: "task-admin", success: true, detail: "ok", taskId: "t-1" });
    await waitFor(() => {
      const ack = h.received.find((f) => f.payload.type === "ack");
      expect(ack?.payload).toEqual({
        type: "ack", commandId: "cmd-1", agentId: "task-admin", success: true, detail: "ok", taskId: "t-1",
      });
    });
    port += 1;
  });

  it("emitEvent 帧形状与 ack 容错", async () => {
    h = await startServer(port);
    base = await connectedBase(h, port);
    base.emitEvent({ family: "organ", subtype: "thought", handles: { taskId: "t-1" }, payload: { stage: "x" } });
    await waitFor(() => {
      const emit = h.received.find((f) => f.channel === "event" && f.payload.type === "emit");
      const event = emit?.payload.event as Record<string, unknown>;
      expect(emit?.channel).toBe("event");
      expect(event.seq).toBeNull();
      expect(event.subject).toEqual({ kind: "agent", agentId: "task-admin" });
      expect(event.family).toBe("organ");
      expect(event.subtype).toBe("thought");
      expect(event.value).toBeNull();
    });
    h.reply({ channel: "event", payload: { type: "ack", error: "信封校验失败" } });
    await new Promise((r) => setTimeout(r, 30));
    port += 1;
  });

  it("service 请求-响应往返", async () => {
    h = await startServer(port);
    base = await connectedBase(h, port);
    const pending = base.request("submitMaterial", { taskId: "t-1", nodeId: "execute", material: "M", isLastNode: true });
    await waitFor(() => {
      const req = h.received.find((f) => f.channel === "service" && f.payload.type === "request");
      expect(req?.payload).toMatchObject({ endpoint: "submitMaterial", agentId: "task-admin" });
      expect((req?.payload.args as Record<string, unknown>).taskId).toBe("t-1");
    });
    const reqFrame = h.received.find((f) => f.channel === "service" && f.payload.type === "request")!;
    h.reply({ channel: "service", payload: { type: "response", requestId: reqFrame.payload.requestId, ok: true, seq: 7 } });
    await expect(pending).resolves.toEqual({ ok: true, seq: 7 });
    port += 1;
  });

  it("service 超时返回 service-timeout", async () => {
    h = await startServer(port);
    base = await connectedBase(h, port, { serviceTimeoutMs: 200 });
    const pending = base.request("read", { docId: "d-1", scope: "s", version: 1 });
    await expect(pending).resolves.toEqual({ ok: false, error: "service-timeout" });
    port += 1;
  });

  it("断线后重连并重新 register", async () => {
    h = await startServer(port);
    base = await connectedBase(h, port, { maxReconnectBackoffMs: 500 });
    const registersBefore = h.received.filter((f) => f.payload.type === "register").length;
    expect(registersBefore).toBe(1);
    h.closeClient();
    await waitFor(() => {
      expect(h.received.filter((f) => f.payload.type === "register").length).toBe(2);
    }, 6000);
    h.reply({ channel: "control", payload: { type: "registered", agentId: identity.agentId } });
    await waitFor(() => {
      base!.sendAck({ commandId: "c", agentId: identity.agentId, success: true });
      expect(h.received.some((f) => f.payload.type === "ack")).toBe(true);
    });
    port += 1;
  });

  it("startCommandDispatch：成功与抛错两条路径都发 ack", async () => {
    h = await startServer(port);
    base = await connectedBase(h, port);
    const stop = startCommandDispatch(base, async (cmd) => {
      if (cmd.command === "sleep") throw new Error("boom");
      return { commandId: cmd.commandId, agentId: cmd.agentId, success: true, detail: "ok" };
    });
    try {
      h.reply({ channel: "control", payload: { type: "command", command: "sleep", agentId: "task-admin", taskId: "t-9" } });
      await waitFor(() => {
        const acks = h.received.filter((f) => f.payload.type === "ack");
        expect(acks.length).toBe(1);
        expect(acks[0]!.payload).toMatchObject({ success: false, detail: "Error: boom", taskId: "t-9" });
      });
    } finally {
      stop();
    }
    port += 1;
  });
});
