import { describe, it, expect, afterEach } from 'vitest';
import { createSystem } from '../../src/system.js';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

function makePanelConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'ulm-panel-e2e-'));
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
  - subject: 'agent:*'
    action: 'admin:*'
    object: '*'
    decision: deny
  - subject: 'module:automation'
    action: 'task:create'
    object: '*'
    decision: allow
`);
  writeFileSync(join(dir, 'agents.yaml'), `
agents:
  - agentId: task-admin
    role: task-admin
    description: 任务管理员
    capabilities: [task:judge]
    spawnPolicy: external
  - agentId: res-spawn
    role: worker
    description: spawn 档托管样例
    capabilities: []
    spawnPolicy: spawn
`);
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  writeFileSync(join(dir, 'workflows', 'task-admin.md'), '# 任务管理员工作流 v1');
  // F.3 allowlist 语义（决策点 1）：human 主体触发需显式 ['human:*']——
  // 缺省白名单只含 module:automation/timer/scheduler；出厂导入（module:system）同样不在其中，
  // 正好保证开工不产任务，仅面板注册（human）触发
  writeFileSync(join(dir, 'automations.yaml'), `
rules:
  - ruleId: panel-tick
    trigger: { type: event, family: admin, subtype: agentRegistered }
    subjectAllowlist: ['human:*']
    action: { type: createTask, goal: '跟进新 agent {agentId}', taskType: normal }
    enabled: true
`);
  return dir;
}

describe('F.5 面板整合端到端', () => {
  let dir = '';
  let system: ReturnType<typeof createSystem> | null = null;

  afterEach(() => {
    try { system?.stop(); } catch { /* 忽略 */ }
    system = null;
    try { if (dir) rmSync(dir, { recursive: true }); } catch { /* 忽略 */ }
    dir = '';
  });

  it('面板全链路：注册→查询→automations 热改触发→工作流版本化→托管→权限删除', () => {
    dir = makePanelConfig();
    system = createSystem({
      configDir: dir, mode: 'test',
      supervisorSpawnFn: (() => makeFakeChild()) as any,
    });
    system.start();

    // 1. 查询面：出厂 agent 注册完成（F.2 工厂导入）
    const agentIds = system.panelApi.queryAgents().map((a: any) => a.agentId);
    expect(agentIds).toContain('task-admin');
    expect(agentIds).toContain('res-spawn');

    // 2. spawn 档出厂拉起（F.4 Supervisor.start）
    expect(system.eventStore.getByFamily('admin').filter(e => e.subtype === 'agentSpawned').length).toBe(1);

    // 3. 面板注册新 agent（configSource=panel）→ 自动化规则监听 agentRegistered 产任务
    system.panelApi.registerAgent('u1', { agentId: 'res-01', role: 'worker', capabilities: ['doc:read'] });
    const autoTasks = system.projStore.all("SELECT * FROM tasks WHERE taskId LIKE 'auto-panel-tick-%'");
    expect(autoTasks.length).toBe(1);
    expect((autoTasks[0] as any).goal).toBe('跟进新 agent res-01');
    const panelAgent = system.panelApi.queryAgents().find((a: any) => a.agentId === 'res-01');
    expect(panelAgent.configSource).toBe('panel');
    expect(panelAgent.connected).toBe(false);

    // 4. 工作流编辑（GitAsset 版本化）+ 查询面读回
    system.panelApi.writeWorkflow('u1', 'task-admin', '# 任务管理员工作流 v2');
    expect(system.gitAsset.getGitLog()).toContain('panel edit workflows/task-admin.md');
    expect(system.panelApi.queryWorkflow('task-admin')).toBe('# 任务管理员工作流 v2');

    // 5. automations 编辑 → ruleChanged 热加载 → 新规则对后续事件生效
    system.panelApi.writeAutomations('u1', `
rules:
  - ruleId: panel-tick-2
    trigger: { type: event, family: admin, subtype: agentRegistered }
    subjectAllowlist: ['human:*']
    action: { type: createTask, goal: '二段跟进 {agentId}' }
    enabled: true
`);
    system.panelApi.registerAgent('u1', { agentId: 'res-02', role: 'worker' });
    const t2 = system.projStore.all("SELECT * FROM tasks WHERE taskId LIKE 'auto-panel-tick-2-%'");
    expect(t2.length).toBe(1);
    expect((t2[0] as any).goal).toBe('二段跟进 res-02');
    // 旧规则已被热加载替换：res-02 不再产 panel-tick 任务（排除新规则 taskId 前缀同名匹配）
    expect(system.projStore.all("SELECT * FROM tasks WHERE taskId LIKE 'auto-panel-tick-%' AND taskId NOT LIKE 'auto-panel-tick-2-%'").length).toBe(1);

    // 6. 托管动作（设计 5.3）：stop = manualStop 不重启；start 再拉起
    system.panelApi.manageAgent('u1', 'res-spawn', 'stop');
    expect(system.eventStore.getByFamily('admin').filter(e => e.subtype === 'agentExited').length).toBe(1);
    expect(system.eventStore.getByFamily('admin').filter(e => e.subtype === 'agentRestartScheduled').length).toBe(0);
    system.panelApi.manageAgent('u1', 'res-spawn', 'start');
    expect(system.eventStore.getByFamily('admin').filter(e => e.subtype === 'agentSpawned').length).toBe(2);

    // 7. 权限增删端到端（决策点 1/2）：deny 落投影 → 删除后投影恢复
    system.panelApi.setPermissionRule('u1', { subject: 'agent:task-admin', action: 'dialogue:respond', object: '*', decision: 'deny' });
    const ruleId = 'perm-agent_task-admin-dialogue_respond';
    expect(system.projStore.get('SELECT * FROM permission_rules WHERE ruleId = ?', ruleId)).toBeDefined();
    system.panelApi.removePermissionRule('u1', ruleId);
    expect(system.projStore.get('SELECT * FROM permission_rules WHERE ruleId = ?', ruleId)).toBeUndefined();
    expect(system.gitAsset.getGitLog()).toContain('permission rules edited via panel');
  });
});
