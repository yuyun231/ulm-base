import type { EventBus } from '../core/event-bus/bus.js';
import type { ProjectionsStore } from '../core/projector/projections-store.js';
import type { PermissionRule } from '../core/permission/rule-loader.js';
import type { EventStore } from '../core/event-bus/store.js';
import type { GitAsset } from '../core/git-asset.js';
import type { SupervisorService } from '../core/supervisor/supervisor.js';
import { TaskCommands } from '../services/task/commands.js';
import { TaskQueries } from '../services/task/queries.js';
import { AdminCommands } from '../services/admin/params.js';
import { PurposeCommands } from '../services/admin/purpose.js';
import { PermissionCommands } from '../services/admin/permissions.js';
import { AgentRegistryCommands } from '../services/admin/agent-registry.js';
import { PiercingCommands } from '../services/admin/piercing.js';
import * as yaml from 'yaml';

// 设计锚点 1.4/6.7：人侧唯一入口。面板API 不直接操作数据，只路由到服务层命令面。
// 首版：导出 PanelApi class，方法 = 路由到各服务命令。生产环境由 main 装配接 ws/http server。
// Phase F.5（决策点 3甲）：agent 注册命令组挂载 + 权限命令面复用 PermissionCommands + 查询面（6.1）。
// Phase 0 修复②：穿透指令面板路由（PiercingCommands 经 ControlChannel 真实下发）。

export interface PanelApiOptions {
  gitAsset?: GitAsset | null;
  supervisor?: SupervisorService | null;
  // 连接状态解析（6.1 agents/:id 详情）：缺省 connected 恒 false
  resolveConn?: ((agentId: string) => string | null) | null;
  // Phase 0 修复②：穿透指令命令组（System 装配注入；缺省时穿透方法抛错）
  piercingCommands?: PiercingCommands | null;
  // P.5 任务详情扩充：反馈区=事件视图，需事件库查询（缺省 feedbackZone 恒空）
  eventStore?: EventStore | null;
}

export class PanelApi {
  private taskCommands: TaskCommands;
  private taskQueries: TaskQueries;
  private adminCommands: AdminCommands;
  private purposeCommands: PurposeCommands;
  private permissionCommands: PermissionCommands;
  private agentRegistryCommands: AgentRegistryCommands;
  private piercingCommands: PiercingCommands | null;
  private projStore: ProjectionsStore;
  private resolveConn: ((agentId: string) => string | null) | null;

  constructor(bus: EventBus, projStore: ProjectionsStore, rules: PermissionRule[], opts: PanelApiOptions = {}) {
    this.projStore = projStore;
    this.taskCommands = new TaskCommands(bus, rules);
    this.taskQueries = new TaskQueries(projStore, opts.eventStore ?? null);
    this.adminCommands = new AdminCommands(bus, rules);
    this.purposeCommands = new PurposeCommands(bus, rules);
    this.permissionCommands = new PermissionCommands(bus, rules);
    this.agentRegistryCommands = new AgentRegistryCommands({
      bus, rules, projStore, gitAsset: opts.gitAsset ?? null, supervisor: opts.supervisor ?? null,
    });
    this.piercingCommands = opts.piercingCommands ?? null;
    this.resolveConn = opts.resolveConn ?? null;
  }

  // 路由到 TaskCommands
  createTask(userId: string, input: Parameters<TaskCommands['createTask']>[0]) {
    return this.taskCommands.createTask({ ...input, createdBy: `human:${userId}` });
  }

  // Phase 0 修复⑨：人工判定入口（4.3 判定者=人；与 agent 判定回执走同一 TaskCommands）
  approveTask(userId: string, taskId: string, nodeId: string, judgeNote: string) {
    return this.taskCommands.approve(`human:${userId}`, taskId, nodeId, judgeNote, 'pass');
  }

  rejectTask(userId: string, taskId: string, nodeId: string, rejectReason: string) {
    return this.taskCommands.reject(`human:${userId}`, taskId, nodeId, rejectReason);
  }

  // 人发起指导（7.10）：type=now 由调度器立即经接缝注入（correct 指令），
  // type=future 存任务指导区随 wake 载荷下发；回执/闭环见 guidances 投影
  issueTaskGuidance(userId: string, taskId: string, content: string, type: 'now' | 'future', guidanceId = `g-${Date.now()}`) {
    return this.taskCommands.issueGuidance(`human:${userId}`, taskId, guidanceId, content, type);
  }

  // 路由到 TaskQueries
  queryTask(taskId: string) {
    return this.taskQueries.taskDetail(taskId);
  }

  // ---- P.5 任务详情扩充查询面：树依赖 / DAG 节点 / 指导区 / 反馈区 ----

  // 聚合任务树：parentTaskId 递归子树（含自身）
  queryTaskTree(taskId: string) {
    return this.taskQueries.taskTree(taskId);
  }

  // 任务 DAG：节点（含 nodeState）+ 依赖边，当前最高 dagVersion
  queryTaskDag(taskId: string) {
    return this.taskQueries.taskDag(taskId);
  }

  // 指导区：guidances 投影全生命周期（issued→injected→acked→closed）
  queryTaskGuidance(taskId: string) {
    return this.taskQueries.guidanceZone(taskId);
  }

  // 反馈区（7.2 事件视图）：上报问题/判定意见/指导回执/指令回执 + 价值裁决
  queryTaskFeedback(taskId: string) {
    return this.taskQueries.feedbackZone(taskId);
  }

  // 路由到 AdminCommands
  setParam(userId: string, key: string, value: any) {
    return this.adminCommands.setParam(`human:${userId}`, key, value);
  }

  // 路由到 PurposeCommands（F10 目的命令面，仅对人开放）
  createPurpose(userId: string, purposeId: string, dialogueId: string, description: string) {
    return this.purposeCommands.createPurpose(`human:${userId}`, purposeId, dialogueId, description);
  }

  confirmPurpose(userId: string, purposeId: string, confirmedState: string) {
    return this.purposeCommands.confirmPurpose(`human:${userId}`, purposeId, confirmedState);
  }

  launchPurpose(userId: string, purposeId: string, taskId: string) {
    return this.purposeCommands.launchPurpose(`human:${userId}`, purposeId, taskId);
  }

  // ---- Phase F.5：权限命令面（决策点 3甲：复用 PermissionCommands，转发不重复实现） ----

  setPermissionRule(userId: string, rule: PermissionRule & { ruleId?: string }) {
    return this.permissionCommands.setPermissionRule(`human:${userId}`, rule);
  }

  removePermissionRule(userId: string, ruleId: string) {
    return this.permissionCommands.removePermissionRule(`human:${userId}`, ruleId);
  }

  // ---- Phase F.5：agent 注册/资产/托管命令面（决策点 3A 三动作） ----

  registerAgent(userId: string, input: Parameters<AgentRegistryCommands['registerAgent']>[1]) {
    return this.agentRegistryCommands.registerAgent(`human:${userId}`, input);
  }

  removeAgent(userId: string, agentId: string) {
    return this.agentRegistryCommands.removeAgent(`human:${userId}`, agentId);
  }

  writeWorkflow(userId: string, agentId: string, content: string) {
    return this.agentRegistryCommands.writeWorkflow(`human:${userId}`, agentId, content);
  }

  writeProcedure(userId: string, name: string, content: string) {
    return this.agentRegistryCommands.writeProcedure(`human:${userId}`, name, content);
  }

  writeAutomations(userId: string, content: string) {
    return this.agentRegistryCommands.writeAutomations(`human:${userId}`, content);
  }

  manageAgent(userId: string, agentId: string, action: 'start' | 'stop' | 'restart') {
    return this.agentRegistryCommands.manageAgent(`human:${userId}`, agentId, action);
  }

  // ---- Phase 0 修复②：穿透指令面板路由（七条） ----
  // interrupt/reorder/redo/correct + modelConfig/whitelist/agentDef；
  // wake/sleep/judgeResult/inject 为内部链路指令，不进面板

  controlAgent(userId: string, agentId: string, action: 'interrupt' | 'reorder' | 'redo' | 'correct', payload?: any) {
    this.requirePiercing();
    return this.piercingCommands!.control(`human:${userId}`, agentId, action, payload);
  }

  pushModelConfig(userId: string, agentId: string, config: any) {
    this.requirePiercing();
    return this.piercingCommands!.pushModelConfig(`human:${userId}`, agentId, config);
  }

  pushWhitelist(userId: string, agentId: string, whitelist: string[]) {
    this.requirePiercing();
    return this.piercingCommands!.pushWhitelist(`human:${userId}`, agentId, whitelist);
  }

  pushAgentDef(userId: string, agentId: string, def: any) {
    this.requirePiercing();
    return this.piercingCommands!.pushAgentDef(`human:${userId}`, agentId, def);
  }

  private requirePiercing(): void {
    if (!this.piercingCommands) {
      throw new Error('PiercingCommands 未装配：面板需注入穿透指令通道（PanelApiOptions.piercingCommands）');
    }
  }

  // ---- Phase F.5：查询面（6.1） ----

  // agent_registry × agents 运行态一视图 + 连接状态（经 resolveConn 注入）
  queryAgents(): any[] {
    const rows = this.projStore.all(`
      SELECT r.agentId, r.role, r.description, r.capabilities, r.spawnPolicy, r.configSource, r.enabled,
             r.createdAt, r.updatedAt,
             a.wakeState, a.workState, a.focusBinding, a.lastActivityAt, a.lost
      FROM agent_registry r
      LEFT JOIN agents a ON a.agentId = r.agentId
      ORDER BY r.agentId ASC
    `) as any[];
    return rows.map(r => this.withConn(r));
  }

  // 详情（含当前连接状态——经 resolveConn resolve）
  queryAgentsDetail(agentId: string): any {
    const r = this.projStore.get(`
      SELECT r.agentId, r.role, r.description, r.capabilities, r.spawnPolicy, r.configSource, r.enabled,
             r.createdAt, r.updatedAt,
             a.wakeState, a.workState, a.focusBinding, a.lastActivityAt, a.lost
      FROM agent_registry r
      LEFT JOIN agents a ON a.agentId = r.agentId
      WHERE r.agentId = ?
    `, agentId) as any;
    return r ? this.withConn(r) : null;
  }

  queryAutomations(): any {
    return this.readYamlDoc('automations.yaml');
  }

  // 资产原文读取（驾驶舱首版 P 阶段）：编辑器需要原文而非解析对象，避免丢失注释与格式
  queryAutomationsRaw(): string | null {
    return this.readAssetFile('automations.yaml');
  }

  queryProcedureRaw(name: string): string | null {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) return null;
    return this.readAssetFile(`procedures/${name}.yaml`);
  }

  // ---- 驾驶舱首版（P 阶段）查询面扩展：任务/目的/权限规则投影视图 ----

  queryTasks(): any[] {
    return this.projStore.all(`
      SELECT taskId, taskType, goal, acceptanceCriteria, dagVersion, workspaceId, state,
             createdBy, assignedAgent, priority, parentTaskId, dialogueId, createdAt
      FROM tasks
      ORDER BY createdAt DESC, taskId ASC
    `) as any[];
  }

  queryPurposes(): any[] {
    return this.projStore.all(`
      SELECT purposeId, taskId, dialogueId, description, state, createdAt, updatedAt
      FROM purposes
      ORDER BY createdAt DESC, purposeId ASC
    `) as any[];
  }

  queryPermissionRules(): any[] {
    return this.projStore.all(`
      SELECT ruleId, subject, action, effect, updatedAt
      FROM permission_rules
      ORDER BY subject ASC, action ASC, ruleId ASC
    `) as any[];
  }

  queryWorkflow(agentId: string): string | null {
    return this.readAssetFile(`workflows/${agentId}.md`);
  }

  queryProcedures(): Array<{ name: string; file: string; template: any }> {
    const gitAsset = this.agentRegistryCommands.asset;
    if (!gitAsset) return [];
    return gitAsset.listDir('procedures')
      .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
      .map(f => ({
        name: f.replace(/\.(ya?ml|md)$/, ''),
        file: `procedures/${f}`,
        template: this.readYamlDoc(`procedures/${f}`),
      }));
  }

  private withConn(r: any): any {
    const connId = this.resolveConn ? this.resolveConn(r.agentId) : null;
    return { ...r, connected: connId != null, connId: connId ?? null };
  }

  private readYamlDoc(relPath: string): any {
    const gitAsset = this.agentRegistryCommands.asset;
    if (!gitAsset || !gitAsset.fileExists(relPath)) return null;
    try { return yaml.parse(gitAsset.readFile(relPath)); } catch { return null; }
  }

  private readAssetFile(relPath: string): string | null {
    const gitAsset = this.agentRegistryCommands.asset;
    if (!gitAsset || !gitAsset.fileExists(relPath)) return null;
    return gitAsset.readFile(relPath);
  }
}
