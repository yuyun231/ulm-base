// Phase 0 闭环 e2e：任务从创建到完成全链路（修③④⑨⑬ + ⑥⑦⑤ 验收）
// 链路：createTask → 调度器自动 assign → wake(含 nodeId/DAG) → agent submitMaterial（service 端点）
//       → judgeResult 判定请求下发 → 内核 ack(pass/reject) → piercingAcked → nodeJudged → 状态恢复 → 下一任务续派
// 心跳：注册后不续跳 → agentLost → 任务转 paused（8.7 补充2）
import { describe, it, expect, afterEach } from 'vitest';
import { createSystem } from '../src/system.js';
import { InMemoryServer } from '../src/seam/in-memory-transport.js';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TransportMessage } from '../src/seam/transport.js';

function makeConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'ulm-closed-loop-'));
  writeFileSync(join(dir, 'params.yaml'), `
agent: { sleepCountdownSec: 3600 }
scheduler: { maxWorkingAgents: 3 }
heartbeat: { intervalSec: 1, timeoutSec: 1 }
dialogue: { compressThreshold: 100000 }
memory: { injectInlineMaxBytes: 4096 }
feedback: { keyNodeEvents: [] }
`);
  writeFileSync(join(dir, 'permission-rules.yaml'), `
rules:
  - subject: 'human:*'
    action: '*'
    object: '*'
    decision: allow
  # Phase 0 修复③⑨：调度器经命令面派发/判定
  - subject: 'module:scheduler'
    action: 'task:assign'
    object: '*'
    decision: allow
  - subject: 'module:scheduler'
    action: 'task:approve'
    object: '*'
    decision: allow
  - subject: 'module:scheduler'
    action: 'task:reject'
    object: '*'
    decision: allow
  # agent 提交材料（service 端点）
  - subject: 'agent:*'
    action: 'task:submitMaterial'
    object: '*'
    decision: allow
  - subject: 'agent:*'
    action: 'admin:*'
    object: '*'
    decision: deny
`);
  // 出厂注册 res-01（白名单准入 + task:judge 判定 capability；连接由测试模拟内核建立）
  writeFileSync(join(dir, 'agents.yaml'), `
agents:
  - agentId: res-01
    role: worker
    description: 执行者兼判定者
    capabilities: [task:judge]
    spawnPolicy: external
`);
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  writeFileSync(join(dir, 'automations.yaml'), `
rules: []
`);
  return dir;
}

describe('Phase 0 闭环 e2e — 派发→执行→判定→恢复', () => {
  let dir = '';
  let system: ReturnType<typeof createSystem> | null = null;

  afterEach(() => {
    try { system?.stop(); } catch { /* 忽略 */ }
    system = null;
    try { if (dir) rmSync(dir, { recursive: true }); } catch { /* 忽略 */ }
    dir = '';
  });

  function boot() {
    dir = makeConfig();
    system = createSystem({ configDir: dir, mode: 'test' });
    system.start();
    const client = (system.getTransport() as InMemoryServer).connect();
    const inbox: TransportMessage[] = [];
    client.onMessage((msg) => inbox.push(msg));
    return { client, inbox };
  }

  const taskRow = (taskId: string) =>
    system!.projStore.get('SELECT * FROM tasks WHERE taskId = ?', taskId) as any;
  const agentRow = (agentId: string) =>
    system!.projStore.get('SELECT * FROM agents WHERE agentId = ?', agentId) as any;
  const nodeRow = (taskId: string, nodeId: string) =>
    system!.projStore.get('SELECT * FROM task_nodes WHERE taskId = ? AND nodeId = ?', taskId, nodeId) as any;
  const queueCount = (taskId: string) =>
    (system!.projStore.get('SELECT COUNT(*) AS n FROM load_queue WHERE taskId = ?', taskId) as any).n;

  function register(client: ReturnType<InMemoryServer['connect']>, agentId: string) {
    client.send({ channel: 'control', payload: { type: 'register', agentId, role: 'worker', capabilities: ['task:judge'] } } as any);
  }

  function submitMaterial(client: ReturnType<InMemoryServer['connect']>, agentId: string, taskId: string, nodeId: string, material: string, isLastNode: boolean) {
    client.send({
      channel: 'service',
      payload: { type: 'request', requestId: `req-${taskId}`, endpoint: 'submitMaterial', agentId, args: { taskId, nodeId, material, isLastNode } },
    } as any);
  }

  const lastJudgeCmd = (inbox: TransportMessage[]) =>
    [...inbox].reverse().find(m => (m.payload as any)?.command === 'judgeResult');

  it('全链路：创建→自动派发→wake(nodeId/DAG)→提交材料→判定下发→ack pass→任务 done+agent idle→下一任务续派', () => {
    const { client, inbox } = boot();
    register(client, 'res-01');
    // 注册→woken→agents 投影 idle
    expect(agentRow('res-01').wakeState).toBe('awakened');
    expect(agentRow('res-01').workState).toBe('idle');

    // ③ 修复验收：创建任务后无人介入自动派发
    system!.panelApi.createTask('u1', {
      taskId: 'task-1', taskType: 'normal', goal: '整理文档',
      acceptanceCriteria: '格式合规', workspaceId: 'ws-1', priority: 5,
    });
    const t1 = taskRow('task-1');
    expect(t1.state).toBe('inProgress');
    expect(t1.assignedAgent).toBe('res-01');
    // 命令面派发 → load_queue 真正出队
    expect(queueCount('task-1')).toBe(0);
    // ⑥ 修复验收：缺省 DAG 自动生成单节点
    expect(nodeRow('task-1', 'node-1')).toBeTruthy();
    // ⑦ 修复验收：wake 载荷含 nodeId + DAG 快照
    const wake = inbox.find(m => (m.payload as any)?.command === 'wake');
    expect(wake).toBeDefined();
    const wp = wake!.payload as any;
    expect(wp.taskId).toBe('task-1');
    expect(wp.nodeId).toBe('node-1');
    expect(wp.dag.version).toBe(1);
    expect(wp.dag.nodes).toHaveLength(1);
    expect(wp.dag.nodes[0].nodeId).toBe('node-1');
    expect(wp.dag.edges).toEqual([]);

    // agent 提交验证材料（service 端点，8.3）
    submitMaterial(client, 'res-01', 'task-1', 'node-1', '文档已按规范整理', true);
    expect(agentRow('res-01').workState).toBe('waiting');
    // ⑨ 修复验收：判定请求经 judgeResult 指令下发（含 commandId/nodeId/material）
    const judge = lastJudgeCmd(inbox);
    expect(judge).toBeDefined();
    const jp = judge!.payload as any;
    expect(jp.commandId).toBeTruthy();
    expect(jp.nodeId).toBe('node-1');
    expect(jp.material).toBe('文档已按规范整理');

    // 判定人（内核）回执 pass → piercingAcked → 桥转 approve → nodeJudged
    client.send({
      channel: 'control',
      payload: { type: 'ack', commandId: jp.commandId, agentId: 'res-01', success: true,
        taskId: 'task-1', result: 'pass', detail: '符合验收标准' },
    } as any);
    expect(taskRow('task-1').state).toBe('done');
    expect(nodeRow('task-1', 'node-1').nodeState).toBe('done');
    // ④ 修复验收：agent 恢复 idle（此前永卡 waiting）
    expect(agentRow('res-01').workState).toBe('idle');

    // 闭环不卡死：第二个任务自动续派到同一 agent
    system!.panelApi.createTask('u1', {
      taskId: 'task-2', taskType: 'normal', goal: '第二件事',
      acceptanceCriteria: '完成', workspaceId: 'ws-1', priority: 1,
    });
    expect(taskRow('task-2').state).toBe('inProgress');
    expect(taskRow('task-2').assignedAgent).toBe('res-01');
    expect(inbox.filter(m => (m.payload as any)?.command === 'wake').length).toBe(2);
  });

  it('驳回路径：ack reject → 任务回进行、节点回 inProgress、agent 回 working（4.8 补充1）', () => {
    const { client, inbox } = boot();
    register(client, 'res-01');
    system!.panelApi.createTask('u1', {
      taskId: 'task-r', taskType: 'normal', goal: '被驳回的活',
      acceptanceCriteria: '高标准', workspaceId: 'ws-1', priority: 1,
    });
    expect(taskRow('task-r').assignedAgent).toBe('res-01');
    submitMaterial(client, 'res-01', 'task-r', 'node-1', '初版材料', true);
    const jp = lastJudgeCmd(inbox)!.payload as any;

    client.send({
      channel: 'control',
      payload: { type: 'ack', commandId: jp.commandId, agentId: 'res-01', success: true,
        taskId: 'task-r', result: 'reject', detail: '格式不符，重做' },
    } as any);
    // ⑬ 修复验收：驳回后任务回进行（原 agent 继续）、节点回 inProgress、agent 回 working
    expect(taskRow('task-r').state).toBe('inProgress');
    expect(nodeRow('task-r', 'node-1').nodeState).toBe('inProgress');
    expect(agentRow('res-01').workState).toBe('working');
  });

  it('心跳超时：agentLost → agent lost=1，进行中任务转 paused（8.7 补充2）', async () => {
    const { client } = boot(); // timeoutSec=1，System 每秒轮询
    register(client, 'res-01');
    system!.panelApi.createTask('u1', {
      taskId: 'task-h', taskType: 'normal', goal: '长任务',
      acceptanceCriteria: 'x', workspaceId: 'ws-1', priority: 1,
    });
    expect(taskRow('task-h').state).toBe('inProgress');
    // 注册后不再发心跳 → 超时（timeoutSec=1）+ 轮询间隔（1s）
    await new Promise(r => setTimeout(r, 2600));
    expect(agentRow('res-01').lost).toBe(1);
    expect(taskRow('task-h').state).toBe('paused');
  });
});
