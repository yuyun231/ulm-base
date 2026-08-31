import type { EventBus } from '../event-bus/bus.js';
import type { AutomationRule } from '../../config/loader.js';
import { TaskCommands } from '../../services/task/commands.js';
import type { ControlChannel } from '../../seam/control-channel.js';

// 设计锚点 4.C：自动化规则引擎（D6/D10）
// 事件规则：订阅总线匹配 trigger+filter → 命令面执行动作
// 定时规则：自管 setInterval，到期产 schedule.timerFired(reason=automationSchedule) 入事件流（审计+可重放），再消费执行
// 防环三件套：①再生深度（规则级 trackDepth 开关默认关；开则 payload 自带 depth+1）②subjectAllowlist 来源限定（支持 :* 通配）③冷却期
// 审批分层：approval=auto 直接创建；require（缺省）产的任务首个节点审批卡 require-approval（新常再生任务=配置留口子）
// 动作一律走命令面（TaskCommands / ControlChannel），不绕过权限与审计

const DEFAULT_SUBJECT_ALLOWLIST = ['module:automation', 'module:timer', 'module:scheduler'];

export interface AutomationRulesOptions {
  bus: EventBus;
  taskCommands: TaskCommands;
  controlChannel: ControlChannel;
  loadRules: () => AutomationRule[];   // 注入读取（启动初始化与 ruleChanged 热加载复用）
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => any;
  clearIntervalFn?: (timer: any) => void;
}

interface ScheduleEntry { rule: AutomationRule; timer: any }

export class AutomationRules {
  private bus: EventBus;
  private taskCommands: TaskCommands;
  private controlChannel: ControlChannel;
  private loadRules: () => AutomationRule[];
  private now: () => number;
  private setIntervalFn: (fn: () => void, ms: number) => any;
  private clearIntervalFn: (timer: any) => void;

  private eventRules: AutomationRule[] = [];
  private scheduleEntries: ScheduleEntry[] = [];
  private lastFire = new Map<string, number>();  // ruleId → 上次执行时刻（冷却基准）
  private counter = 0;                           // taskId 唯一序号
  private unsubs: Array<() => void> = [];

  constructor(opts: AutomationRulesOptions) {
    this.bus = opts.bus;
    this.taskCommands = opts.taskCommands;
    this.controlChannel = opts.controlChannel;
    this.loadRules = opts.loadRules;
    this.now = opts.now ?? Date.now;
    this.setIntervalFn = opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn = opts.clearIntervalFn ?? ((t) => clearInterval(t));
  }

  start(): void {
    this.reloadRules();  // 启动初始化（解析错误→automationSkipped(parse-error)，空表运行不崩基座）
    this.unsubs.push(this.bus.subscribe(env => this.onEvent(env)));
    this.unsubs.push(this.bus.subscribe(() => this.reloadRules(), { family: 'admin', subtype: 'ruleChanged' }));
  }

  stop(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.clearTimers();
  }

  // 4.4 热加载：重读文件重建规则表（含定时器重建）；解析错误保持旧表
  private reloadRules(): void {
    let rules: AutomationRule[];
    try {
      rules = this.loadRules();
    } catch (e: any) {
      this.skip('engine', 'parse-error', { detail: String(e?.message ?? e) });
      return;
    }
    this.eventRules = rules.filter(r => r.trigger.type === 'event');
    this.clearTimers();
    for (const rule of rules) {
      if (rule.trigger.type !== 'schedule' || !rule.enabled) continue;
      const sec = rule.trigger.intervalSec ?? 0;
      if (sec <= 0) continue;
      const timer = this.setIntervalFn(() => this.fireSchedule(rule), sec * 1000);
      this.scheduleEntries.push({ rule, timer });
    }
  }

  // D10：到期产 timerFired 入事件流（审计+可重放），由 onEvent 消费执行动作
  private fireSchedule(rule: AutomationRule): void {
    this.bus.publish({
      seq: null, timestamp: this.now(),
      subject: { kind: 'module', module: 'automation' },
      family: 'schedule', subtype: 'timerFired', handles: {},
      payload: { ruleId: rule.ruleId, reason: 'automationSchedule' },
      value: null,
    });
  }

  private onEvent(env: any): void {
    // 定时触发消费：reason=automationSchedule 的 timerFired → 对应 schedule 规则
    if (env.family === 'schedule' && env.subtype === 'timerFired' && env.payload?.reason === 'automationSchedule') {
      const rule = this.scheduleEntries.find(e => e.rule.ruleId === env.payload.ruleId)?.rule;
      if (rule) this.execute(rule, env);
      return;
    }
    for (const rule of this.eventRules) {
      if (!rule.enabled) continue;
      if (rule.trigger.family && env.family !== rule.trigger.family) continue;
      if (rule.trigger.subtype && env.subtype !== rule.trigger.subtype) continue;
      if (rule.filter && !this.matchFilter(env, rule.filter)) continue;
      this.execute(rule, env);
    }
  }

  private matchFilter(env: any, filter: Record<string, string | number | boolean>): boolean {
    for (const [path, expected] of Object.entries(filter)) {
      if (this.dotGet(env, path) !== expected) return false;
    }
    return true;
  }

  // 点路径取值：仅支持 payload.* 与 handles.* 前缀（设计 4.1 示例口径）
  private dotGet(env: any, path: string): any {
    const [root, ...rest] = path.split('.');
    let cur: any = root === 'payload' ? env.payload : root === 'handles' ? env.handles : undefined;
    for (const k of rest) {
      if (cur == null) return undefined;
      cur = cur[k];
    }
    return cur;
  }

  private execute(rule: AutomationRule, env: any): void {
    // 防环 2：来源限定（缺省排除再生产物以外的未知来源；条目支持 ':*' 前缀通配，如 'human:*'）
    const subject = subjectToString(env.subject);
    const allow = rule.subjectAllowlist ?? DEFAULT_SUBJECT_ALLOWLIST;
    if (!allow.some(pattern => pattern.endsWith(':*') ? subject.startsWith(pattern.slice(0, -1)) : pattern === subject)) {
      this.skip(rule.ruleId, 'subject-not-allowed', { subject });
      return;
    }
    // 防环 3：冷却期（滑动窗口：距上次执行不足 cooldownSec → 跳过）
    const now = this.now();
    const cooldownMs = (rule.guard?.cooldownSec ?? 0) * 1000;
    const last = this.lastFire.get(rule.ruleId) ?? 0;
    if (cooldownMs > 0 && now - last < cooldownMs) {
      this.skip(rule.ruleId, 'cooldown', { sinceLastMs: now - last });
      return;
    }
    // 防环 1：再生深度（仅 trackDepth=true 的 createTask 规则计；方案 A：只认触发事件 payload 自带 depth）
    let depth = 0;
    if (rule.action.type === 'createTask' && rule.trackDepth) {
      const p = (env.payload as any)?.regenerationDepth;
      depth = typeof p === 'number' ? p + 1 : 1;
      const maxDepth = rule.guard?.maxDepth;
      if (maxDepth != null && depth > maxDepth) {
        this.skip(rule.ruleId, 'max-depth', { depth, maxDepth });
        return;
      }
    }
    this.lastFire.set(rule.ruleId, now);
    try {
      if (rule.action.type === 'createTask') this.actCreateTask(rule, env, depth);
      else this.actWake(rule);
    } catch (e: any) {
      this.skip(rule.ruleId, 'action-error', { detail: String(e?.message ?? e) });
    }
  }

  // 方案 A：深度只来自触发事件 payload.regenerationDepth（+1）；事件不带 → 1。trackDepth=false 时根本不算（depth=0，不透传）

  private actCreateTask(rule: AutomationRule, env: any, depth: number): void {
    const a = rule.action;
    const vars: Record<string, any> = { ...(env.payload ?? {}), ...(env.handles ?? {}) };
    const taskId = `auto-${rule.ruleId}-${this.now().toString(36)}-${this.counter++}`;
    this.taskCommands.createTask({
      taskId,
      taskType: a.taskType ?? 'normal',
      goal: interpolate(a.goal ?? '', vars),
      acceptanceCriteria: a.acceptanceCriteria ?? '',
      workspaceId: a.workspaceId ?? 'ws-automation',
      priority: a.priority ?? 5,
      createdBy: 'module:automation',
      // 再生追踪（决策点 1）：默认不追踪；trackDepth=true 才携带深度与来源
      ...(rule.trackDepth ? { originTaskId: vars.taskId != null ? String(vars.taskId) : undefined, regenerationDepth: depth } : {}),
      // 审批分层（决策点 2）：require（缺省）→ 首节点审批卡 require-approval；auto → 直走门禁放行
      requireApproval: (rule.approval ?? 'require') === 'require',
    });
  }

  private actWake(rule: AutomationRule): void {
    const agentId = rule.action.agentId;
    if (!agentId) throw new Error('wake 动作缺 agentId');
    // fire-and-forget：内部落 piercingIssued 审计；未连接合成失败回执（既有 ControlChannel 语义）
    this.controlChannel.sendCommand('module:automation', agentId, 'wake', { ruleId: rule.ruleId, reason: 'automationSchedule' });
  }

  // 跳过落 admin.automationSkipped（ruleId/原因），永不抛出
  private skip(ruleId: string, reason: string, extra: Record<string, any> = {}): void {
    this.bus.publish({
      seq: null, timestamp: this.now(),
      subject: { kind: 'module', module: 'automation' },
      family: 'admin', subtype: 'automationSkipped', handles: {},
      payload: { ruleId, reason, ...extra },
      value: null,
    });
  }

  private clearTimers(): void {
    for (const e of this.scheduleEntries) this.clearIntervalFn(e.timer);
    this.scheduleEntries = [];
  }
}

// 主题字符串化：module:automation / human:u1 / agent:res-01
function subjectToString(s: any): string {
  const id = s?.module ?? s?.userId ?? s?.agentId ?? '';
  return `${s?.kind ?? 'module'}:${id}`;
}

// {key} 变量插值：命中替换，未命中保留原样
function interpolate(tpl: string, vars: Record<string, any>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
}
