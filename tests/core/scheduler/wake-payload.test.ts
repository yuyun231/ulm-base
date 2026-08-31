// E.2 补完：调度器 wake 指令下发（8.6 唤醒载荷装配）+ sleep 顺带补（3.4 决策点）
// 设计锚点：3.3⑤ 分配链路闭环（分配→唤醒→载荷下发）、8.6 唤醒载荷、8.4 指令回执
import { describe, it, expect, afterEach } from 'vitest';
import { SchedulerRules } from '../../src/core/scheduler/rules.js';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import { ProjectionsStore } from '../../src/core/projector/projections-store.js';
import { TasksProjection } from '../../src/core/projector/projections/tasks.js';
import { TaskNodesProjection } from '../../src/core/projector/projections/task-nodes.js';
import { AgentsProjection } from '../../src/core/projector/projections/agents.js';
import { DialoguesProjection } from '../../src/core/projector/projections/dialogues.js';
import { GuidancesProjection } from '../../src/core/projector/projections/guidances.js';
import { PermissionRulesProjection } from '../../src/core/projector/projections/permission-rules.js';
import { ProjectionRunner } from '../../src/core/projector/runner.js';
import { ConcurrencyGate } from '../../src/core/scheduler/concurrency-gate.js';
import { LoadQueue } from '../../src/core/scheduler/load-queue.js';
import { TimerService } from '../../src/core/scheduler/timer.js';
import { ControlChannel } from '../../src/seam/control-channel.js';
import { ConnectionRegistry } from '../../src/seam/connection-registry.js';
import { TaskCommands } from '../../src/services/task/commands.js';
import type { TransportLayer, TransportMessage } from '../../src/seam/transport.js';

// 捕获用 stub transport：只记录指令，不产生网络行为
class RecordingTransport implements TransportLayer {
  broadcast: TransportMessage[] = [];
  directed: Array<{ connId: string; msg: TransportMessage }> = [];
  send(msg: TransportMessage): void { this.broadcast.push(msg); }
  sendTo(connId: string, msg: TransportMessage): void { this.directed.push({ connId, msg }); }
  onMessage(): () => void { return () => {}; }
  onDisconnect(): () => void { return () => {}; }
  close(): void {}
}

function setup(opts: { withRegistry?: boolean } = {}) {
  const eventStore = new EventStore(':memory:');
  const bus = new EventBus(eventStore);
  const projStore = new ProjectionsStore(':memory:');
  const projections = [
    new TasksProjection(), new TaskNodesProjection(), new AgentsProjection(), new DialoguesProjection(),
    new GuidancesProjection(), new PermissionRulesProjection(),
  ];
  const runner = new ProjectionRunner(bus, eventStore, projStore, projections);
  runner.start();
  const concurrencyGate = new ConcurrencyGate(4);
  const loadQueue = new LoadQueue();
  const timer = new TimerService(bus, { sleepCountdownSec: 30, heartbeatIntervalSec: 30, heartbeatTimeoutSec: 90 });
  const transport = new RecordingTransport();
  const registry = opts.withRegistry ? new ConnectionRegistry() : undefined;
  const controlChannel = new ControlChannel(bus, transport, registry);
  controlChannel.start();
  // Phase 0 修复③：调度器派发走命令面——测试配 module:scheduler 放行规则
  const taskCommands = new TaskCommands(bus, [
    { subject: 'module:scheduler', action: 'task:assign', object: '*', decision: 'allow' },
  ] as any);
  const rules = new SchedulerRules(bus, projStore, concurrencyGate, loadQueue, timer, controlChannel, taskCommands, {
    compressThreshold: 1000, // 高阈值：本测试不涉 F2/F3 链路
    injectInlineMaxBytes: 4096,
  });
  rules.start();
  return { eventStore, bus, projStore, runner, rules, timer, transport, registry, controlChannel };
}

function publish(bus: EventBus, family: string, subtype: string, subject: any = { kind: 'human', userId: 'u1' }, handles: any = {}, payload: any = {}) {
  bus.publish({ seq: null, timestamp: Date.now(), subject, family: family as any, subtype, handles, payload, value: null });
}

// 统一收尾：套件内可能创建多个系统实例，逐个登记清理
const cleanups: Array<() => void> = [];
function makeSystem(opts: { withRegistry?: boolean } = {}) {
  const c = setup(opts);
  cleanups.push(() => {
    c.rules.stop(); c.runner.stop(); c.controlChannel.stop(); c.timer.stopAll();
    c.projStore.close(); c.eventStore.close();
  });
  return c;
}
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

describe('E.2 调度器 wake/sleep 下发', () => {
  it('任务分配 → wake 定向下发，载荷按 8.6 装配（任务快照/对话指示 continue/指导区/权限快照/workspace）', () => {
    const c = makeSystem({ withRegistry: true });
    // 权限规则（供权限快照装配）
    publish(c.bus, 'admin', 'permissionChanged', { kind: 'module', module: 'admin' }, {},
      { ruleId: 'r1', subject: 'agent:res-01', action: 'task:reportIssue', effect: 'allow' });
    // 人创建任务（含对话 id 与工作区；带 DAG 节点数据供 ⑦ 快照装配）
    publish(c.bus, 'task', 'created', undefined, { taskId: 't1' },
      { taskType: 'normal', goal: 'G', acceptanceCriteria: 'AC', priority: 5, dialogueId: 'dlg-1', workspaceId: 'ws-1',
        dagNodes: [{ nodeId: 'node-1', goal: 'G', acceptanceCriteria: 'AC' }], dagEdges: [] });
    // 对话已有记录（首条 turnPosted 落 dialogues 表）→ 对话指示 mode=continue
    publish(c.bus, 'dialogue', 'turnPosted', { kind: 'agent', agentId: 'res-01' }, { dialogueId: 'dlg-1' },
      { channel: 'chat', author: 'u1', content: 'hello' });
    // 已发指导（type=later 不触发 F5 注入链路，保持测试聚焦）
    publish(c.bus, 'task', 'guidanceIssued', { kind: 'human', userId: 'u1' }, { taskId: 't1' },
      { guidanceId: 'g1', type: 'later', content: '注意X' });
    // agent 已连接（注册表绑定）
    c.registry!.bind('res-01', 'conn-1');
    // 任务管理员分发 → 分配链路
    publish(c.bus, 'task', 'assigned', { kind: 'module', module: 'task-service' }, { taskId: 't1' }, { agentId: 'res-01' });

    const wake = c.transport.directed.find(d => (d.msg.payload as any).command === 'wake');
    expect(wake).toBeDefined();
    expect(wake!.connId).toBe('conn-1');
    expect(wake!.msg.channel).toBe('control');
    const p = wake!.msg.payload as any;
    expect(p.agentId).toBe('res-01');
    expect(p.taskId).toBe('t1'); // 顶层 taskId：失败回执 handles 可按 taskId 追溯（方案A 语义一致）
    expect(p.task).toEqual({
      taskId: 't1', taskType: 'normal', goal: 'G', acceptanceCriteria: 'AC',
      dagVersion: 1, parentTaskId: null, dialogueId: 'dlg-1', workspaceId: 'ws-1',
    });
    expect(p.dialogue).toEqual({ dialogueId: 'dlg-1', mode: 'continue' });
    // Phase 0 修复⑦：wake 载荷含节点目标 + DAG 快照
    expect(p.nodeId).toBe('node-1');
    expect(p.dag.version).toBe(1);
    expect(p.dag.nodes).toHaveLength(1);
    expect(p.dag.nodes[0].nodeId).toBe('node-1');
    expect(p.dag.edges).toEqual([]);
    expect(p.guidance).toHaveLength(1);
    expect(p.guidance[0].guidanceId).toBe('g1');
    expect(p.guidance[0].state).toBe('issued');
    expect(p.permissions).toHaveLength(1);
    expect(p.permissions[0].ruleId).toBe('r1');
    expect(p.workspace).toEqual({ workspaceId: 'ws-1' });
  });

  it('对话不存在 → 唤醒载荷对话指示 mode=new（对话 id 透传，由内核建立）', () => {
    const c = makeSystem({ withRegistry: true });
    publish(c.bus, 'task', 'created', undefined, { taskId: 't2' }, { taskType: 'normal', dialogueId: 'dlg-2' });
    c.registry!.bind('res-02', 'conn-2');
    publish(c.bus, 'task', 'assigned', { kind: 'module', module: 'task-service' }, { taskId: 't2' }, { agentId: 'res-02' });

    const wake = c.transport.directed.find(d => (d.msg.payload as any).command === 'wake');
    expect(wake).toBeDefined();
    const p = wake!.msg.payload as any;
    expect(p.dialogue).toEqual({ dialogueId: 'dlg-2', mode: 'new' });
    expect(p.guidance).toEqual([]);
    expect(p.permissions).toEqual([]);
  });

  it('Phase 0 修复⑦：created 无 dagNodes（原始事件）→ wake nodeId=null、dag 空快照', () => {
    const c = makeSystem({ withRegistry: true });
    publish(c.bus, 'task', 'created', undefined, { taskId: 't2b' }, { taskType: 'normal' });
    c.registry!.bind('res-02b', 'conn-2b');
    publish(c.bus, 'task', 'assigned', { kind: 'module', module: 'task-service' }, { taskId: 't2b' }, { agentId: 'res-02b' });

    const wake = c.transport.directed.find(d => (d.msg.payload as any).command === 'wake');
    expect(wake).toBeDefined();
    const p = wake!.msg.payload as any;
    expect(p.nodeId).toBeNull();
    expect(p.dag).toEqual({ version: 1, nodes: [], edges: [] });
  });

  it('agent 未连接 → wake 不投递，piercingAcked(success=false) 落事件（决策2，8.4 回执要求）', () => {
    const c = makeSystem({ withRegistry: true }); // registry 存在但未绑定连接
    publish(c.bus, 'task', 'created', undefined, { taskId: 't3' }, { taskType: 'normal' });
    publish(c.bus, 'task', 'assigned', { kind: 'module', module: 'task-service' }, { taskId: 't3' }, { agentId: 'res-03' });

    expect(c.transport.directed.find(d => (d.msg.payload as any).command === 'wake')).toBeUndefined();
    const acked = c.eventStore.getByFamily('admin').find(e => e.subtype === 'piercingAcked');
    expect(acked).toBeDefined();
    expect((acked!.payload as any).agentId).toBe('res-03');
    expect((acked!.payload as any).success).toBe(false);
    expect((acked!.payload as any).detail).toBe('agent 未连接');
  });

  it('无注册表装配（既有测试形态）→ wake 走广播 send，载荷结构与定向路径一致', () => {
    const c = makeSystem(); // 不传 registry：ControlChannel 保持广播兼容
    publish(c.bus, 'task', 'created', undefined, { taskId: 't4' }, { taskType: 'normal', goal: 'G4' });
    publish(c.bus, 'task', 'assigned', { kind: 'module', module: 'task-service' }, { taskId: 't4' }, { agentId: 'res-04' });

    const wake = c.transport.broadcast.find(m => (m.payload as any).command === 'wake');
    expect(wake).toBeDefined();
    expect(wake!.channel).toBe('control');
    const p = wake!.payload as any;
    expect(p.agentId).toBe('res-04');
    expect(p.task.taskId).toBe('t4');
    expect(p.dialogue.mode).toBe('new');
  });

  it('timerFired → 调度器产 slept 事件（投影落 dormant）+ sleep 指令下发（决策1：3.4 链路闭环）', () => {
    const c = makeSystem({ withRegistry: true });
    // agent 先唤醒（投影落行）
    publish(c.bus, 'schedule', 'woken', { kind: 'agent', agentId: 'res-01' });
    c.registry!.bind('res-01', 'conn-9');
    // 模拟定时器到期（F11 setInterval 到期产 timerFired，本测试直接发该事件）
    publish(c.bus, 'schedule', 'timerFired', { kind: 'module', module: 'timer' }, {},
      { agentId: 'res-01', reason: 'sleepTimeout' });

    // 产 slept 事件（agent 状态机：唤醒→休眠）
    const slept = c.eventStore.getByFamily('schedule')
      .find(e => e.subtype === 'slept' && e.subject.kind === 'agent' && e.subject.agentId === 'res-01');
    expect(slept).toBeDefined();
    // 投影落 dormant
    const row = c.projStore.get("SELECT wakeState FROM agents WHERE agentId = 'res-01'") as any;
    expect(row.wakeState).toBe('dormant');
    // sleep 指令下发（定向）
    const sleepCmd = c.transport.directed.find(d => (d.msg.payload as any).command === 'sleep');
    expect(sleepCmd).toBeDefined();
    expect(sleepCmd!.connId).toBe('conn-9');
    expect((sleepCmd!.msg.payload as any).agentId).toBe('res-01');
  });
});
