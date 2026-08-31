import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { describeSystem } from '../../src/self-describe/describe.js';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProjectionsStore } from '../../src/core/projector/projections-store.js';
import { ProjectionRunner } from '../../src/core/projector/runner.js';
import { TasksProjection } from '../../src/core/projector/projections/tasks.js';
import { TaskNodesProjection } from '../../src/core/projector/projections/task-nodes.js';
import { AgentsProjection } from '../../src/core/projector/projections/agents.js';
import { WorkspacesProjection } from '../../src/core/projector/projections/workspaces.js';
import { LoadQueueProjection } from '../../src/core/projector/projections/load-queue.js';
import { DialoguesProjection } from '../../src/core/projector/projections/dialogues.js';
import { GuidancesProjection } from '../../src/core/projector/projections/guidances.js';
import { ConsultsProjection } from '../../src/core/projector/projections/consults.js';
import { PurposesProjection } from '../../src/core/projector/projections/purposes.js';
import { ReplayByPurposeProjection } from '../../src/core/projector/projections/replay-by-purpose.js';
import { ValueCompareProjection } from '../../src/core/projector/projections/value-compare.js';
import { RegistryProjection } from '../../src/core/projector/projections/registry.js';
import { PermissionRulesProjection } from '../../src/core/projector/projections/permission-rules.js';
import { AgentRegistryProjection } from '../../src/core/projector/projections/agent-registry.js';

function setup() {
  const eventStore = new EventStore(':memory:');
  const bus = new EventBus(eventStore);
  const projStore = new ProjectionsStore(':memory:');
  const projections = [
    new TasksProjection(),
    new TaskNodesProjection(),
    new AgentsProjection(),
    new WorkspacesProjection(),
    new LoadQueueProjection(),
    new DialoguesProjection(),
    new GuidancesProjection(),
    new ConsultsProjection(),
    new PurposesProjection(),
    new ReplayByPurposeProjection(),
    new ValueCompareProjection(),
    new RegistryProjection(),
    new PermissionRulesProjection(),
    new AgentRegistryProjection(),
  ];
  const runner = new ProjectionRunner(bus, eventStore, projStore, projections);
  runner.start();
  return { eventStore, bus, projStore, runner };
}

describe('describeSystem self-describe', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => { ctx.runner.stop(); ctx.projStore.close(); ctx.eventStore.close(); });

  it('空系统 describe 返回空数组结构', () => {
    const snapshot = describeSystem(ctx.projStore, ctx.eventStore);
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.agents).toEqual([]);
    expect(snapshot.workspaces).toEqual([]);
    expect(snapshot.dialogues).toEqual([]);
    expect(snapshot.loadQueue).toEqual([]);
    expect(snapshot.permissionRules).toEqual([]);
    expect(snapshot.agentRegistry).toEqual([]);
    // 占位投影表
    expect(snapshot.guidances).toEqual([]);
    expect(snapshot.consults).toEqual([]);
    expect(snapshot.purposes).toEqual([]);
    expect(snapshot.replayByPurpose).toEqual([]);
    expect(snapshot.valueCompare).toEqual([]);
    expect(snapshot.registry).toEqual([]);
  });

  it('创建任务后 describe 含 tasks 条目', () => {
    ctx.bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'u1' },
      family: 'task', subtype: 'created',
      handles: { taskId: 't1' },
      payload: { taskType: 'normal', goal: 'g', acceptanceCriteria: 'c', workspaceId: 'ws-1', priority: 5 },
      value: null,
    });
    const snapshot = describeSystem(ctx.projStore, ctx.eventStore);
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0].taskId).toBe('t1');
  });

  it('唤醒 agent 后 describe 含 agents 条目', () => {
    ctx.bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'agent', agentId: 'res-01' },
      family: 'schedule', subtype: 'woken', handles: {},
      payload: { role: 'researcher', capabilities: ['search'] }, value: null,
    });
    const snapshot = describeSystem(ctx.projStore, ctx.eventStore);
    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0].agentId).toBe('res-01');
  });

  it('创建任务自动开对话通道后 describe 含 dialogues', () => {
    ctx.bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'u1' },
      family: 'task', subtype: 'created',
      handles: { taskId: 't1' },
      payload: { taskType: 'normal', goal: 'g', acceptanceCriteria: 'c', workspaceId: 'ws-1', priority: 5 },
      value: null,
    });
    // 4.1 任务创建时自动开任务对话通道
    ctx.bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'module', module: 'task-service' },
      family: 'dialogue', subtype: 'turnPosted',
      handles: { dialogueId: 'd-t1' },
      payload: { channel: 'task', content: '任务对话已开启' }, value: null,
    });
    const snapshot = describeSystem(ctx.projStore, ctx.eventStore);
    expect(snapshot.dialogues.length).toBeGreaterThanOrEqual(1);
  });

  it('describe 返回系统级元信息', () => {
    const snapshot = describeSystem(ctx.projStore, ctx.eventStore);
    expect(snapshot.meta).toBeDefined();
    expect(snapshot.meta.maxEventSeq).toBeDefined();
    expect(snapshot.meta.generatedAt).toBeDefined();
  });
});

describe('F6 self-describe 结构化数据补全', () => {
  let ctx: ReturnType<typeof setup>;
  let tmpDir: string;

  beforeEach(() => {
    ctx = setup();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ulm-describe-test-'));
    // 创建测试用 assets 目录
    fs.mkdirSync(path.join(tmpDir, 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'workflows', 'wf-1.yaml'), 'name: wf-1');
    fs.writeFileSync(path.join(tmpDir, 'workflows', 'wf-2.md'), '# 工序说明（md）');
    fs.writeFileSync(path.join(tmpDir, 'params.yaml'),
      'agent:\n  sleepCountdownSec: 30\nscheduler:\n  maxWorkingAgents: 4');
  });

  afterEach(() => {
    ctx.runner.stop(); ctx.projStore.close(); ctx.eventStore.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('返回 modules 清单（硬编码模块列表）', () => {
    const result = describeSystem(ctx.projStore, ctx.eventStore, tmpDir);
    expect(result.modules).toBeTruthy();
    expect(result.modules.length).toBeGreaterThan(0);
    const eventBus = result.modules.find(m => m.name === 'event-bus');
    expect(eventBus).toBeTruthy();
  });

  it('返回 workflows 清单（读 assets/workflows/ 目录，yaml/md 均识别）', () => {
    const result = describeSystem(ctx.projStore, ctx.eventStore, tmpDir);
    expect(result.workflows).toHaveLength(2);
    expect(result.workflows.map(w => w.name)).toContain('wf-1');
    expect(result.workflows.map(w => w.name)).toContain('wf-2');
  });

  it('返回 params 当前值（读 params.yaml）', () => {
    const result = describeSystem(ctx.projStore, ctx.eventStore, tmpDir);
    expect(result.params).toBeTruthy();
    expect(result.params.agent.sleepCountdownSec).toBe(30);
    expect(result.params.scheduler.maxWorkingAgents).toBe(4);
  });

  it('返回 eventSchemas（硬编码 9.3 七族子类型）', () => {
    const result = describeSystem(ctx.projStore, ctx.eventStore, tmpDir);
    expect(result.eventSchemas).toBeTruthy();
    expect(result.eventSchemas.length).toBe(7); // 七族
    const taskFamily = result.eventSchemas.find(f => f.family === 'task');
    expect(taskFamily).toBeTruthy();
    expect(taskFamily!.subtypes).toContain('created');
    expect(taskFamily!.subtypes).toContain('guidanceIssued');
  });
});

describe('Phase F.5：describe 快照扩展', () => {
  // describeSystem 查询全部投影表 → 裸库需先初始化 schema（与 setup() 同源）
  function initAllSchemas(projStore: ProjectionsStore): void {
    const projs = [
      new TasksProjection(), new TaskNodesProjection(), new AgentsProjection(), new WorkspacesProjection(),
      new LoadQueueProjection(), new DialoguesProjection(), new GuidancesProjection(), new ConsultsProjection(),
      new PurposesProjection(), new ReplayByPurposeProjection(), new ValueCompareProjection(),
      new RegistryProjection(), new PermissionRulesProjection(), new AgentRegistryProjection(),
    ];
    for (const p of projs) p.initSchema(projStore);
  }

  it('workflowContents/automations/procedures 装入快照', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ulm-describe-'));
    fs.mkdirSync(path.join(dir, 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'procedures'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'workflows', 'historian.md'), '# 史官工作流');
    fs.writeFileSync(path.join(dir, 'procedures', 'normal.yaml'), 'name: normal\nnodes: []\n');
    fs.writeFileSync(path.join(dir, 'automations.yaml'), 'rules:\n  - ruleId: r1\n    trigger: { type: "schedule", intervalSec: 60 }\n    action: { type: "wake", agentId: "a1" }\n    enabled: true\n');
    const projStore = new ProjectionsStore(':memory:');
    const eventStore = new EventStore(':memory:');
    initAllSchemas(projStore);
    const snap = describeSystem(projStore, eventStore, dir);
    expect(snap.workflowContents['historian']).toBe('# 史官工作流');
    expect((snap.automations as any).rules.length).toBe(1);
    expect(snap.procedures.length).toBe(1);
    expect(snap.procedures[0].name).toBe('normal');
    expect((snap.procedures[0].template as any).name).toBe('normal');
    projStore.close();
    eventStore.close();
    try { fs.rmSync(dir, { recursive: true }); } catch { /* 忽略 */ }
  });

  it('automations 缺失 → null；procedures 目录缺失 → 空数组', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ulm-describe2-'));
    const projStore = new ProjectionsStore(':memory:');
    const eventStore = new EventStore(':memory:');
    initAllSchemas(projStore);
    const snap = describeSystem(projStore, eventStore, dir);
    expect(snap.automations).toBeNull();
    expect(snap.procedures).toEqual([]);
    expect(snap.workflowContents).toEqual({});
    projStore.close();
    eventStore.close();
    try { fs.rmSync(dir, { recursive: true }); } catch { /* 忽略 */ }
  });
});
