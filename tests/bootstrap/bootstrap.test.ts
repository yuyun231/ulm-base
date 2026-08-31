import { describe, it, expect, afterEach } from 'vitest';
import { createSystem } from '../../src/system.js';
import { PermissionCommands } from '../../src/services/admin/permissions.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeTempConfig(withFactory: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'ulm-boot-'));
  writeFileSync(join(dir, 'params.yaml'), `
agent: { sleepCountdownSec: 300 }
scheduler: { maxWorkingAgents: 3 }
heartbeat: { intervalSec: 30, timeoutSec: 90 }
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
  - subject: 'module:automation'
    action: 'task:create'
    object: '*'
    decision: allow
  - subject: 'module:automation'
    action: 'task:judge'
    object: '*'
    decision: require-approval
`);
  writeFileSync(join(dir, 'automations.yaml'), `
rules:
  - ruleId: auto-archive-on-verify-pass
    trigger: { type: event, family: task, subtype: nodeJudged }
    filter: { "payload.result": "pass", "payload.nodeKey": "verify" }
    action: { type: createTask, taskType: normal, goal: "归档 {taskId}", acceptanceCriteria: "", priority: 3, procedure: archive }
    guard: { maxDepth: 2, cooldownSec: 60 }
    trackDepth: true
    subjectAllowlist: ['human:*']
    approval: auto
    enabled: true
`);
  if (withFactory) {
    writeFileSync(join(dir, 'agents.yaml'), `
agents:
  - agentId: task-admin
    role: task-admin
    description: 任务管理员
    capabilities: [task:judge, task:publishChild]
    spawnPolicy: spawn
  - agentId: historian
    role: historian
    description: 史官
    capabilities: [stream:read]
    spawnPolicy: spawn
  - agentId: plan-assistant
    role: plan-assistant
    description: 方案助手
    capabilities: [dialogue:respond]
    spawnPolicy: spawn
`);
    writeFileSync(join(dir, 'permissions.yaml'), `
rules:
  - ruleId: f-admin-judge
    subject: 'agent:task-admin'
    action: 'task:judge'
    object: '*'
    effect: allow
  - ruleId: f-hist-read
    subject: 'agent:historian'
    action: 'doc:read'
    object: '*'
    effect: allow
`);
  }
  return dir;
}

// 统一收尾（套件多实例）
const cleanups: Array<() => void> = [];
function makeSystem(withFactory: boolean) {
  const dir = makeTempConfig(withFactory);
  const system = createSystem({ configDir: dir, mode: 'test' });
  cleanups.push(() => {
    system.stop();
    try { rmSync(dir, { recursive: true }); } catch {}
  });
  return system;
}
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

describe('Phase F.2 出厂配置导入', () => {
  it('start 后出厂权限经 permissionChanged 事件导入投影', () => {
    const system = makeSystem(true);
    system.start();
    const rows = system.projStore.all('SELECT * FROM permission_rules ORDER BY ruleId ASC') as any[];
    expect(rows.map(r => r.ruleId)).toEqual(['f-admin-judge', 'f-hist-read']);
    expect(rows[0].subject).toBe('agent:task-admin');
    expect(rows[0].effect).toBe('allow');
  });

  it('既有 PermissionCommands.setPermissionRule 端到端可物化（嵌套载荷缺陷回归）', () => {
    const system = makeSystem(false);
    system.start();
    const perms = new PermissionCommands(system.bus, [
      { subject: 'human:*', action: 'admin:setPermission', object: '*', decision: 'allow' },
    ]);
    perms.setPermissionRule('human:u1', {
      subject: 'agent:res-01', action: 'task:reportIssue', object: 'task:t1', decision: 'allow',
    } as any);
    const row = system.projStore.get("SELECT * FROM permission_rules WHERE subject = 'agent:res-01'") as any;
    expect(row).toBeDefined();
    expect(row.action).toBe('task:reportIssue');
  });

  it('无出厂文件时不导入（空表）', () => {
    const system = makeSystem(false);
    system.start();
    expect(system.projStore.all('SELECT * FROM permission_rules')).toHaveLength(0);
  });

  it('start 后出厂 agent 导入 agent_registry（端到端）', () => {
    const system = makeSystem(true);
    system.start();
    const rows = system.projStore.all('SELECT * FROM agent_registry ORDER BY agentId ASC') as any[];
    expect(rows.map(r => r.agentId)).toEqual(['historian', 'plan-assistant', 'task-admin']);
    expect(rows.every(r => r.configSource === 'factory')).toBe(true);
  });

  it('端到端：nodeJudged(verify,pass) 触发规则 → module:automation 创建归档任务', () => {
    const system = makeSystem(true);
    system.start();
    system.bus.publish({
      seq: null, timestamp: Date.now(), subject: { kind: 'human', userId: 'u1' },
      family: 'task', subtype: 'nodeJudged', handles: { taskId: 't-e2e' },
      payload: { result: 'pass', nodeKey: 'verify', judgeNote: '' }, value: null,
    });
    const created = system.eventStore.getByFamily('task')
      .filter(e => e.subtype === 'created' && e.subject.kind === 'module');
    expect(created).toHaveLength(1);
    expect(created[0].payload.goal).toBe('归档 t-e2e');
    expect(created[0].payload.regenerationDepth).toBe(1);
    system.stop();
  });
});
