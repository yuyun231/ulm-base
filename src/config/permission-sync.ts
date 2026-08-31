import type { EventBus, Subscriber } from '../core/event-bus/bus.js';
import type { StoredEventEnvelope } from '../core/event-bus/envelope.js';
import type { PermissionRule } from '../core/permission/rule-loader.js';
import type { GitAsset } from '../core/git-asset.js';
import * as yaml from 'yaml';

// Phase F.5（决策点 2）：面板权限热改生效。
// 订阅 admin.permissionChanged / admin.permissionRemoved：
//   1. 同步共享门禁数组（System 内 rules 引用被 PanelApi/命令组/ServiceChannel 共享，原地改即全生效）
//   2. 落盘 permission-rules.yaml（GitAsset 版本化，设计总则 1：面板配置持久化在项目内）
// 边界：只处理 human 主体事件（面板编辑）。出厂导入（module:system）不热改不落盘——
// 保持 F.2 门禁基线（permission-rules.yaml）与出厂权限预配（permissions.yaml）两文件分离语义。
// 两轨字段名：门禁轨 PermissionRule.decision ↔ 投影轨 effect（映射在同步层，命令层出口统一 effect）。

const RULES_FILE = 'permission-rules.yaml';

export function wirePermissionSync(
  bus: EventBus,
  rules: PermissionRule[],
  gitAsset: GitAsset,
): () => void {
  function onEvent(env: StoredEventEnvelope): void {
    // 面板编辑一律 human 主体；出厂导入（module:system）不回写门禁与基线文件
    if (env.subject.kind !== 'human') return;
    const p = env.payload as any;
    let changed = false;
    if (env.subtype === 'permissionChanged') {
      const rule: PermissionRule = {
        ruleId: p.ruleId, subject: p.subject, action: p.action, object: p.object, decision: p.effect,
      };
      const idx = rules.findIndex(r => r.ruleId === p.ruleId);
      if (idx >= 0) rules[idx] = rule;
      else rules.push(rule);
      changed = true;
    } else if (env.subtype === 'permissionRemoved') {
      const idx = rules.findIndex(r => r.ruleId === p.ruleId);
      // 无此规则 → 无变更不落盘（避免无意义 git 提交）
      if (idx >= 0) { rules.splice(idx, 1); changed = true; }
    } else {
      return;
    }
    if (changed) flushToYaml();
  }

  // 落盘形状与现格式一致；ruleId 不落盘（命令层稳定重生成），decision 为门禁轨字段名
  function flushToYaml(): void {
    const doc = { rules: rules.map(({ ruleId: _ruleId, ...rest }) => rest) };
    gitAsset.writeAndCommit(RULES_FILE, yaml.stringify(doc), `chore: permission rules edited via panel (${rules.length} rules)`);
  }

  const subscriber: Subscriber = onEvent;
  const unsubs = [
    bus.subscribe(subscriber, { family: 'admin', subtype: 'permissionChanged' }),
    bus.subscribe(subscriber, { family: 'admin', subtype: 'permissionRemoved' }),
  ];
  return () => unsubs.forEach(u => u());
}
