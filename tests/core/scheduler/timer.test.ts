import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TimerService } from '../../src/core/scheduler/timer.js';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';

describe('TimerService 定时器服务', () => {
  let eventStore: EventStore;
  let bus: EventBus;
  let timer: TimerService;

  beforeEach(() => {
    eventStore = new EventStore(':memory:');
    bus = new EventBus(eventStore);
    timer = new TimerService(bus, { sleepCountdownSec: 30, heartbeatIntervalSec: 30, heartbeatTimeoutSec: 90 });
  });

  afterEach(() => {
    timer.stop();
    timer.stopAll();
    eventStore.close();
  });

  it('startTracking 设置 nextSleepAt', () => {
    timer.startTracking('res-01');
    const next = timer.getNextSleepAt('res-01');
    expect(next).toBeGreaterThan(Date.now());
  });

  it('resetSleepCountdown 推后倒计时', () => {
    timer.startTracking('res-01');
    const before = timer.getNextSleepAt('res-01');
    const wait = Date.now() + 10;
    while (Date.now() < wait) {}
    timer.resetSleepCountdown('res-01');
    const after = timer.getNextSleepAt('res-01');
    expect(after).toBeGreaterThan(before!);
  });

  it('stopTracking 移除追踪', () => {
    timer.startTracking('res-01');
    expect(timer.getNextSleepAt('res-01')).toBeGreaterThan(0);
    timer.stopTracking('res-01');
    expect(timer.getNextSleepAt('res-01')).toBeNull();
  });

  it('到期检查返回需休眠的 agent 列表', () => {
    const shortTimer = new TimerService(bus, { sleepCountdownSec: 0, heartbeatIntervalSec: 30, heartbeatTimeoutSec: 90 });
    shortTimer.startTracking('res-01');
    const wait = Date.now() + 10;
    while (Date.now() < wait) {}
    const expired = shortTimer.checkExpired();
    expect(expired).toContain('res-01');
    shortTimer.stopAll();
  });
});

describe('TimerService F11 — 自动触发', () => {
  let store: EventStore;
  let bus: EventBus;
  let timer: TimerService;

  beforeEach(() => {
    store = new EventStore(':memory:');
    bus = new EventBus(store);
    timer = new TimerService(bus, {
      sleepCountdownSec: 0, // 立即到期
      heartbeatIntervalSec: 30,
      heartbeatTimeoutSec: 90,
    });
  });

  afterEach(() => {
    timer.stop();
    store.close();
  });

  it('start() 后到期产生 timerFired 事件', () => {
    vi.useFakeTimers();
    timer.startTracking('agent-1');
    timer.start(10); // 10ms 间隔
    vi.advanceTimersByTime(100);
    vi.useRealTimers();
    // 检查事件库中是否有 timerFired 事件
    const events = store.query("SELECT * FROM events WHERE family = 'schedule' AND subtype = 'timerFired'");
    expect(events.length).toBeGreaterThan(0);
    const payload = JSON.parse((events[0] as any).payload);
    expect(payload.agentId).toBe('agent-1');
  });

  it('stop() 清除 interval 后不再产事件', () => {
    vi.useFakeTimers();
    timer.startTracking('agent-1');
    timer.start(10);
    vi.advanceTimersByTime(50);
    const countBefore = store.query("SELECT * FROM events WHERE subtype = 'timerFired'").length;
    timer.stop();
    vi.advanceTimersByTime(1000);
    vi.useRealTimers();
    const countAfter = store.query("SELECT * FROM events WHERE subtype = 'timerFired'").length;
    expect(countAfter).toBe(countBefore);
  });

  it('start() 启动后到期 agent 从 sleepTimers 中清除', () => {
    vi.useFakeTimers();
    timer.startTracking('agent-1');
    timer.start(10);
    vi.advanceTimersByTime(50);
    vi.useRealTimers();
    expect(timer.getNextSleepAt('agent-1')).toBeNull();
  });
});
