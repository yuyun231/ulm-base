import { describe, it, expect } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import { ProjectionsStore } from '../../src/core/projector/projections-store.js';
import { ProjectionRunner } from '../../src/core/projector/runner.js';
import { AgentRegistryProjection } from '../../src/core/projector/projections/agent-registry.js';
import { SupervisorService, parseTemplate } from '../../src/core/supervisor/supervisor.js';

function makeFakeChild(): ChildProcess & { __emit: (ev: string, ...a: any[]) => void } {
  const listeners = new Map<string, Array<(...a: any[]) => void>>();
  const child: any = {
    pid: 4242,
    on: (ev: string, fn: (...a: any[]) => void) => {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev)!.push(fn);
    },
    kill: () => { child.__emit('exit', 0, null); },
  };
  child.__emit = (ev: string, ...a: any[]) => { for (const fn of listeners.get(ev) ?? []) fn(...a); };
  return child as ChildProcess & { __emit: (ev: string, ...a: any[]) => void };
}

function makeCtx(params: any, registry: Array<[string, string, number]>) {
  const eventStore = new EventStore(':memory:');
  const bus = new EventBus(eventStore);
  const projStore = new ProjectionsStore(':memory:');
  const runner = new ProjectionRunner(bus, eventStore, projStore, [new AgentRegistryProjection()]);
  runner.start();
  for (const [agentId, spawnPolicy, enabled] of registry) {
    bus.publish({
      seq: null, timestamp: Date.now(), subject: { kind: 'human', userId: 'u1' },
      family: 'admin', subtype: 'agentRegistered', handles: {},
      payload: { agentId, role: agentId, description: null, capabilities: [], spawnPolicy, configSource: 'panel', enabled },
      value: null,
    });
  }
  const spawnCalls: Array<{ command: string; args: string[]; env: any }> = [];
  const children: Array<ReturnType<typeof makeFakeChild>> = [];
  let nowMs = 1_000_000;
  const pending: Array<{ fn: () => void; delay: number } | null> = [];
  const sup = new SupervisorService({
    bus, projStore, params, wsUrl: 'ws://localhost:8080',
    spawnFn: (command, args, env) => {
      spawnCalls.push({ command, args, env });
      const c = makeFakeChild();
      children.push(c);
      return c;
    },
    setTimeoutFn: (fn, delay) => { pending.push({ fn, delay }); return pending.length - 1; },
    clearTimeoutFn: (t) => { pending[t as number] = null; },
    now: () => nowMs,
  });
  return {
    bus, eventStore, sup, spawnCalls, children, pending,
    flushTimers() { const copy = pending.splice(0).filter(Boolean) as Array<{ fn: () => void }>; for (const p of copy) p.fn(); },
    adminSubtypes() { return eventStore.getByFamily('admin').map(e => e.subtype); },
    stop() { runner.stop(); projStore.close(); eventStore.close(); },
  };
}

const TPL = 'node openclaw/main.js --agent {agentId}';

describe('SupervisorService spawn/external（F.4-B）', () => {
  it('start() 拉起 spawn 档：spawnFn 收 ULM_* env + agentSpawned 落事件', () => {
    const ctx = makeCtx({ spawnCommandTemplate: TPL }, [
      ['task-admin', 'spawn', 1], ['historian', 'spawn', 1], ['res-01', 'external', 1],
    ]);
    ctx.sup.start();
    expect(ctx.spawnCalls).toHaveLength(2);
    expect(ctx.spawnCalls[0].command).toBe('node');
    expect(ctx.spawnCalls[0].args).toEqual(['openclaw/main.js', '--agent', 'task-admin']);
    expect(ctx.spawnCalls[0].env.ULM_AGENT_ID).toBe('task-admin');
    expect(ctx.spawnCalls[0].env.ULM_WS_URL).toBe('ws://localhost:8080');
    expect(ctx.adminSubtypes().filter(s => s === 'agentSpawned')).toHaveLength(2);
    ctx.stop();
  });

  it('enabled=0 的 spawn 档不拉起', () => {
    const ctx = makeCtx({ spawnCommandTemplate: TPL }, [['task-admin', 'spawn', 0]]);
    ctx.sup.start();
    expect(ctx.spawnCalls).toHaveLength(0);
    ctx.stop();
  });

  it('模板缺失 → start() no-op（不 spawn 不报错）', () => {
    const ctx = makeCtx({}, [['task-admin', 'spawn', 1]]);
    expect(() => ctx.sup.start()).not.toThrow();
    expect(ctx.spawnCalls).toHaveLength(0);
    ctx.stop();
  });

  it('parseTemplate：占位符替换 + 空白切分', () => {
    expect(parseTemplate('node a.js --agent {agentId} --ws {wsUrl}', 'ag-1', 'ws://x:1'))
      .toEqual({ command: 'node', args: ['a.js', '--agent', 'ag-1', '--ws', 'ws://x:1'] });
  });
});

describe('SupervisorService 退避重启与手动托管（F.4-C）', () => {
  it('exit → agentExited + agentRestartScheduled(retry=1, at=now+baseMs)；flush 后重启并再落 agentSpawned', () => {
    const ctx = makeCtx({ spawnCommandTemplate: TPL, baseMs: 100, factor: 2, maxMs: 10_000, maxRetries: 5 }, [
      ['task-admin', 'spawn', 1],
    ]);
    ctx.sup.start();
    ctx.children[0].__emit('exit', 1, 'SIGTERM');
    const scheduled = ctx.eventStore.getByFamily('admin').filter(e => e.subtype === 'agentRestartScheduled');
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].payload.retry).toBe(1);
    expect(scheduled[0].payload.at).toBe(1_000_100);
    expect(scheduled[0].payload.giveUp).toBe(false);
    ctx.flushTimers();
    expect(ctx.spawnCalls).toHaveLength(2);
    expect(ctx.adminSubtypes().filter(s => s === 'agentSpawned')).toHaveLength(2);
    ctx.stop();
  });

  it('退避指数递增且封顶 maxMs：retry1=100 retry2=200 retry3=400', () => {
    const ctx = makeCtx({ spawnCommandTemplate: TPL, baseMs: 100, factor: 2, maxMs: 10_000, maxRetries: 5 }, [
      ['task-admin', 'spawn', 1],
    ]);
    ctx.sup.start();
    for (let i = 0; i < 3; i++) {
      ctx.children[ctx.children.length - 1].__emit('exit', 1, null);
      const s = ctx.eventStore.getByFamily('admin').filter(e => e.subtype === 'agentRestartScheduled');
      expect(s[s.length - 1].payload.at).toBe(1_000_000 + 100 * Math.pow(2, i));
      ctx.flushTimers();
    }
    ctx.stop();
  });

  it('manualStop：stopAgent → exit → 无 restartScheduled 不自动重启', () => {
    const ctx = makeCtx({ spawnCommandTemplate: TPL, baseMs: 10, maxRetries: 5 }, [['task-admin', 'spawn', 1]]);
    ctx.sup.start();
    ctx.sup.stopAgent('task-admin');
    expect(ctx.adminSubtypes()).toContain('agentExited');
    expect(ctx.eventStore.getByFamily('admin').filter(e => e.subtype === 'agentRestartScheduled')).toHaveLength(0);
    ctx.flushTimers();
    expect(ctx.spawnCalls).toHaveLength(1);
    ctx.stop();
  });

  it('达 maxRetries → giveUp 事件，不再重启', () => {
    const ctx = makeCtx({ spawnCommandTemplate: TPL, baseMs: 10, maxRetries: 1 }, [['task-admin', 'spawn', 1]]);
    ctx.sup.start();
    ctx.children[0].__emit('exit', 1, null);   // retry1 → 计划重启
    ctx.flushTimers();                          // 重启
    ctx.children[1].__emit('exit', 1, null);   // retry2 > maxRetries=1 → giveUp
    const sched = ctx.eventStore.getByFamily('admin').filter(e => e.subtype === 'agentRestartScheduled');
    expect(sched[sched.length - 1].payload.giveUp).toBe(true);
    ctx.flushTimers();
    expect(ctx.spawnCalls).toHaveLength(2);     // 不再拉起
    ctx.stop();
  });

  it('restartAgent 手动重启：kill 旧进程 + 立即拉起新进程（spawnCalls 2 次）', () => {
    const ctx = makeCtx({ spawnCommandTemplate: TPL }, [['task-admin', 'spawn', 1]]);
    ctx.sup.start();
    ctx.sup.restartAgent('task-admin');
    expect(ctx.spawnCalls).toHaveLength(2);
    expect(ctx.adminSubtypes().filter(s => s === 'agentSpawned')).toHaveLength(2);
    ctx.stop();
  });

  it('重启计数跨 exit 累计：连续两次 crash → retry=2', () => {
    const ctx = makeCtx({ spawnCommandTemplate: TPL, baseMs: 10, maxRetries: 5 }, [['task-admin', 'spawn', 1]]);
    ctx.sup.start();
    ctx.children[0].__emit('exit', 1, null);
    ctx.flushTimers();
    ctx.children[1].__emit('exit', 1, null);
    const sched = ctx.eventStore.getByFamily('admin').filter(e => e.subtype === 'agentRestartScheduled');
    expect(sched[sched.length - 1].payload.retry).toBe(2);
    ctx.stop();
  });

  it('网络级失联不触发重启：心跳失联事件（非 exit）不产生 agentExited/重启', () => {
    const ctx = makeCtx({ spawnCommandTemplate: TPL }, [['task-admin', 'spawn', 1]]);
    ctx.sup.start();
    ctx.bus.publish({
      seq: null, timestamp: Date.now(), subject: { kind: 'module', module: 'gateway' },
      family: 'schedule', subtype: 'agentLost', handles: {}, payload: { agentId: 'task-admin' }, value: null,
    });
    expect(ctx.eventStore.getByFamily('admin').filter(e => e.subtype === 'agentExited')).toHaveLength(0);
    expect(ctx.eventStore.getByFamily('admin').filter(e => e.subtype === 'agentRestartScheduled')).toHaveLength(0);
    ctx.stop();
  });
});
