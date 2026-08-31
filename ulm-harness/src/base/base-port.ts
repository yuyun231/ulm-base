// P5：ULM 基座 WebSocket 客户端。
// 单连接三通道复用（control/event/service），协议帧严格对照基座 src/seam/ 源码：
//   - handshake.ts: register/registered/registerRejected/heartbeat
//   - control-channel.ts: {type:'command',command,agentId,...payload} / {type:'ack',...}
//   - event-channel.ts: {type:'emit',event} / {type:'ack',seq|error}
//   - service-channel.ts: {type:'request',requestId,endpoint,agentId,args} / {type:'response',...}
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

import type {
  UlmAgentIdentity,
  UlmBasePort,
  UlmControlAck,
  UlmControlCommand,
  UlmEventInput,
  UlmServiceEndpoint,
  UlmServiceResponse,
} from "../contracts.js";

export interface UlmBasePortOptions {
  wsUrl?: string;
  heartbeatIntervalMs?: number;
  registerTimeoutMs?: number;
  serviceTimeoutMs?: number;
  maxReconnectBackoffMs?: number;
  logger?: (event: string, data: unknown) => void;
}

interface ServicePending {
  resolve: (res: UlmServiceResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

type WireFrame = { channel: string; payload: Record<string, unknown> };

export function createUlmBasePort(options: UlmBasePortOptions = {}): UlmBasePort {
  const wsUrl = options.wsUrl ?? process.env.ULM_WS_URL ?? "ws://localhost:8080";
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
  const registerTimeoutMs = options.registerTimeoutMs ?? 15_000;
  const serviceTimeoutMs = options.serviceTimeoutMs ?? 15_000;
  const maxReconnectBackoffMs = options.maxReconnectBackoffMs ?? 30_000;
  const log = options.logger ?? (() => {});

  let ws: WebSocket | null = null;
  let identity: UlmAgentIdentity | null = null;
  let closed = false; // close() 显式关闭后不再重连
  let registered = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let registerWaiter: { resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  const commandHandlers = new Set<(cmd: UlmControlCommand) => void | Promise<void>>();
  const pendingRequests = new Map<string, ServicePending>();
  let requestIdSeq = 0;

  function clearHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function failAllPending(error: string): void {
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pendingRequests.delete(id);
      pending.resolve({ ok: false, error });
    }
  }

  function scheduleReconnect(): void {
    if (closed || registered === false) {
      // 注册成功后的意外断线才重连；connect() 本身由调用方 await，注册失败/未注册不自动重连
    }
    if (closed) return;
    const delay = Math.min(1_000 * 2 ** reconnectAttempt, maxReconnectBackoffMs);
    reconnectAttempt += 1;
    log("reconnect.scheduled", { delayMs: delay, attempt: reconnectAttempt });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (closed || !identity) return;
      void connectSocket().catch((err) => log("reconnect.error", { error: String(err) }));
    }, delay);
  }

  function toControlCommand(payload: Record<string, unknown>): UlmControlCommand {
    const { type: _type, command, commandId, agentId, taskId, purposeId, ...rest } =
      payload as Record<string, unknown> & {
        type?: string;
        command: UlmControlCommand["command"];
        commandId?: string;
        agentId: string;
        taskId?: string;
        purposeId?: string | null;
      };
    return {
      commandId: typeof commandId === "string" && commandId ? commandId : `local-${randomUUID()}`,
      command,
      agentId,
      taskId: typeof taskId === "string" ? taskId : undefined,
      purposeId: typeof purposeId === "string" && purposeId ? purposeId : undefined,
      // taskId/purposeId 同步保留在 payload 里（wake 载荷完整性：P4 facade 直接解析 payload 为 wake）
      payload: { ...rest, ...(typeof taskId === "string" ? { taskId } : {}), ...(purposeId ? { purposeId } : {}) },
    };
  }

  function handleFrame(frame: WireFrame): void {
    const payload = frame.payload ?? {};
    if (frame.channel === "control") {
      if (payload.type === "registered") {
        registered = true;
        reconnectAttempt = 0;
        const waiter = registerWaiter;
        if (waiter) {
          clearTimeout(waiter.timer);
          registerWaiter = null;
          waiter.resolve();
        }
        return;
      }
      if (payload.type === "registerRejected") {
        const waiter = registerWaiter;
        if (waiter) {
          clearTimeout(waiter.timer);
          registerWaiter = null;
          waiter.reject(new Error(`register rejected: ${String(payload.detail ?? "unknown")}`));
        }
        return;
      }
      if (payload.type === "command" && typeof payload.command === "string") {
        const cmd = toControlCommand(payload);
        for (const handler of commandHandlers) {
          try {
            void handler(cmd);
          } catch (err) {
            log("command.handler.error", { commandId: cmd.commandId, error: String(err) });
          }
        }
        return;
      }
      return;
    }
    if (frame.channel === "event") {
      // 基座对 emit 的回执：ack{seq} 或 ack{error}。只 log，不 throw（fire-and-forget）。
      if (payload.type === "ack") {
        if (payload.error) log("event.ack.error", { error: String(payload.error) });
        else log("event.ack", { seq: payload.seq });
      }
      return;
    }
    if (frame.channel === "service") {
      if (payload.type === "response" && typeof payload.requestId === "string") {
        const pending = pendingRequests.get(payload.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingRequests.delete(payload.requestId);
          pending.resolve({
            ok: payload.ok === true,
            seq: typeof payload.seq === "number" ? payload.seq : undefined,
            result: payload.result,
            error: typeof payload.error === "string" ? payload.error : undefined,
          });
        }
      }
      return;
    }
  }

  function connectSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!identity) {
        reject(new Error("connect(identity) 未调用"));
        return;
      }
      const socket = new WebSocket(wsUrl);
      ws = socket;
      registered = false;

      socket.on("open", () => {
        log("socket.open", { wsUrl });
        socket.send(
          JSON.stringify({
            channel: "control",
            payload: {
              type: "register",
              agentId: identity!.agentId,
              role: identity!.role,
              capabilities: identity!.capabilities,
            },
          }),
        );
      });

      socket.on("message", (data) => {
        let frame: WireFrame;
        try {
          frame = JSON.parse(data.toString()) as WireFrame;
        } catch {
          log("socket.message.invalidJson", {});
          return;
        }
        handleFrame(frame);
        // connect() 的 resolve 由 registered 分支触发；这里兜底首次注册超时
        if (registerWaiter === null && !registered) return;
      });

      socket.on("error", (err) => {
        log("socket.error", { error: String(err) });
      });

      socket.on("close", () => {
        log("socket.close", {});
        ws = null;
        clearHeartbeat();
        failAllPending("disconnected");
        const waiter = registerWaiter;
        if (waiter) {
          clearTimeout(waiter.timer);
          registerWaiter = null;
          waiter.reject(new Error("socket closed before registered"));
        }
        if (!closed && identity) scheduleReconnect();
      });

      registerWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          if (registerWaiter === null) return;
          registerWaiter = null;
          reject(new Error("register timeout"));
          socket.close();
        }, registerTimeoutMs),
      };
    });
  }

  function ensureSocket(action: string): WebSocket {
    if (closed || !ws || ws.readyState !== WebSocket.OPEN || !registered) {
      throw new Error(`base port not ready (${action})`);
    }
    return ws;
  }

  const port: UlmBasePort = {
    async connect(ident: UlmAgentIdentity): Promise<void> {
      if (registered && ws && ws.readyState === WebSocket.OPEN) return; // 幂等
      identity = ident;
      closed = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      await connectSocket();
      clearHeartbeat();
      heartbeatTimer = setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN || !identity) return;
        ws.send(JSON.stringify({ channel: "control", payload: { type: "heartbeat", agentId: identity!.agentId } }));
      }, heartbeatIntervalMs);
    },

    async close(): Promise<void> {
      closed = true;
      clearHeartbeat();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      failAllPending("closed");
      const waiter = registerWaiter;
      if (waiter) {
        clearTimeout(waiter.timer);
        registerWaiter = null;
        waiter.reject(new Error("closed"));
      }
      const socket = ws;
      ws = null;
      if (socket) await new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) resolve();
        else {
          socket.once("close", () => resolve());
          socket.close();
        }
      });
    },

    onCommand(handler: (cmd: UlmControlCommand) => void | Promise<void>): () => void {
      commandHandlers.add(handler);
      return () => commandHandlers.delete(handler);
    },

    sendAck(ack: UlmControlAck): void {
      ensureSocket("sendAck").send(
        JSON.stringify({
          channel: "control",
          payload: {
            type: "ack",
            commandId: ack.commandId,
            agentId: ack.agentId,
            success: ack.success,
            ...(ack.detail !== undefined ? { detail: ack.detail } : {}),
            ...(ack.result !== undefined ? { result: ack.result } : {}),
            ...(ack.taskId !== undefined ? { taskId: ack.taskId } : {}),
            ...(ack.purposeId !== undefined ? { purposeId: ack.purposeId } : {}),
          },
        }),
      );
    },

    emitEvent(event: UlmEventInput): void {
      const agentId = event.agentId ?? identity?.agentId;
      if (!agentId) throw new Error("emitEvent: no agent identity");
      ensureSocket("emitEvent").send(
        JSON.stringify({
          channel: "event",
          payload: {
            type: "emit",
            event: {
              seq: null,
              timestamp: Date.now(),
              subject: { kind: "agent", agentId },
              family: event.family,
              subtype: event.subtype,
              handles: event.handles ?? {},
              payload: event.payload ?? {},
              value: null,
            },
          },
        }),
      );
    },

    request(endpoint: UlmServiceEndpoint, args: Record<string, unknown>): Promise<UlmServiceResponse> {
      const socket = ensureSocket(`request:${endpoint}`);
      const requestId = `req-${++requestIdSeq}-${randomUUID().slice(0, 8)}`;
      return new Promise<UlmServiceResponse>((resolve) => {
        const timer = setTimeout(() => {
          pendingRequests.delete(requestId);
          resolve({ ok: false, error: "service-timeout" });
        }, serviceTimeoutMs);
        pendingRequests.set(requestId, { resolve, timer });
        socket.send(
          JSON.stringify({
            channel: "service",
            payload: { type: "request", requestId, endpoint, agentId: identity!.agentId, args },
          }),
        );
      });
    },
  };

  return port;
}
