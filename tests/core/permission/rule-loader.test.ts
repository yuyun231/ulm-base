import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RuleLoader } from '../../src/core/permission/rule-loader.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function makeTempYaml(rules: any[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ulm-perm-'));
  const file = path.join(dir, 'permission-rules.yaml');
  const yamlText = `rules:\n` + rules.map(r =>
    `  - subject: "${r.subject}"\n    action: "${r.action}"\n    object: "${r.object}"\n    decision: "${r.decision}"\n`
  ).join('');
  fs.writeFileSync(file, yamlText);
  return file;
}

describe('RuleLoader 权限规则加载器', () => {
  let tempFile: string;

  beforeEach(() => {
    tempFile = makeTempYaml([
      { subject: 'human:*', action: 'task:create', object: '*', decision: 'allow' },
      { subject: 'agent:res-01', action: 'task:report', object: 'task:t1', decision: 'allow' },
      { subject: 'agent:*', action: 'admin:*', object: '*', decision: 'deny' },
      { subject: 'human:*', action: 'task:approve', object: 'task:*', decision: 'require-approval' },
    ]);
  });

  afterEach(() => {
    const dir = path.dirname(tempFile);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('加载 yaml 返回规则数组', () => {
    const loader = new RuleLoader();
    const rules = loader.load(tempFile);
    expect(rules).toHaveLength(4);
    expect(rules[0].subject).toBe('human:*');
    expect(rules[0].decision).toBe('allow');
  });

  it('热改：文件更新后 reload 返回新规则', () => {
    const loader = new RuleLoader();
    const rules1 = loader.load(tempFile);
    expect(rules1).toHaveLength(4);
    // 更新文件
    fs.writeFileSync(tempFile, 'rules:\n  - subject: "human:*"\n    action: "task:create"\n    object: "*"\n    decision: "allow"\n');
    const rules2 = loader.load(tempFile);
    expect(rules2).toHaveLength(1);
  });

  it('空规则文件返回空数组', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ulm-empty-'));
    const file = path.join(dir, 'empty.yaml');
    fs.writeFileSync(file, 'rules: []\n');
    const loader = new RuleLoader();
    const rules = loader.load(file);
    expect(rules).toHaveLength(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
