import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'yaml';
import type { PermissionRule } from '../core/permission/rule-loader.js';

// 9.4 yaml 清单：params.yaml + phrases.yaml + permission-rules.yaml
// 加载器在 main 启动时读三份 yaml，供各模块使用

export interface ParamsConfig {
  agent: { sleepCountdownSec: number };
  scheduler: { maxWorkingAgents: number };
  historian: { reportEnabled: boolean };
  automation: { fullAuto: boolean };
  consult: { timeoutSec: number; requireApproval: boolean };
  heartbeat: { intervalSec: number; timeoutSec: number };
  dialogue: { compressThreshold: number };
  memory: { injectInlineMaxBytes: number };
  feedback: { keyNodeEvents: string[] };
  agents: { coreList: string[] };
  judge: { defaults: any };
  guidance: { ackTimeoutSec: number };
  supervisor?: {   // Phase F.4：可选段，缺省 spawn 档不托管
    spawnCommandTemplate?: string; baseMs?: number; factor?: number; maxMs?: number; maxRetries?: number;
  };
}

// ========== Phase F.3：自动化规则（automations.yaml，D7 命名避开权限 rules） ==========
export interface AutomationTrigger {
  type: 'event' | 'schedule';
  family?: string;       // event 触发：匹配事件 family
  subtype?: string;      // event 触发：匹配事件 subtype
  intervalSec?: number;  // schedule 触发：间隔秒
}

export interface AutomationAction {
  type: 'createTask' | 'wake';
  // createTask 用：
  taskType?: string;
  goal?: string;              // 支持 {key} 插值（变量取触发事件 payload+handles 合并）
  acceptanceCriteria?: string;
  priority?: number;
  workspaceId?: string;       // 缺省 'ws-automation'
  procedure?: string;         // 登记字段：模板消费在 admin 侧，基座不建执行器
  // wake 用：
  agentId?: string;
}

export interface AutomationGuard {
  maxDepth?: number;      // 再生最大代数
  cooldownSec?: number;   // 冷却窗口
}

export interface AutomationRule {
  ruleId: string;
  trigger: AutomationTrigger;
  filter?: Record<string, string | number | boolean>;  // 点路径精确匹配
  action: AutomationAction;
  guard?: AutomationGuard;
  subjectAllowlist?: string[];  // 缺省 ['module:automation','module:timer','module:scheduler']；条目支持 ':*' 通配（如 'human:*'）
  trackDepth?: boolean;         // 再生深度追踪开关（默认 false：不追踪，只认事件自带 depth）
  approval?: 'auto' | 'require';// 审批分层（默认 'require'：产的任务首个节点审批卡 require-approval）
  enabled: boolean;
}

export class ConfigLoader {
  private configDir: string;

  constructor(configDir: string) {
    this.configDir = configDir;
  }

  // F6：self-describe 需读 configDir 下的资产（工作流清单/params 当前值），暴露只读访问
  getConfigDir(): string {
    return this.configDir;
  }

  loadParams(): ParamsConfig {
    const raw = readFileSync(join(this.configDir, 'params.yaml'), 'utf-8');
    return yaml.parse(raw) as ParamsConfig;
  }

  loadPermissionRules(): PermissionRule[] {
    const raw = readFileSync(join(this.configDir, 'permission-rules.yaml'), 'utf-8');
    const parsed = yaml.parse(raw) as { rules: PermissionRule[] };
    return parsed.rules;
  }

  loadPhrases(): Record<string, string> {
    try {
      const raw = readFileSync(join(this.configDir, 'phrases.yaml'), 'utf-8');
      return yaml.parse(raw) as Record<string, string>;
    } catch {
      return {}; // phrases.yaml 首版可选
    }
  }

  // Phase F.2：出厂 agent 身份清单（缺失→空数组，优雅降级）
  loadFactoryAgents(): FactoryAgentConfig[] {
    try {
      const raw = readFileSync(join(this.configDir, 'agents.yaml'), 'utf-8');
      const parsed = yaml.parse(raw) as { agents?: FactoryAgentConfig[] };
      return parsed.agents ?? [];
    } catch {
      return [];
    }
  }

  // Phase F.2：出厂权限规则（缺失→空数组）
  loadFactoryPermissions(): FactoryPermissionRule[] {
    try {
      const raw = readFileSync(join(this.configDir, 'permissions.yaml'), 'utf-8');
      const parsed = yaml.parse(raw) as { rules?: FactoryPermissionRule[] };
      return parsed.rules ?? [];
    } catch {
      return [];
    }
  }

  // Phase F.3：自动化规则（缺失→[]；语法错误→抛出，引擎捕获落 automationSkipped 并保旧表）
  loadAutomations(): AutomationRule[] {
    let raw: string;
    try {
      raw = readFileSync(join(this.configDir, 'automations.yaml'), 'utf-8');
    } catch {
      return [];
    }
    const doc = yaml.parse(raw) as { rules?: AutomationRule[] } | null;
    return doc?.rules ?? [];
  }
}

// Phase F.2：出厂 agent 声明（agents.yaml）
export interface FactoryAgentConfig {
  agentId: string;
  role: string;
  description?: string;
  capabilities?: string[];
  spawnPolicy?: 'spawn' | 'external';
}

// Phase F.2：出厂权限规则（permissions.yaml）——effect 对齐投影消费形状（permission_rules.effect），
// 与门禁轨 PermissionRule.decision 是两个轨道的字段名
export interface FactoryPermissionRule {
  ruleId: string;
  subject: string;
  action: string;
  object: string;
  effect: 'allow' | 'deny' | 'require-approval';
}
