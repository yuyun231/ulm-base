import type { EventBus } from '../../core/event-bus/bus.js';
import type { ProjectionsStore } from '../../core/projector/projections-store.js';
import type { PermissionRule } from '../../core/permission/rule-loader.js';
import type { GitAsset } from '../../core/git-asset.js';
import type { SupervisorService } from '../../core/supervisor/supervisor.js';
import { checkPermission } from '../../core/permission/check.js';
import type { EventEnvelope } from '../../core/event-bus/envelope.js';
import * as yaml from 'yaml';

function parseSubject(s: string): EventEnvelope['subject'] {
  const [kind, id] = s.split(':');
  if (kind === 'human') return { kind: 'human', userId: id };
  if (kind === 'agent') return { kind: 'agent', agentId: id };
  return { kind: 'module', module: id };
}

// 资产名白名单：防路径穿越（面板输入不可信，relPath 由白名单名拼接）
const ASSET_NAME_RE = /^[A-Za-z0-9_-]+$/;

// 设计锚点 6.2（Phase F.5，决策点 3A）：agent 注册/资产/托管命令组（面板动作面）
// 动作三档：admin:registerAgent（注册/更新/移除）、admin:editAsset（工作流/工序/automations 编辑）、
// admin:manageAgent（托管 start/stop/restart）。权限模式与 PurposeCommands 一致：deny 即抛错。
export class AgentRegistryCommands {
  private bus: EventBus;
  private rules: PermissionRule[];
  private projStore: ProjectionsStore;
  private gitAsset: GitAsset | null;
  private supervisor: SupervisorService | null;

  constructor(deps: {
    bus: EventBus;
    rules: PermissionRule[];
    projStore: ProjectionsStore;
    gitAsset?: GitAsset | null;
    supervisor?: SupervisorService | null;
  }) {
    this.bus = deps.bus;
    this.rules = deps.rules;
    this.projStore = deps.projStore;
    this.gitAsset = deps.gitAsset ?? null;
    this.supervisor = deps.supervisor ?? null;
  }

  // F.5 查询面：资产读取访问（PanelApi 查询路由用）
  get asset(): GitAsset | null {
    return this.gitAsset;
  }

  private require(subject: string, action: string, object: string): void {
    const perm = checkPermission(this.rules, subject, action, object);
    if (perm.decision === 'deny') throw new Error(`权限拒绝`);
  }

  // ---- admin:registerAgent：注册/更新/移除（D1 前置：先注册后可连接） ----

  registerAgent(subject: string, input: {
    agentId: string; role: string; description?: string | null;
    capabilities?: string[]; spawnPolicy?: 'external' | 'spawn'; enabled?: boolean;
  }) {
    this.require(subject, 'admin:registerAgent', `agent:${input.agentId}`);
    if (!input.agentId || !input.role) throw new Error('agentId 与 role 必填');
    return this.bus.publish({
      seq: null, timestamp: Date.now(), subject: parseSubject(subject),
      family: 'admin', subtype: 'agentRegistered', handles: {},
      payload: {
        agentId: input.agentId, role: input.role, description: input.description ?? null,
        capabilities: input.capabilities ?? [], spawnPolicy: input.spawnPolicy ?? 'external',
        configSource: 'panel', enabled: input.enabled ?? true,
      },
      value: null,
    });
  }

  removeAgent(subject: string, agentId: string) {
    this.require(subject, 'admin:registerAgent', `agent:${agentId}`);
    const exists = this.projStore.get('SELECT agentId FROM agent_registry WHERE agentId = ?', agentId);
    if (!exists) throw new Error(`agent 不存在: ${agentId}`);
    return this.bus.publish({
      seq: null, timestamp: Date.now(), subject: parseSubject(subject),
      family: 'admin', subtype: 'agentRemoved', handles: {},
      payload: { agentId },
      value: null,
    });
  }

  // ---- admin:editAsset：GitAsset 版本化编辑（设计总则 1） ----

  writeWorkflow(subject: string, agentId: string, content: string): void {
    this.require(subject, 'admin:editAsset', `workflow:${agentId}`);
    if (!ASSET_NAME_RE.test(agentId)) throw new Error(`非法资产名: ${agentId}`);
    this.requireAsset();
    this.gitAsset!.writeAndCommit(`workflows/${agentId}.md`, content, `feat: panel edit workflows/${agentId}.md`);
  }

  writeProcedure(subject: string, name: string, content: string): void {
    this.require(subject, 'admin:editAsset', `procedure:${name}`);
    if (!ASSET_NAME_RE.test(name)) throw new Error(`非法资产名: ${name}`);
    this.requireAsset();
    // 语法先验：解析失败不落盘不提交（查询面读坏文件比拒绝保存更糟）
    try { yaml.parse(content); } catch (e) {
      throw new Error(`procedures/${name}.yaml 语法错误: ${String((e as Error).message ?? e)}`);
    }
    this.gitAsset!.writeAndCommit(`procedures/${name}.yaml`, content, `feat: panel edit procedures/${name}.yaml`);
  }

  writeAutomations(subject: string, content: string) {
    this.require(subject, 'admin:editAsset', 'automations');
    this.requireAsset();
    // 语法先验：解析失败不落盘不发事件（引擎 ruleChanged 热加载读的是落盘文件）
    try { yaml.parse(content); } catch (e) {
      throw new Error(`automations.yaml 语法错误: ${String((e as Error).message ?? e)}`);
    }
    this.gitAsset!.writeAndCommit('automations.yaml', content, 'feat: panel edit automations');
    // 引擎订阅 admin.ruleChanged → reloadRules() 重读文件重建规则表（F.3 既有热加载链路）
    return this.bus.publish({
      seq: null, timestamp: Date.now(), subject: parseSubject(subject),
      family: 'admin', subtype: 'ruleChanged', handles: {},
      payload: { scope: 'automations', source: 'panel' },
      value: null,
    });
  }

  private requireAsset(): void {
    if (!this.gitAsset) throw new Error('GitAsset 未装配（面板资产编辑不可用）');
  }

  // ---- admin:manageAgent：手动托管动作（设计 5.3，D2 分离语义） ----
  // stop = manualStop（exit 不自动重启）；start = 立即拉起；restart = stop+start。
  // spawnCommandTemplate 缺省时 Supervisor 动作为 no-op（F.4 既有语义）。

  manageAgent(subject: string, agentId: string, action: 'start' | 'stop' | 'restart'): { agentId: string; action: string } {
    this.require(subject, 'admin:manageAgent', `agent:${agentId}`);
    if (!this.supervisor) throw new Error('Supervisor 未装配（模板缺省不托管）');
    const exists = this.projStore.get('SELECT agentId FROM agent_registry WHERE agentId = ?', agentId);
    if (!exists) throw new Error(`agent 不存在: ${agentId}`);
    if (action === 'start') this.supervisor.startAgent(agentId);
    else if (action === 'stop') this.supervisor.stopAgent(agentId);
    else this.supervisor.restartAgent(agentId);
    return { agentId, action };
  }
}
