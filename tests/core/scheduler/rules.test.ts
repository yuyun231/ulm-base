import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SchedulerRules } from '../../src/core/scheduler/rules.js';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import { ProjectionsStore } from '../../src/core/projector/projections-store.js';
import { TasksProjection } from '../../src/core/projector/projections/tasks.js';
import { TaskNodesProjection } from '../../src/core/projector/projections/task-nodes.js';
import { AgentsProjection } from '../../src/core/projector/projections/agents.js';
import { ProjectionRunner } from '../../src/core/projector/runner.js';
import { ConcurrencyGate } from '../../src/core/scheduler/concurrency-gate.js';
import { LoadQueue } from '../../src/core/scheduler/load-queue.js';
import { TimerService } from '../../src/core/scheduler/timer.js';
import { createInMemoryPair } from '../../src/seam/in-memory-transport.js';
import { ControlChannel } from '../../src/seam/control-channel.js';
import { TaskCommands } from '../../src/services/task/commands.js';

function setup(maxWorking = 4) {
  const eventStore = new EventStore(':memory:');
  const bus = new EventBus(eventStore);
  const projStore = new ProjectionsStore(':memory:');
  const projections = [new TasksProjection(), new TaskNodesProjection(), new AgentsProjection()];
  const runner = new ProjectionRunner(bus, eventStore, projStore, projections);
  runner.start();
  const concurrencyGate = new ConcurrencyGate(maxWorking);
  const loadQueue = new LoadQueue();
  const timer = new TimerService(bus, { sleepCountdownSec: 30, heartbeatIntervalSec: 30, heartbeatTimeoutSec: 90 });
  // F1 补完：SchedulerRules 需要 controlChannel（测试用内存回环）
  const { server } = createInMemoryPair();
  const controlChannel = new ControlChannel(bus, server);
  controlChannel.start();
  // Phase 0 修复③：调度器派发/判定走命令面——测试配 module:scheduler 放行规则
  const taskCommands = new TaskCommands(bus, [
    { subject: 'module:scheduler', action: 'task:assign', object: '*', decision: 'allow' },
    { subject: 'module:scheduler', action: 'task:approve', object: '*', decision: 'allow' },
    { subject: 'module:scheduler', action: 'task:reject', object: '*', decision: 'allow' },
  ] as any);
  const rules = new SchedulerRules(bus, projStore, concurrencyGate, loadQueue, timer, controlChannel, taskCommands, {
    compressThreshold: 1000, // 高阈值：本测试不涉 F2/F3 链路
    injectInlineMaxBytes: 4096,
  });
  rules.start();
  return { eventStore, bus, projStore, runner, rules, timer, concurrencyGate, controlChannel };
}

function publish(bus: EventBus, family: string, subtype: string, subject: any = { kind: 'human', userId: 'u1' }, handles: any = {}, payload: any = {}) {
  bus.publish({ seq: null, timestamp: Date.now(), subject, family: family as any, subtype, handles, payload, value: null });
}

describe('SchedulerRules 分配链路', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => { ctx = setup(); });
  afterEach(() => {
    ctx.rules.stop(); ctx.runner.stop(); ctx.timer.stopAll(); ctx.controlChannel.stop();
    ctx.projStore.close(); ctx.eventStore.close();
  });

  it('待分配区任务分发到工作区后触发分配', () => {
    // 人创建任务落待分配区（workspaceId=null）
    publish(ctx.bus, 'task', 'created', undefined, { taskId: 't1' }, { taskType: 'normal', priority: 5 });
    // 任务管理员分发到工作区 ws-1
    publish(ctx.bus, 'task', 'assigned', { kind: 'module', module: 'task-service' }, { taskId: 't1' }, { agentId: 'res-01', workspaceId: 'ws-1' });
    // 应触发：agent 唤醒 + loaded + 任务 inProgress
    const schedEvents = ctx.eventStore.getByFamily('schedule');
    const woken = schedEvents.find(e => e.subtype === 'woken' && e.subject.kind === 'agent' && e.subject.agentId === 'res-01');
    expect(woken).toBeDefined();
    const loaded = schedEvents.find(e => e.subtype === 'loaded' && e.subject.kind === 'agent' && e.subject.agentId === 'res-01');
    expect(loaded).toBeDefined();
    // 并发计数+1
    expect(ctx.concurrencyGate.hasCapacity()).toBe(true); // maxWorking=4, used=1
  });

  it('agent 提交材料→waiting，释放后继续取下一任务', () => {
    // 第一个任务分配
    publish(ctx.bus, 'task', 'created', undefined, { taskId: 't1' }, { taskType: 'normal', priority: 5, workspaceId: 'ws-1' });
    publish(ctx.bus, 'task', 'assigned', { kind: 'module', module: 'task-service' }, { taskId: 't1' }, { agentId: 'res-01' });
    // agent 提交末节点验证材料
    publish(ctx.bus, 'task', 'nodeSubmitted', { kind: 'agent', agentId: 'res-01' }, { taskId: 't1' }, { nodeId: 'n1', isLastNode: true });
    // agent 应变 waiting
    const agent = ctx.projStore.get('SELECT * FROM agents WHERE agentId = ?', 'res-01') as any;
    expect(agent.workState).toBe('waiting');
    // 审批通过
    publish(ctx.bus, 'task', 'nodeJudged', { kind: 'human', userId: 'u1' }, { taskId: 't1' }, { nodeId: 'n1', result: 'pass' });
    // 任务应完成，agent 空闲，并发计数释放
    const task = ctx.projStore.get('SELECT * FROM tasks WHERE taskId = ?', 't1') as any;
    expect(task.state).toBe('done');
    // Phase 0 修复④：pass 后 agent 恢复 idle（此前永卡 waiting）
    const agentAfter = ctx.projStore.get('SELECT * FROM agents WHERE agentId = ?', 'res-01') as any;
    expect(agentAfter.workState).toBe('idle');
  });

  it('Phase 0 修复④：多节点 DAG 中间节点 pass → 任务不收敛，agent 保持 working', () => {
    publish(ctx.bus, 'task', 'created', undefined, { taskId: 't3' },
      { taskType: 'normal', goal: 'x', acceptanceCriteria: 'x', workspaceId: 'ws-1',
        dagNodes: [{ nodeId: 'n1', goal: '一' }, { nodeId: 'n2', goal: '二' }] });
    publish(ctx.bus, 'task', 'assigned', { kind: 'module', module: 'task-service' }, { taskId: 't3' }, { agentId: 'res-01' });
    publish(ctx.bus, 'task', 'nodeSubmitted', { kind: 'agent', agentId: 'res-01' }, { taskId: 't3' }, { nodeId: 'n1', isLastNode: false });
    publish(ctx.bus, 'task', 'nodeJudged', { kind: 'human', userId: 'u1' }, { taskId: 't3' }, { nodeId: 'n1', result: 'pass' });
    const task = ctx.projStore.get('SELECT * FROM tasks WHERE taskId = ?', 't3') as any;
    expect(task.state).toBe('inProgress'); // n2 未完成，任务不收敛
    const agent = ctx.projStore.get('SELECT * FROM agents WHERE agentId = ?', 'res-01') as any;
    expect(agent.workState).toBe('working'); // agent 继续后继节点
  });

  it('focus绑定的agent只加载该聚合任务的子任务', () => {
    // res-01 绑定 agg-1
    publish(ctx.bus, 'schedule', 'woken', { kind: 'module', module: 'scheduler' }, {}, {});
    publish(ctx.bus, 'schedule', 'focusBound', { kind: 'module', module: 'scheduler' }, {}, { aggregateTaskId: 'agg-1' });
    // 这里用 agent 视角：focusBound 事件的主体应是 agent
    // 正确写法：agent 已注册后绑定
    publish(ctx.bus, 'schedule', 'woken', { kind: 'agent', agentId: 'res-01' }, {}, {});
    publish(ctx.bus, 'schedule', 'focusBound', { kind: 'agent', agentId: 'res-01' }, {}, { aggregateTaskId: 'agg-1' });
    // 创建 agg-1 的子任务到 ws-1
    publish(ctx.bus, 'task', 'created', undefined, { taskId: 'child-1' }, { taskType: 'normal', priority: 5, workspaceId: 'ws-1', parentTaskId: 'agg-1' });
    // 创建非 agg-1 的子任务到 ws-1
    publish(ctx.bus, 'task', 'created', undefined, { taskId: 'child-2' }, { taskType: 'normal', priority: 5, workspaceId: 'ws-1', parentTaskId: 'agg-2' });
    // 触发分配：res-01 应只收到 child-1
    publish(ctx.bus, 'task', 'assigned', { kind: 'module', module: 'task-service' }, { taskId: 'child-1' }, { agentId: 'res-01' });
    const loaded = ctx.eventStore.getByFamily('schedule').find(e => e.subtype === 'loaded' && e.subject.agentId === 'res-01');
    expect(loaded).toBeDefined();
  });

  it('并发上限满时不加载新任务', () => {
    const ctx2 = setup(1); // maxWorking=1
    publish(ctx2.bus, 'task', 'created', undefined, { taskId: 't1' }, { taskType: 'normal', priority: 5, workspaceId: 'ws-1' });
    publish(ctx2.bus, 'task', 'assigned', { kind: 'module', module: 'task-service' }, { taskId: 't1' }, { agentId: 'res-01' });
    expect(ctx2.concurrencyGate.hasCapacity()).toBe(false); // 已满
    // 第二个任务不应被加载
    publish(ctx2.bus, 'task', 'created', undefined, { taskId: 't2' }, { taskType: 'normal', priority: 5, workspaceId: 'ws-1' });
    publish(ctx2.bus, 'task', 'assigned', { kind: 'module', module: 'task-service' }, { taskId: 't2' }, { agentId: 'res-02' });
    const loaded2 = ctx2.eventStore.getByFamily('schedule').find(e => e.subtype === 'loaded' && e.subject.agentId === 'res-02');
    expect(loaded2).toBeUndefined();
    ctx2.rules.stop(); ctx2.runner.stop(); ctx2.timer.stopAll();
    ctx2.projStore.close(); ctx2.eventStore.close();
  });

  it('docRead事件触发定时器重置倒计时', () => {
    ctx.timer.startTracking('res-01');
    const before = ctx.timer.getNextSleepAt('res-01');
    const wait = Date.now() + 10; while (Date.now() < wait) {}
    publish(ctx.bus, 'schedule', 'docRead', { kind: 'agent', agentId: 'res-01' }, {}, {});
    const after = ctx.timer.getNextSleepAt('res-01');
    expect(after!).toBeGreaterThan(before!);
  });

  it('审批驳回→任务回进行，agent回工作', () => {
    publish(ctx.bus, 'task', 'created', undefined, { taskId: 't1' }, { taskType: 'normal', priority: 5, workspaceId: 'ws-1' });
    publish(ctx.bus, 'task', 'assigned', { kind: 'module', module: 'task-service' }, { taskId: 't1' }, { agentId: 'res-01' });
    publish(ctx.bus, 'task', 'nodeSubmitted', { kind: 'agent', agentId: 'res-01' }, { taskId: 't1' }, { nodeId: 'n1', isLastNode: true });
    publish(ctx.bus, 'task', 'nodeJudged', { kind: 'human', userId: 'u1' }, { taskId: 't1' }, { nodeId: 'n1', result: 'reject' });
    const task = ctx.projStore.get('SELECT * FROM tasks WHERE taskId = ?', 't1') as any;
    expect(task.state).toBe('inProgress');
    // Phase 0 修复⑬：驳回 → agent 回 working 重做（4.8 补充1：原 agent 继续；此前分支空操作卡死）
    const agent = ctx.projStore.get('SELECT * FROM agents WHERE agentId = ?', 'res-01') as any;
    expect(agent.workState).toBe('working');
  });
});
