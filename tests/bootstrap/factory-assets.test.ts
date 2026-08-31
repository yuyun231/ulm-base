import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

// 资产完整性测试：vitest cwd = 项目根
const ASSETS = join(process.cwd(), 'assets');

describe('出厂资产完整性（Phase F.2）', () => {
  it('agents.yaml：3 内置 agent（spawn 档）', () => {
    const doc = parseYaml(readFileSync(join(ASSETS, 'agents.yaml'), 'utf-8')) as any;
    const ids = doc.agents.map((a: any) => a.agentId);
    expect(ids).toEqual(['task-admin', 'historian', 'plan-assistant']);
    expect(doc.agents.every((a: any) => a.spawnPolicy === 'spawn')).toBe(true);
  });

  it('permissions.yaml：内置 agent 权限预配 + human 面板 allow + agent admin deny', () => {
    const doc = parseYaml(readFileSync(join(ASSETS, 'permissions.yaml'), 'utf-8')) as any;
    const byId = Object.fromEntries(doc.rules.map((r: any) => [r.ruleId, r]));
    expect(byId['f-human-panel'].effect).toBe('allow');
    expect(byId['f-admin-judge'].subject).toBe('agent:task-admin');
    expect(byId['f-agent-deny-admin'].effect).toBe('deny');
  });

  it('procedures：normal/archive 模板可解析（nodes/edges 结构）', () => {
    for (const f of ['normal.yaml', 'archive.yaml']) {
      const doc = parseYaml(readFileSync(join(ASSETS, 'procedures', f), 'utf-8')) as any;
      expect(doc.taskType).toBeDefined();
      expect(Array.isArray(doc.nodes) && doc.nodes.length > 0).toBe(true);
      expect(Array.isArray(doc.edges)).toBe(true);
    }
  });

  it('workflows：3 个 .md 工序说明存在', () => {
    for (const f of ['task-admin.md', 'historian.md', 'plan-assistant.md']) {
      expect(existsSync(join(ASSETS, 'workflows', f))).toBe(true);
    }
  });
});
