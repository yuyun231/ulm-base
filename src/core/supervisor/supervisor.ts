import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { EventBus } from '../event-bus/bus.js';
import type { ProjectionsStore } from '../projector/projections-store.js';

// 设计锚点 5.D：基座内嵌 SupervisorService（D4/D9）
// spawn 档：拉起子进程并守护（指数退避重启）；external 档：只等连接，不做进程管理
// 网络级失联（心跳 lost=1）不触发重启——进程活着只是网络断，重启无意义（本组件不订阅心跳）

export interface SupervisorParams {
  spawnCommandTemplate?: string;  // 例 'node openclaw/main.js --agent {agentId}'；支持 {agentId}/{wsUrl} 占位
  baseMs?: number;                // 退避基数（默认 1000）
  factor?: number;                // 退避指数（默认 2）
  maxMs?: number;                 // 退避上限（默认 60000）
  maxRetries?: number;            // 最大重试次数（默认 5，超限 giveUp）
}

export interface SupervisorDeps {
  bus: EventBus;
  projStore: ProjectionsStore;
  params: SupervisorParams;
  wsUrl: string;
  spawnFn?: (command: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;  // 测试注入
  setTimeoutFn?: (fn: () => void, ms: number) => any;
  clearTimeoutFn?: (timer: any) => void;
  now?: () => number;
}

interface Tracked { agentId: string; child: ChildProcess; manualStop: boolean }

export class SupervisorService {
  private bus: EventBus;
  private projStore: ProjectionsStore;
  private params: { spawnCommandTemplate?: string; baseMs: number; factor: number; maxMs: number; maxRetries: number };
  private wsUrl: string;
  private spawnFn: (command: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
  private setTimeoutFn: (fn: () => void, ms: number) => any;
  private clearTimeoutFn: (timer: any) => void;
  private now: () => number;
  private tracked = new Map<string, Tracked>();
  private retries = new Map<string, number>();     // agentId → 已重试次数（跨 exit 累计）
  private restartTimers = new Map<string, any>();

  constructor(deps: SupervisorDeps) {
    this.bus = deps.bus;
    this.projStore = deps.projStore;
    this.wsUrl = deps.wsUrl;
    this.params = {
      spawnCommandTemplate: deps.params.spawnCommandTemplate,
      baseMs: deps.params.baseMs ?? 1000,
      factor: deps.params.factor ?? 2,
      maxMs: deps.params.maxMs ?? 60000,
      maxRetries: deps.params.maxRetries ?? 5,
    };
    this.spawnFn = deps.spawnFn ?? ((command, args, env) => nodeSpawn(command, args, { env, stdio: 'ignore' }));
    this.setTimeoutFn = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = deps.clearTimeoutFn ?? ((t) => clearTimeout(t));
    this.now = deps.now ?? Date.now;
  }

  // 启动：agent_registry 中 spawn 档且 enabled=1 逐个拉起；模板缺失 → 不托管（本机手跑），不报错
  start(): void {
    if (!this.params.spawnCommandTemplate) {
      console.warn('[supervisor] spawnCommandTemplate 未配置 → spawn 档进程不托管');
      return;
    }
    const rows = this.projStore.all(
      "SELECT agentId FROM agent_registry WHERE spawnPolicy = 'spawn' AND enabled = 1"
    ) as Array<{ agentId: string }>;
    for (const r of rows) this.startAgent(r.agentId);
  }

  // 手动/自动统一拉起入口：已在管 → 跳过；每次落 admin.agentSpawned
  startAgent(agentId: string): void {
    if (!this.params.spawnCommandTemplate || this.tracked.has(agentId)) return;
    const { command, args } = parseTemplate(this.params.spawnCommandTemplate, agentId, this.wsUrl);
    const child = this.spawnFn(command, args, { ...process.env, ULM_WS_URL: this.wsUrl, ULM_AGENT_ID: agentId });
    const t: Tracked = { agentId, child, manualStop: false };
    this.tracked.set(agentId, t);
    this.publish('agentSpawned', { agentId, pid: child.pid ?? null });
    child.on('exit', (code, signal) => this.onExit(t, code, signal));
  }

  // 5.3 stop = 清重启定时器 + kill + manualStop（exit 处理器见 manualStop 不自动重启），重试计数清零
  stopAgent(agentId: string): void {
    const t = this.tracked.get(agentId);
    const timer = this.restartTimers.get(agentId);
    if (timer != null) { this.clearTimeoutFn(timer); this.restartTimers.delete(agentId); }
    if (!t) return;
    t.manualStop = true;
    this.retries.delete(agentId);
    t.child.kill();
  }

  // 5.3 restart = stop + start（manualStop 被 exit 吞掉，干净重启；重试计数清零）
  restartAgent(agentId: string): void {
    this.stopAgent(agentId);
    this.startAgent(agentId);
  }

  // System.stop() 用：全量停止（清定时器 + kill 全部子进程）
  stopAll(): void {
    for (const [agentId] of this.tracked) this.stopAgent(agentId);
    for (const [agentId, timer] of this.restartTimers) { this.clearTimeoutFn(timer); this.restartTimers.delete(agentId); }
  }

  // 5.2 exit → agentExited → 非 manualStop 才指数退避重启
  private onExit(t: Tracked, code: number | null, signal: string | null): void {
    this.tracked.delete(t.agentId);
    this.publish('agentExited', { agentId: t.agentId, code, signal });
    if (t.manualStop) return;
    const count = (this.retries.get(t.agentId) ?? 0) + 1;
    if (count > this.params.maxRetries) {
      this.retries.delete(t.agentId);
      this.publish('agentRestartScheduled', { agentId: t.agentId, giveUp: true, retry: count - 1 });
      return;
    }
    this.retries.set(t.agentId, count);
    const delay = Math.min(this.params.baseMs * Math.pow(this.params.factor, count - 1), this.params.maxMs);
    this.publish('agentRestartScheduled', { agentId: t.agentId, at: this.now() + delay, retry: count, giveUp: false });
    const timer = this.setTimeoutFn(() => {
      this.restartTimers.delete(t.agentId);
      this.startAgent(t.agentId);
    }, delay);
    this.restartTimers.set(t.agentId, timer);
  }

  private publish(subtype: string, payload: Record<string, any>): void {
    this.bus.publish({
      seq: null, timestamp: this.now(),
      subject: { kind: 'module', module: 'supervisor' },
      family: 'admin', subtype, handles: {},
      payload, value: null,
    });
  }
}

// 模板解析：替换 {agentId}/{wsUrl} 后按空白切分（首 token=command，余为 args）
export function parseTemplate(tpl: string, agentId: string, wsUrl: string): { command: string; args: string[] } {
  const filled = tpl.replaceAll('{agentId}', agentId).replaceAll('{wsUrl}', wsUrl);
  const parts = filled.trim().split(/\s+/);
  return { command: parts[0]!, args: parts.slice(1) };
}
