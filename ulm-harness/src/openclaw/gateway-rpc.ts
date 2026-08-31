// P4：本地 Gateway RPC 客户端。第三方插件无 runtime.gateway.request 权限
// （"Gateway requests are only available to bundled or trusted official plugins"），
// 因此插件服务自连本地 gateway WS（loopback + 配置 token）调 chat.send 等方法。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

import type { GatewayRequest } from "./turn-starter.js";

export interface LocalGatewayRpcOptions {
  /** ws://127.0.0.1:18789 */
  url?: string;
  /** openclaw.json gateway.auth.token；缺省从 ~/.openclaw/openclaw.json 读取 */
  token?: string;
  requestTimeoutMs?: number;
  logger?: (event: string, data: unknown) => void;
}

/** 从本机 openclaw.json 解析 gateway token（auth mode=token 部署）。 */
export function readGatewayTokenFromConfig(): string {
  try {
    const configPath = join(homedir(), ".openclaw", "openclaw.json");
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      gateway?: { auth?: { mode?: string; token?: string } };
    };
    if (raw.gateway?.auth?.mode === "token" && typeof raw.gateway.auth.token === "string") {
      return raw.gateway.auth.token;
    }
    return "";
  } catch {
    return "";
  }
}

export function createLocalGatewayRpc(options: LocalGatewayRpcOptions = {}): GatewayRequest {
  const log = options.logger ?? (() => {});
  const url = options.url ?? process.env.ULM_GATEWAY_URL ?? "ws://127.0.0.1:18789";
  const token = options.token || readGatewayTokenFromConfig();
  let client: InstanceType<typeof GatewayClient> | null = null;
  let startPromise: Promise<void> | null = null;

  function ensureStarted(): Promise<void> {
    if (startPromise) return startPromise;
    startPromise = new Promise<void>((resolve, reject) => {
      try {
        const created = new GatewayClient({
          url,
          ...(token ? { token } : {}),
          clientName: "cli" as never,
          clientDisplayName: "ULM Harness",
          clientVersion: "0.1.0",
          mode: "backend" as never,
          requestTimeoutMs: options.requestTimeoutMs ?? 120_000,
        } as never);
        created.start();
        client = created;
        log("gatewayRpc.started", { url });
        resolve();
      } catch (err) {
        startPromise = null;
        reject(err);
      }
    });
    return startPromise;
  }

  const rpc: GatewayRequest = async (method, params) => {
    await ensureStarted();
    if (!client) throw new Error("gateway client unavailable");
    // GatewayClient.start() 异步建连：连接完成前 request 会抛 "gateway not connected"。
    // 轮询退避直到就绪（上限 ~10s）。
    const startedAt = Date.now();
    for (;;) {
      try {
        return await client.request(method, params);
      } catch (err) {
        const message = String(err);
        const reconnecting = /not connected|connecting|handshake/i.test(message);
        if (!reconnecting || Date.now() - startedAt > 10_000) {
          log("gatewayRpc.request.error", { method, error: message });
          throw err;
        }
        log("gatewayRpc.request.retry", { method, waitedMs: Date.now() - startedAt });
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  };

  (rpc as GatewayRequest & { stop(): Promise<void> }).stop = async () => {
    const current = client;
    client = null;
    startPromise = null;
    if (current) await current.stopAndWait({ timeoutMs: 3000 }).catch(() => undefined);
  };

  return rpc as GatewayRequest & { stop(): Promise<void> };
}
