import type { EventBus } from '../event-bus/bus.js';

// 设计锚点 3.4：定时器独立，唯一凭空产生事件的源。
// 决策点 G6：倒计时内存态不持久化；长期任务触发配置存yaml。
// 澄清7：调度器发重置指令→定时器推后倒计时→到期产timerFired。

export interface TimerConfig {
  sleepCountdownSec: number;
  heartbeatIntervalSec: number;
  heartbeatTimeoutSec: number;
}

export class TimerService {
  private bus: EventBus;
  private config: TimerConfig;
  private sleepTimers: Map<string, number> = new Map(); // agentId → nextSleepAt(ms)
  private intervalId: ReturnType<typeof setInterval> | null = null; // F11: setInterval 句柄

  constructor(bus: EventBus, config: TimerConfig) {
    this.bus = bus;
    this.config = config;
  }

  // 澄清7：开始追踪某 agent 的休眠倒计时
  startTracking(agentId: string): void {
    this.sleepTimers.set(agentId, Date.now() + this.config.sleepCountdownSec * 1000);
  }

  // 澄清7：重置倒计时（调度器消费 docRead 后调用）
  resetSleepCountdown(agentId: string): void {
    if (this.sleepTimers.has(agentId)) {
      this.sleepTimers.set(agentId, Date.now() + this.config.sleepCountdownSec * 1000);
    }
  }

  stopTracking(agentId: string): void {
    this.sleepTimers.delete(agentId);
  }

  getNextSleepAt(agentId: string): number | null {
    return this.sleepTimers.get(agentId) ?? null;
  }

  // 3.4：到期检查——返回需休眠的 agent 列表（调度器消费后产 slept 事件）
  checkExpired(): string[] {
    const now = Date.now();
    const expired: string[] = [];
    for (const [agentId, nextSleepAt] of this.sleepTimers) {
      if (nextSleepAt <= now) {
        expired.push(agentId);
        this.sleepTimers.delete(agentId);
      }
    }
    return expired;
  }

  stopAll(): void {
    this.sleepTimers.clear();
  }

  // F11 补完：setInterval 自动触发，替代外部轮询调用 checkExpired()
  start(intervalMs: number = 1000): void {
    if (this.intervalId !== null) return; // 防止重复启动
    this.intervalId = setInterval(() => {
      const expired = this.checkExpired();
      for (const agentId of expired) {
        // 3.4：到期产生 timerFired 事件
        this.bus.publish({
          seq: null, timestamp: Date.now(),
          subject: { kind: 'module', module: 'timer' },
          family: 'schedule', subtype: 'timerFired',
          handles: {}, payload: { agentId, reason: 'sleepTimeout' }, value: null,
        });
      }
    }, intervalMs);
  }

  // F11：停止自动检测循环
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}
