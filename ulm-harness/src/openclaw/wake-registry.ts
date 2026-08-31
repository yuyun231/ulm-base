// P4：wake 上下文注册表。turn 触发前存 taskId → wake，runAttempt 凭 prompt 内
// ULM_WAKE:<taskId> 标记取回。含判定合成 wake（judge-<id>）与最后一次 wake（redo 用）。
import type { UlmWakePayload } from "../contracts.js";

export interface RegisteredWake {
  wake: UlmWakePayload;
  /** judge 合成 wake 的判定请求原始载荷 */
  judge?: { taskId?: string; purposeId?: string; question?: unknown; context?: unknown };
  registeredAt: number;
}

export class WakeRegistry {
  private byTaskId = new Map<string, RegisteredWake>();
  private lastWake: UlmWakePayload | null = null;
  private lastIdentityAgentId: string | null = null;

  register(wake: UlmWakePayload, judge?: RegisteredWake["judge"]): void {
    this.byTaskId.set(wake.taskId, { wake, judge, registeredAt: Date.now() });
    if (!judge) {
      this.lastWake = wake;
    }
  }

  take(taskId: string): RegisteredWake | undefined {
    // 取出但不删除：redo 需要再次取回；同 taskId 重复 wake 由基座调度保证不并发
    return this.byTaskId.get(taskId);
  }

  get last(): UlmWakePayload | null {
    return this.lastWake;
  }

  clearSession(sessionKey: string): void {
    // reset 时清掉该 session 关联的 pending wake（按前缀约定 agent:<agentId>:ulm:<taskId>）
    const prefixEnd = sessionKey.lastIndexOf(":");
    if (prefixEnd <= 0) return;
    const taskId = sessionKey.slice(prefixEnd + 1);
    this.byTaskId.delete(taskId);
  }
}
