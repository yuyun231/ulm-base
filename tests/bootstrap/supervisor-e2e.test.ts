import { describe, it, expect } from 'vitest';
import { createSystem } from '../../src/system.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';

function makeFakeChild(): ChildProcess & { __emit: (ev: string, ...a: any[]) => void } {
  const listeners = new Map<string, Array<(...a: any[]) => void>>();
  const child: any = {
    pid: 777, on: (ev: string, fn: (...a: any[]) => void) => { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev)!.push(fn); },
    kill: () => { child.__emit('exit', 0, null); },
  };
  child.__emit = (ev: string, ...a: any[]) => { for (const fn of listeners.get(ev) ?? []) fn(...a); };
  return child as ChildProcess & { __emit: (ev: string, ...a: any[]) => void };
}

function makeSystemWithSupervisor() {
  const dir = mkdtempSync(join(tmpdir(), 'ulm-sup-'));
  writeFileSync(join(dir, 'params.yaml'), `
agent: { sleepCountdownSec: 300 }
scheduler: { maxWorkingAgents: 3 }
heartbeat: { intervalSec: 30, timeoutSec: 90 }
dialogue: { compressThreshold: 100000 }
memory: { injectInlineMaxBytes: 4096 }
feedback: { keyNodeEvents: [] }
supervisor:
  spawnCommandTemplate: node fake-openclaw.js --agent {agentId}
  baseMs: 10
  factor: 2
  maxMs: 100
  maxRetries: 3
`);
  writeFileSync(join(dir, 'permission-rules.yaml'), `
rules:
  - subject: 'human:*'
    action: '*'
    object: '*'
    decision: allow
`);
  writeFileSync(join(dir, 'agents.yaml'), `
agents:
  - agentId: task-admin
    role: task-admin
    description: 任务管理员
    capabilities: [task:judge]
    spawnPolicy: spawn
  - agentId: res-01
    role: worker
    description: 外部接入
    capabilities: [task:execute]
    spawnPolicy: external
`);
  const spawnCalls: Array<{ command: string; args: string[]; env: any }> = [];
  const children: Array<ReturnType<typeof makeFakeChild>> = [];
  const system = createSystem({
    configDir: dir, mode: 'test',
    supervisorSpawnFn: (command, args, env) => {
      spawnCalls.push({ command, args, env });
      const c = makeFakeChild();
      children.push(c);
      return c;
    },
  } as any);
  return { system, spawnCalls, children, dir };
}

describe('Supervisor system 端到端（F.4-D）', () => {
  it('start() 后 spawn 档 agent 拉起（agentSpawned），external 档不拉起；crash 退避重启；stop 后不再 spawn', async () => {
    const { system, spawnCalls, children, dir } = makeSystemWithSupervisor();
    system.start();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].env.ULM_AGENT_ID).toBe('task-admin');
    const spawned = system.eventStore.getByFamily('admin').filter(e => e.subtype === 'agentSpawned');
    expect(spawned).toHaveLength(1);
    // 模拟 crash → 退避重启（delay=10ms，真实 setTimeout 等待）
    children[0].__emit('exit', 1, null);
    expect(system.eventStore.getByFamily('admin').filter(e => e.subtype === 'agentExited')).toHaveLength(1);
    await new Promise(r => setTimeout(r, 50));
    expect(spawnCalls).toHaveLength(2);
    system.stop();
    expect(spawnCalls).toHaveLength(2);   // stopAll 后不再有新 spawn
    try { require('node:fs').rmSync(dir, { recursive: true }); } catch {}
  });
});
