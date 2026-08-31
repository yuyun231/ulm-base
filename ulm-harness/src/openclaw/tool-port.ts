// P4：OpenClawToolPort。用 createOpenClawCodingTools 构造工具集，
// applyEmbeddedAttemptToolsAllow 应用白名单，execute 走 AnyAgentTool.execute。
import {
  applyEmbeddedAttemptToolsAllow,
  createOpenClawCodingTools,
  type AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness";

import type { UlmToolDescriptor, UlmToolPort, UlmToolResult } from "../contracts.js";

export interface OpenClawToolPortOptions {
  agentId?: string;
  workspaceDir?: string;
  cwd?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  abortSignal?: AbortSignal;
  /** 初始白名单（whitelist 指令的 pending 值）；undefined=不过滤 */
  toolsAllow?: string[];
  logger?: (event: string, data: unknown) => void;
}

interface MutableToolPort extends UlmToolPort {
  applyWhitelist(allow: string[] | undefined): void;
}

export function createOpenClawToolPort(options: OpenClawToolPortOptions): UlmToolPort & { applyWhitelist(allow?: string[]): void } {
  const log = options.logger ?? (() => {});
  const allTools: AnyAgentTool[] = createOpenClawCodingTools({
    agentId: options.agentId,
    workspaceDir: options.workspaceDir,
    cwd: options.cwd,
    sessionKey: options.sessionKey,
    runSessionKey: options.sessionKey,
    sessionId: options.sessionId,
    runId: options.runId,
    abortSignal: options.abortSignal,
  });
  let filtered = options.toolsAllow ? applyEmbeddedAttemptToolsAllow(allTools, options.toolsAllow) : allTools;
  log("toolPort.constructed", { total: allTools.length, filtered: filtered.length });

  const port: MutableToolPort = {
    list(): UlmToolDescriptor[] {
      return filtered.map((tool) => ({
        name: tool.name,
        description: tool.description,
        schema: tool.parameters as unknown as Record<string, unknown>,
      }));
    },

    async execute(name: string, args: Record<string, unknown>, execOptions?: { signal?: AbortSignal }): Promise<UlmToolResult> {
      const tool = filtered.find((t) => t.name === name);
      if (!tool) {
        return { content: `未知工具：${name}（不在当前工具集/白名单内）`, isError: true };
      }
      try {
        const result = await tool.execute(
          `ulm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          args,
          execOptions?.signal ?? options.abortSignal,
        );
        const content =
          typeof result.content === "string"
            ? result.content
            : JSON.stringify(result.content ?? {});
        return { content, isError: false, raw: result };
      } catch (err) {
        return { content: `工具执行失败：${String(err)}`, isError: true };
      }
    },

    applyWhitelist(allow?: string[]): void {
      filtered = allow ? applyEmbeddedAttemptToolsAllow(allTools, allow) : allTools;
      log("toolPort.whitelistApplied", { filtered: filtered.length });
    },
  };

  return port;
}
