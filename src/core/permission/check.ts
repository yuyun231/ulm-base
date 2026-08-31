import type { PermissionRule } from './rule-loader.js';

// 设计锚点 3.6：主体×动作×对象三元判定。校验点在每个服务命令入口。
// 设计锚点 6.5a：对象粒度三级（聚合任务→子任务→agent）——首版用通配匹配，三级粒度由规则配置表达。
// 设计锚点 6.7：管理模块对 agent 结构性无入口——check 只校验有路由的端点，admin 端点对 agent 不可达。

export type { PermissionRule } from './rule-loader.js';

export interface CheckResult {
  decision: 'allow' | 'deny' | 'require-approval';
  matchedRule?: PermissionRule;
  reason?: string;
}

// 通配符匹配：* 匹配任意
function match(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2);
    return value.startsWith(prefix + ':') || value === prefix;
  }
  return pattern === value;
}

// 3.6 三元判定：主体×动作×对象
// 精确规则优先于通配规则（按 specificity 排序）
export function checkPermission(
  rules: PermissionRule[],
  subject: string,
  action: string,
  object: string,
): CheckResult {
  // 计算 specificity 并排序：精确匹配 > 通配匹配
  const sorted = rules.map(r => ({
    rule: r,
    specificity: (r.subject.includes('*') ? 0 : 1) +
                 (r.action.includes('*') ? 0 : 1) +
                 (r.object.includes('*') ? 0 : 1),
  })).sort((a, b) => b.specificity - a.specificity);

  for (const { rule } of sorted) {
    if (match(rule.subject, subject) &&
        match(rule.action, action) &&
        match(rule.object, object)) {
      return { decision: rule.decision, matchedRule: rule };
    }
  }

  // 6.7 最小权限原则：无匹配默认 deny
  return { decision: 'deny', reason: '无匹配规则，默认拒绝（最小权限原则）' };
}
