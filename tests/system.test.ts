import { describe, it, expect, afterEach } from 'vitest';
import { createSystem } from '../src/system.js';
import { writeFileSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeTempConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'ulm-sys-'));
  writeFileSync(join(dir, 'params.yaml'), `
agent:
  sleepCountdownSec: 300
scheduler:
  maxWorkingAgents: 3
heartbeat:
  intervalSec: 30
  timeoutSec: 90
dialogue:
  compressThreshold: 100000
memory:
  injectInlineMaxBytes: 4096
feedback:
  keyNodeEvents:
    - task:created
`);
  writeFileSync(join(dir, 'permission-rules.yaml'), `
rules:
  - subject: 'human:*'
    action: '*'
    object: '*'
    decision: allow
  - subject: 'agent:*'
    action: 'doc:read'
    object: '*'
    decision: allow
`);
  return dir;
}

describe('createSystem 装配', () => {
  let dirs: string[] = [];
  afterEach(() => { for (const d of dirs) try { rmSync(d, { recursive: true }); } catch {} });

  it('createSystem 返回完整系统对象', () => {
    const dir = makeTempConfig(); dirs.push(dir);
    const system = createSystem({ configDir: dir, mode: 'test' });
    expect(system.eventStore).toBeDefined();
    expect(system.bus).toBeDefined();
    expect(system.projStore).toBeDefined();
    expect(system.gateway).toBeDefined();
    expect(system.panelApi).toBeDefined();
    expect(system.describe).toBeDefined();
    system.stop();
  });

  it('test 模式用 in-memory transport', () => {
    const dir = makeTempConfig(); dirs.push(dir);
    const system = createSystem({ configDir: dir, mode: 'test' });
    expect(system.getTransport()).toBeDefined();
    system.stop();
  });

  it('start 后发事件→投影器处理→describe 可查', () => {
    const dir = makeTempConfig(); dirs.push(dir);
    const system = createSystem({ configDir: dir, mode: 'test' });
    system.start();
    // 发一条 task:created 事件
    system.bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'u1' },
      family: 'task', subtype: 'created',
      handles: { taskId: 't1' },
      payload: { taskType: 'normal', goal: 'g', acceptanceCriteria: 'c', workspaceId: 'ws-1', priority: 5 },
      value: null,
    });
    const snapshot = system.describe();
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0].taskId).toBe('t1');
    system.stop();
  });

  it('panelApi 可创建任务', () => {
    const dir = makeTempConfig(); dirs.push(dir);
    const system = createSystem({ configDir: dir, mode: 'test' });
    system.start();
    const ack = system.panelApi.createTask('u1', { taskId: 't2', taskType: 'normal', goal: 'g2', acceptanceCriteria: 'c2', workspaceId: 'ws-2', priority: 3 });
    expect(ack.seq).toBe(1);
    const snapshot = system.describe();
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0].taskId).toBe('t2');
    system.stop();
  });

  it('Phase F.5：gitAsset 字段可访问且 repo 已初始化', () => {
    const dir = makeTempConfig(); dirs.push(dir);
    const system = createSystem({ configDir: dir, mode: 'test' });
    expect(existsSync(join(dir, '.git'))).toBe(true);
    system.stop();
  });

  it('Phase F.5：面板权限编辑热改门禁 + 落盘 + git 版本化（决策点 2）', () => {
    const dir = makeTempConfig(); dirs.push(dir);
    const system = createSystem({ configDir: dir, mode: 'test' });
    // 初始放行：注册成功
    system.panelApi.registerAgent('u1', { agentId: 'a1', role: 'r' });
    // 挂精确 deny 规则（human:u1 精确 > human:* 通配）
    system.panelApi.setPermissionRule('u1', { subject: 'human:u1', action: 'admin:registerAgent', object: '*', decision: 'deny' });
    expect(() => system.panelApi.registerAgent('u1', { agentId: 'a2', role: 'r' })).toThrow('权限拒绝');
    // 落盘 + git 提交
    const text = readFileSync(join(dir, 'permission-rules.yaml'), 'utf-8');
    expect(text).toContain('registerAgent');
    expect(system.gitAsset.getGitLog()).toContain('permission rules edited via panel');
    system.stop();
  });

  it('Phase F.5：removePermissionRule 端到端恢复放行', () => {
    const dir = makeTempConfig(); dirs.push(dir);
    const system = createSystem({ configDir: dir, mode: 'test' });
    system.panelApi.setPermissionRule('u1', { subject: 'human:u1', action: 'admin:registerAgent', object: '*', decision: 'deny' });
    expect(() => system.panelApi.registerAgent('u1', { agentId: 'a1', role: 'r' })).toThrow('权限拒绝');
    system.panelApi.removePermissionRule('u1', 'perm-human_u1-admin_registerAgent');
    system.panelApi.registerAgent('u1', { agentId: 'a1', role: 'r' });
    const text = readFileSync(join(dir, 'permission-rules.yaml'), 'utf-8');
    expect(text).not.toContain('registerAgent');
    system.stop();
  });

  it('Phase F.5：出厂导入（module:system）不落盘不 git 提交', () => {
    const dir = makeTempConfig(); dirs.push(dir);
    const system = createSystem({ configDir: dir, mode: 'test' });
    system.start();
    expect(system.gitAsset.getGitLog()).not.toContain('permission rules edited via panel');
    system.stop();
  });
});
