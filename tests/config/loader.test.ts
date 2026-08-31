import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigLoader } from '../../src/config/loader.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('ConfigLoader 出厂资产加载（Phase F.2）', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ulm-cfg-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true }); } catch {} });

  it('loadFactoryAgents 解析 agents.yaml', () => {
    writeFileSync(join(dir, 'agents.yaml'), `
agents:
  - agentId: task-admin
    role: task-admin
    description: 任务管理员
    capabilities: [task:judge, task:publishChild]
    spawnPolicy: spawn
`);
    const loader = new ConfigLoader(dir);
    const agents = loader.loadFactoryAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].agentId).toBe('task-admin');
    expect(agents[0].capabilities).toEqual(['task:judge', 'task:publishChild']);
  });

  it('loadFactoryPermissions 解析 permissions.yaml', () => {
    writeFileSync(join(dir, 'permissions.yaml'), `
rules:
  - ruleId: f-admin-judge
    subject: 'agent:task-admin'
    action: 'task:judge'
    object: '*'
    effect: allow
`);
    const loader = new ConfigLoader(dir);
    const rules = loader.loadFactoryPermissions();
    expect(rules).toHaveLength(1);
    expect(rules[0].ruleId).toBe('f-admin-judge');
    expect(rules[0].effect).toBe('allow');
  });

  it('文件缺失时优雅返回空数组（与 loadPhrases 一致）', () => {
    const loader = new ConfigLoader(dir);
    expect(loader.loadFactoryAgents()).toEqual([]);
    expect(loader.loadFactoryPermissions()).toEqual([]);
  });
});

describe('ConfigLoader.loadAutomations（Phase F.3-A）', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ulm-cfg-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true }); } catch {} });

  it('loadAutomations 解析 automations.yaml', () => {
    writeFileSync(join(dir, 'automations.yaml'), `
rules:
  - ruleId: auto-archive-on-verify-pass
    trigger: { type: event, family: task, subtype: nodeJudged }
    filter: { "payload.result": "pass", "payload.nodeKey": "verify" }
    action: { type: createTask, taskType: normal, goal: "归档 {taskId}", acceptanceCriteria: "", priority: 3, procedure: archive }
    guard: { maxDepth: 2, cooldownSec: 60 }
    trackDepth: true              # 再生追踪可选（默认 false）
    subjectAllowlist: ['human:*'] # 缺省 module 族，此规则由人类判定触发
    approval: auto                # 归档类任务自动放行（缺省 require）
    enabled: true
  - ruleId: historian-hourly
    trigger: { type: schedule, intervalSec: 3600 }
    action: { type: wake, agentId: historian }
    enabled: true
`);
    const loader = new ConfigLoader(dir);
    const rules = loader.loadAutomations();
    expect(rules).toHaveLength(2);
    expect(rules[0].ruleId).toBe('auto-archive-on-verify-pass');
    expect(rules[0].trigger.type).toBe('event');
    expect(rules[0].filter!['payload.result']).toBe('pass');
    expect(rules[0].guard!.maxDepth).toBe(2);
    expect(rules[1].trigger.type).toBe('schedule');
    expect(rules[1].trigger.intervalSec).toBe(3600);
    expect(rules[1].action.type).toBe('wake');
  });

  it('loadAutomations 文件缺失返回 []', () => {
    expect(new ConfigLoader(join(dir, 'no-such-dir')).loadAutomations()).toEqual([]);
  });

  it('loadAutomations 语法错误抛出（引擎捕获处理）', () => {
    writeFileSync(join(dir, 'automations.yaml'), 'rules: [ { broken');
    expect(() => new ConfigLoader(dir).loadAutomations()).toThrow();
  });
});
