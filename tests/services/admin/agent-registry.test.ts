import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRegistryCommands } from '../../../src/services/admin/agent-registry.js';
import { EventBus } from '../../../src/core/event-bus/bus.js';
import { EventStore } from '../../../src/core/event-bus/store.js';
import { ProjectionsStore } from '../../../src/core/projector/projections-store.js';
import { ProjectionRunner } from '../../../src/core/projector/runner.js';
import { AgentRegistryProjection } from '../../../src/core/projector/projections/agent-registry.js';
import { GitAsset } from '../../../src/core/git-asset.js';
import { SupervisorService } from '../../../src/core/supervisor/supervisor.js';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PermissionRule } from '../../../src/core/permission/rule-loader.js';

function makeFakeChild(): any {
  const listeners: Record<string, Array<(...a: any[]) => void>> = {};
  return {
    pid: 4321,
    on: (ev: string, fn: (...a: any[]) => void) => { (listeners[ev] ??= []).push(fn); },
    kill: () => { for (const fn of listeners['exit'] ?? []) fn(0, null); },
  };
}

function setup(opts: { supervisor?: boolean } = {}) {
  const eventStore = new EventStore(':memory:');
  const bus = new EventBus(eventStore);
  const projStore = new ProjectionsStore(':memory:');
  const proj = new AgentRegistryProjection();
  proj.initSchema(projStore);
  const runner = new ProjectionRunner(bus, eventStore, projStore, [proj]);
  runner.start();
  const dir = mkdtempSync(join(tmpdir(), 'ulm-agentcmd-'));
  const gitAsset = new GitAsset(dir);
  gitAsset.initRepo();
  const rules: PermissionRule[] = [
    { subject: 'human:*', action: '*', object: '*', decision: 'allow' },
    { subject: 'agent:*', action: 'admin:*', object: '*', decision: 'deny' },
  ];
  let supervisor: SupervisorService | undefined;
  if (opts.supervisor) {
    supervisor = new SupervisorService({
      bus, projStore, wsUrl: 'ws://localhost:1',
      params: { spawnCommandTemplate: 'node fake.js --agent {agentId}' },
      spawnFn: (() => makeFakeChild()) as any,
    });
  }
  const commands = new AgentRegistryCommands({ bus, rules, projStore, gitAsset, supervisor });
  return { eventStore, bus, projStore, runner, gitAsset, dir, commands };
}

describe('AgentRegistryCommands 面板命令组（决策点 3A）', () => {
  let ctx: ReturnType<typeof setup>;
  let dirs: string[] = [];
  beforeEach(() => { ctx = setup(); dirs.push(ctx.dir); });
  afterEach(() => { ctx.runner.stop(); try { for (const d of dirs) rmSync(d, { recursive: true }); } catch { /* 忽略 */ } dirs = []; });

  it('registerAgent 发布 agentRegistered（configSource=panel，enabled 默认 true）并投影落行', () => {
    ctx.commands.registerAgent('human:u1', { agentId: 'res-01', role: 'worker', capabilities: ['doc:read'] });
    const envs = ctx.eventStore.getByFamily('admin');
    expect(envs[0].subtype).toBe('agentRegistered');
    expect((envs[0].payload as any).configSource).toBe('panel');
    expect((envs[0].payload as any).enabled).toBe(true);
    const row = ctx.projStore.get('SELECT * FROM agent_registry WHERE agentId = ?', 'res-01') as any;
    expect(row.role).toBe('worker');
    expect(row.enabled).toBe(1);
  });

  it('registerAgent 缺 role 抛错不发事件', () => {
    expect(() => ctx.commands.registerAgent('human:u1', { agentId: 'x', role: '' })).toThrow('agentId 与 role 必填');
    expect(ctx.eventStore.getMaxSeq()).toBe(0);
  });

  it('agent 主体被结构性拒绝（deny 规则）', () => {
    expect(() => ctx.commands.registerAgent('agent:res-01', { agentId: 'x', role: 'r' })).toThrow('权限拒绝');
    expect(ctx.eventStore.getMaxSeq()).toBe(0);
  });

  it('removeAgent 不存在抛错；存在发 agentRemoved 并投影删行', () => {
    expect(() => ctx.commands.removeAgent('human:u1', 'ghost')).toThrow('agent 不存在: ghost');
    ctx.commands.registerAgent('human:u1', { agentId: 'res-01', role: 'worker' });
    ctx.commands.removeAgent('human:u1', 'res-01');
    const envs = ctx.eventStore.getByFamily('admin');
    expect(envs[1].subtype).toBe('agentRemoved');
    expect(ctx.projStore.get('SELECT * FROM agent_registry WHERE agentId = ?', 'res-01')).toBeUndefined();
  });

  it('writeWorkflow 写入并 git 提交', () => {
    ctx.commands.writeWorkflow('human:u1', 'res-01', '# 工作流 v2');
    expect(readFileSync(join(ctx.dir, 'workflows', 'res-01.md'), 'utf-8')).toBe('# 工作流 v2');
    expect(ctx.gitAsset.getGitLog()).toContain('panel edit workflows/res-01.md');
  });

  it('writeWorkflow 非法名拒绝（路径穿越防御）不落盘', () => {
    expect(() => ctx.commands.writeWorkflow('human:u1', '../evil', 'x')).toThrow('非法资产名');
    expect(existsSync(join(ctx.dir, 'evil.md'))).toBe(false);
  });

  it('writeProcedure 语法合法才落盘', () => {
    expect(() => ctx.commands.writeProcedure('human:u1', 'broken', 'a: [unclosed')).toThrow('语法错误');
    expect(existsSync(join(ctx.dir, 'procedures', 'broken.yaml'))).toBe(false);
    ctx.commands.writeProcedure('human:u1', 'normal', 'name: normal\nnodes: []\n');
    expect(readFileSync(join(ctx.dir, 'procedures', 'normal.yaml'), 'utf-8')).toContain('name: normal');
  });

  it('writeAutomations 合法：落盘 + 发布 ruleChanged', () => {
    const content = 'rules:\n  - ruleId: r1\n    trigger: { type: "schedule", intervalSec: 60 }\n    action: { type: "wake", agentId: "res-01" }\n    enabled: true\n';
    ctx.commands.writeAutomations('human:u1', content);
    expect(readFileSync(join(ctx.dir, 'automations.yaml'), 'utf-8')).toBe(content);
    const envs = ctx.eventStore.getByFamily('admin');
    expect(envs[0].subtype).toBe('ruleChanged');
    expect((envs[0].payload as any).scope).toBe('automations');
  });

  it('writeAutomations 语法错误：抛错不落盘不发事件', () => {
    expect(() => ctx.commands.writeAutomations('human:u1', 'rules: [broken')).toThrow('语法错误');
    expect(existsSync(join(ctx.dir, 'automations.yaml'))).toBe(false);
    expect(ctx.eventStore.getMaxSeq()).toBe(0);
  });

  it('无 GitAsset 时资产编辑抛错（空规则表默认 deny → 用 allow 规则越过权限关）', () => {
    const allowRules: PermissionRule[] = [{ subject: 'human:*', action: '*', object: '*', decision: 'allow' }];
    const bare = new AgentRegistryCommands({ bus: ctx.bus, rules: allowRules, projStore: ctx.projStore });
    expect(() => bare.writeWorkflow('human:u1', 'a', 'x')).toThrow('GitAsset 未装配');
    expect(() => bare.writeAutomations('human:u1', 'rules: []')).toThrow('GitAsset 未装配');
  });
});

describe('AgentRegistryCommands 托管动作（设计 5.3）', () => {
  let dirs: string[] = [];
  afterEach(() => { try { for (const d of dirs) rmSync(d, { recursive: true }); } catch { /* 忽略 */ } dirs = []; });

  it('无 Supervisor 时 manageAgent 抛错', () => {
    const ctx = setup();
    dirs.push(ctx.dir);
    expect(() => ctx.commands.manageAgent('human:u1', 'res-01', 'start')).toThrow('Supervisor 未装配');
    ctx.runner.stop();
  });

  it('start/stop/restart 走 Supervisor：agentSpawned → agentExited（manualStop 不重启）', () => {
    const ctx = setup({ supervisor: true });
    dirs.push(ctx.dir);
    ctx.commands.registerAgent('human:u1', { agentId: 'res-01', role: 'worker', spawnPolicy: 'spawn' });
    const ret = ctx.commands.manageAgent('human:u1', 'res-01', 'start');
    expect(ret).toEqual({ agentId: 'res-01', action: 'start' });
    expect(() => ctx.commands.manageAgent('human:u1', 'ghost', 'start')).toThrow('agent 不存在: ghost');
    ctx.commands.manageAgent('human:u1', 'res-01', 'stop');
    const envs = ctx.eventStore.getByFamily('admin');
    const subtypes = envs.map(e => e.subtype);
    expect(subtypes).toContain('agentSpawned');
    expect(subtypes).toContain('agentExited');
    expect(subtypes).not.toContain('agentRestartScheduled');
    ctx.commands.manageAgent('human:u1', 'res-01', 'restart');
    expect(ctx.eventStore.getByFamily('admin').filter(e => e.subtype === 'agentSpawned').length).toBe(2);
  });
});
