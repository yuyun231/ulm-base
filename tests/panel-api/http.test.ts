import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PanelApi } from '../../src/panel-api/http.js';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import { ProjectionsStore } from '../../src/core/projector/projections-store.js';
import { TasksProjection } from '../../src/core/projector/projections/tasks.js';
import { AgentsProjection } from '../../src/core/projector/projections/agents.js';
import { AgentRegistryProjection } from '../../src/core/projector/projections/agent-registry.js';
import { ProjectionRunner } from '../../src/core/projector/runner.js';
import { GitAsset } from '../../src/core/git-asset.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PermissionRule } from '../../src/core/permission/rule-loader.js';

function setup() {
  const eventStore = new EventStore(':memory:');
  const bus = new EventBus(eventStore);
  const projStore = new ProjectionsStore(':memory:');
  const runner = new ProjectionRunner(bus, eventStore, projStore, [new TasksProjection()]);
  runner.start();
  const rules: PermissionRule[] = [
    { subject: 'human:*', action: 'task:create', object: '*', decision: 'allow' },
    { subject: 'human:*', action: 'admin:setParam', object: '*', decision: 'allow' },
  ];
  const panelApi = new PanelApi(bus, projStore, rules);
  return { eventStore, bus, projStore, runner, panelApi };
}

describe('PanelApi 人侧命令面', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => { ctx.runner.stop(); ctx.projStore.close(); ctx.eventStore.close(); });

  it('createTask 路由到 TaskCommands.createTask', () => {
    const ack = ctx.panelApi.createTask('u1', {
      taskId: 't1', taskType: 'normal', goal: 'g', acceptanceCriteria: 'c',
      workspaceId: 'ws-1', priority: 5,
    });
    expect(ack.seq).toBe(1);
    expect(ctx.eventStore.getByFamily('task')[0].subtype).toBe('created');
  });

  it('setParam 路由到 AdminCommands.setParam', () => {
    const ack = ctx.panelApi.setParam('u1', 'agent.sleepCountdownSec', 60);
    expect(ack.seq).toBe(1);
    expect(ctx.eventStore.getByFamily('admin')[0].subtype).toBe('paramChanged');
  });

  it('queryTask 路由到 TaskQueries.taskDetail（只读投影）', () => {
    ctx.panelApi.createTask('u1', { taskId: 't1', taskType: 'normal', goal: 'g', acceptanceCriteria: 'c', workspaceId: 'ws-1', priority: 5 });
    const task = ctx.panelApi.queryTask('t1');
    expect(task).toBeDefined();
    expect(task!.taskId).toBe('t1');
  });

  it('无权限的 human 操作被拒绝', () => {
    const rules: PermissionRule[] = [
      { subject: 'human:*', action: 'task:create', object: '*', decision: 'deny' },
    ];
    const eventStore = new EventStore(':memory:');
    const bus = new EventBus(eventStore);
    const projStore = new ProjectionsStore(':memory:');
    const panelApi = new PanelApi(bus, projStore, rules);
    expect(() => panelApi.createTask('u1', { taskId: 't1', taskType: 'normal', goal: 'g', acceptanceCriteria: 'c', workspaceId: 'ws-1', priority: 5 })).toThrow('权限拒绝');
    expect(eventStore.getMaxSeq()).toBe(0);
    projStore.close();
    eventStore.close();
  });
});

describe('PanelApi F.5 面板命令/查询面（决策点 3）', () => {
  let eventStore: EventStore;
  let bus: EventBus;
  let projStore: ProjectionsStore;
  let runner: ProjectionRunner;
  let dir: string;
  let panelApi: PanelApi;

  beforeEach(() => {
    eventStore = new EventStore(':memory:');
    bus = new EventBus(eventStore);
    projStore = new ProjectionsStore(':memory:');
    runner = new ProjectionRunner(bus, eventStore, projStore, [
      new TasksProjection(),
      new AgentsProjection(),
      new AgentRegistryProjection(),
    ]);
    runner.start();
    dir = mkdtempSync(join(tmpdir(), 'ulm-panelhttp-'));
    const gitAsset = new GitAsset(dir);
    gitAsset.initRepo();
    const rules: PermissionRule[] = [
      { subject: 'human:*', action: '*', object: '*', decision: 'allow' },
    ];
    panelApi = new PanelApi(bus, projStore, rules, { gitAsset });
  });

  afterEach(() => {
    runner.stop();
    projStore.close();
    eventStore.close();
    try { rmSync(dir, { recursive: true }); } catch { /* 忽略 */ }
  });

  it('registerAgent/removeAgent/queryAgents 全链路', () => {
    panelApi.registerAgent('u1', { agentId: 'res-01', role: 'worker' });
    const agents = panelApi.queryAgents();
    expect(agents.length).toBe(1);
    expect(agents[0].configSource).toBe('panel');
    expect(agents[0].connected).toBe(false);
    expect(panelApi.queryAgentsDetail('res-01')!.agentId).toBe('res-01');
    panelApi.removeAgent('u1', 'res-01');
    expect(panelApi.queryAgents().length).toBe(0);
    expect(panelApi.queryAgentsDetail('res-01')).toBeNull();
  });

  it('setPermissionRule/removePermissionRule 转发', () => {
    panelApi.setPermissionRule('u1', { subject: 'agent:res-01', action: 'doc:read', object: '*', decision: 'allow' });
    const envs = eventStore.getByFamily('admin');
    expect(envs[0].subtype).toBe('permissionChanged');
    panelApi.removePermissionRule('u1', 'perm-agent_res-01-doc_read');
    expect(eventStore.getByFamily('admin')[1].subtype).toBe('permissionRemoved');
  });

  it('writeWorkflow 落盘 + queryWorkflow 读回', () => {
    panelApi.writeWorkflow('u1', 'res-01', '# wf');
    expect(panelApi.queryWorkflow('res-01')).toBe('# wf');
    expect(panelApi.queryWorkflow('ghost')).toBeNull();
  });

  it('writeAutomations 语法错误抛错；合法后 queryAutomations 可读', () => {
    expect(() => panelApi.writeAutomations('u1', 'rules: [broken')).toThrow('语法错误');
    panelApi.writeAutomations('u1', 'rules: []\n');
    expect(panelApi.queryAutomations()).toEqual({ rules: [] });
  });

  it('queryProcedures 列工序模板', () => {
    panelApi.writeProcedure('u1', 'normal', 'name: normal\n');
    const list = panelApi.queryProcedures();
    expect(list.length).toBe(1);
    expect(list[0].name).toBe('normal');
    expect(list[0].template.name).toBe('normal');
  });

  it('缺省 opts：manageAgent 抛 Supervisor 未装配；connected 恒 false', () => {
    const rules: PermissionRule[] = [{ subject: 'human:*', action: '*', object: '*', decision: 'allow' }];
    const bare = new PanelApi(bus, projStore, rules);
    expect(() => bare.manageAgent('u1', 'res-01', 'start')).toThrow('Supervisor 未装配');
    bare.registerAgent('u1', { agentId: 'res-01', role: 'r' });
    expect(bare.queryAgents()[0].connected).toBe(false);
  });
});
