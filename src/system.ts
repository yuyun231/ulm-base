import { EventStore } from './core/event-bus/store.js';
import { EventBus } from './core/event-bus/bus.js';
import { ProjectionsStore } from './core/projector/projections-store.js';
import { ProjectionRunner } from './core/projector/runner.js';
import { ConfigLoader } from './config/loader.js';
import { SeamGateway } from './seam/gateway.js';
import { PanelApi } from './panel-api/http.js';
import { FeedbackFeed } from './panel-api/feed.js';
import { describeSystem, type SystemSnapshot } from './self-describe/describe.js';
import { createInMemoryPair } from './seam/in-memory-transport.js';
import { WsTransportServer } from './seam/ws-transport.js';
import type { TransportLayer } from './seam/transport.js';
import type { PermissionRule } from './core/permission/rule-loader.js';
import { TasksProjection } from './core/projector/projections/tasks.js';
import { TaskNodesProjection } from './core/projector/projections/task-nodes.js';
import { AgentsProjection } from './core/projector/projections/agents.js';
import { WorkspacesProjection } from './core/projector/projections/workspaces.js';
import { LoadQueueProjection } from './core/projector/projections/load-queue.js';
import { DialoguesProjection } from './core/projector/projections/dialogues.js';
import { GuidancesProjection } from './core/projector/projections/guidances.js';
import { ConsultsProjection } from './core/projector/projections/consults.js';
import { PurposesProjection } from './core/projector/projections/purposes.js';
import { ReplayByPurposeProjection } from './core/projector/projections/replay-by-purpose.js';
import { ValueCompareProjection } from './core/projector/projections/value-compare.js';
import { RegistryProjection } from './core/projector/projections/registry.js';
import { PermissionRulesProjection } from './core/projector/projections/permission-rules.js';
import { AgentRegistryProjection } from './core/projector/projections/agent-registry.js';
import { importFactoryAgents } from './bootstrap/factory-import.js';
import { TimerService } from './core/scheduler/timer.js';
import { SchedulerRules } from './core/scheduler/rules.js';
import { ConcurrencyGate } from './core/scheduler/concurrency-gate.js';
import { LoadQueue } from './core/scheduler/load-queue.js';
import { AutomationRules } from './core/scheduler/automation-rules.js';
import { TaskCommands } from './services/task/commands.js';
import { PiercingCommands } from './services/admin/piercing.js';
import { SupervisorService } from './core/supervisor/supervisor.js';
import { GitAsset } from './core/git-asset.js';
import { wirePermissionSync } from './config/permission-sync.js';

// 9.6 system.ts 封装装配逻辑
// main.ts 调用 createSystem() + start() + stop()

export interface SystemOptions {
  configDir: string;
  mode: 'test' | 'production';
  wsPort?: number;
  dbDir?: string;  // sqlite 文件目录；test 模式默认 :memory:
  supervisorSpawnFn?: (command: string, args: string[], env: NodeJS.ProcessEnv) => import('node:child_process').ChildProcess;  // F.4：测试注入口
}

export class System {
  eventStore: EventStore;
  bus: EventBus;
  projStore: ProjectionsStore;
  projector: ProjectionRunner;
  gateway: SeamGateway;
  panelApi: PanelApi;
  feed: FeedbackFeed;
  configLoader: ConfigLoader;
  timer: TimerService;
  schedulerRules: SchedulerRules;
  automationRules: AutomationRules;
  supervisor: SupervisorService;
  gitAsset: GitAsset;   // F.5：提升为字段（面板资产编辑与权限基线落盘共用）
  private unwirePermissionSync: () => void = () => {};
  private transport: TransportLayer;
  private rules: PermissionRule[];
  private started = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SystemOptions) {
    const dbPath = opts.mode === 'test' || !opts.dbDir ? ':memory:' : `${opts.dbDir}/events.sqlite`;
    const projDbPath = opts.mode === 'test' || !opts.dbDir ? ':memory:' : `${opts.dbDir}/projections.sqlite`;

    this.eventStore = new EventStore(dbPath);
    this.bus = new EventBus(this.eventStore);
    this.projStore = new ProjectionsStore(projDbPath);

    // 装配全部 13 个投影类
    const projections = [
      new TasksProjection(),
      new TaskNodesProjection(),
      new AgentsProjection(),
      new WorkspacesProjection(),
      new LoadQueueProjection(),
      new DialoguesProjection(),
      new GuidancesProjection(),
      new ConsultsProjection(),
      new PurposesProjection(),
      new ReplayByPurposeProjection(),
      new ValueCompareProjection(),
      new RegistryProjection(),
      new PermissionRulesProjection(),
      new AgentRegistryProjection(),
    ];
    this.projector = new ProjectionRunner(this.bus, this.eventStore, this.projStore, projections);

    this.configLoader = new ConfigLoader(opts.configDir);
    this.rules = this.configLoader.loadPermissionRules();
    const params = this.configLoader.loadParams();

    if (opts.mode === 'test') {
      const { server } = createInMemoryPair();
      this.transport = server;
    } else {
      this.transport = new WsTransportServer(opts.wsPort ?? 8080);
    }

    this.gateway = new SeamGateway(this.bus, this.projStore, this.rules, this.transport, {
      intervalSec: params.heartbeat.intervalSec,
      timeoutSec: params.heartbeat.timeoutSec,
    });

    this.feed = new FeedbackFeed(this.bus, { keyNodeEvents: params.feedback.keyNodeEvents });
    this.timer = new TimerService(this.bus, {
      sleepCountdownSec: params.agent.sleepCountdownSec,
      heartbeatIntervalSec: params.heartbeat.intervalSec,
      heartbeatTimeoutSec: params.heartbeat.timeoutSec,
    });

    // F1：装配调度器规则机，传入接缝控制通道（征求决策投递/回传链路）
    // F2：压缩触发阈值与注入字节上限来自 params.yaml
    // F3：git 资产（共享记忆与存档的 git 轨），repoRoot = 配置目录（assets/）
    // F.5：提升为字段——面板资产编辑（AgentRegistryCommands）与权限基线落盘共用
    const gitAsset = new GitAsset(opts.configDir);
    gitAsset.initRepo();
    this.gitAsset = gitAsset;
    // Phase F.5（决策点 2）：权限热改生效——订阅 permissionChanged/Removed 热改共享门禁数组 + 落盘基线
    this.unwirePermissionSync = wirePermissionSync(this.bus, this.rules, this.gitAsset);
    // Phase 0 修复③⑨：调度器经命令面派发/判定——与自动化引擎共享同一 TaskCommands 实例
    const taskCommands = new TaskCommands(this.bus, this.rules);
    this.schedulerRules = new SchedulerRules(
      this.bus,
      this.projStore,
      new ConcurrencyGate(params.scheduler.maxWorkingAgents),
      new LoadQueue(),
      this.timer,
      this.gateway.getControlChannel(),
      taskCommands,
      {
        gitAsset,
        compressThreshold: params.dialogue.compressThreshold,
        injectInlineMaxBytes: params.memory.injectInlineMaxBytes,
        // 软编码覆盖项：默认行为与补完计划一致，需要时可从 params 扩展
      },
    );

    // Phase F.3：自动化规则引擎（动作走命令面，不绕过权限与审计）
    this.automationRules = new AutomationRules({
      bus: this.bus,
      taskCommands,
      controlChannel: this.gateway.getControlChannel(),
      loadRules: () => this.configLoader.loadAutomations(),
    });

    // Phase F.4：SupervisorService（spawn 档进程守护；模板缺省→不托管）
    this.supervisor = new SupervisorService({
      bus: this.bus, projStore: this.projStore,
      params: params.supervisor ?? {},
      wsUrl: `ws://localhost:${opts.wsPort ?? 8080}`,
      spawnFn: opts.supervisorSpawnFn,
    });

    // Phase F.5：面板命令面（git 资产编辑 + Supervisor 托管 + 连接状态解析）——
    // 依赖 gitAsset/supervisor/gateway，故在三者装配后构造（原构造位提前于 gitAsset，迁移至此）
    // Phase 0 修复②：穿透指令命令组经 ControlChannel 真实下发（面板 interrupt/correct/下发配置等）
    this.panelApi = new PanelApi(this.bus, this.projStore, this.rules, {
      gitAsset: this.gitAsset,
      supervisor: this.supervisor,
      resolveConn: (agentId) => this.gateway.getConnectionRegistry().resolve(agentId),
      piercingCommands: new PiercingCommands({
        rules: this.rules,
        controlChannel: this.gateway.getControlChannel(),
      }),
      eventStore: this.eventStore, // P.5：任务反馈区=事件视图（7.2）
    });
  }

  start(): void {
    if (this.started) return;
    // 投影器订阅事件总线（内部自动初始化 schema + 订阅）
    this.projector.start();
    // Phase F.2：出厂配置导入（权限规则；agent 导入见 F.2-C）——publish 同步消费，导入完成投影即就位
    this.importFactoryPermissions();
    // Phase F.2 D8：出厂 agent 导入（补缺不覆盖）
    importFactoryAgents(this.bus, this.projStore, this.configLoader.loadFactoryAgents());
    // Phase F.3：自动化规则引擎（projector 之后订阅；含启动初始化与 ruleChanged 热加载）
    this.automationRules.start();
    // Phase F.4：出厂 agent spawn 档拉起（模板缺省→不托管）
    this.supervisor.start();
    // 启动接缝网关
    this.gateway.start();
    // F1：启动调度器规则机
    this.schedulerRules.start();
    // 启动反馈区
    this.feed.start();
    // F11：启动定时器自动触发
    this.timer.start(1000);
    // Phase 0 修复⑤：心跳超时轮询（8.7：超时→agentLost）——独立 interval，保持 timer（sleepTimers）
    // 与 handshake（lastHeartbeat）各自的数据面边界
    this.heartbeatTimer = setInterval(() => {
      this.gateway.getHandshakeChannel().checkHeartbeatTimeout();
    }, 1000);
    this.started = true;
  }

  // Phase F.2：出厂权限 → permissionChanged 事件（投影 UPSERT 天然幂等）
  // 注：effect 字段（投影轨）；门禁轨 PermissionRule 用 decision，两轨字段名不同
  private importFactoryPermissions(): void {
    for (const rule of this.configLoader.loadFactoryPermissions()) {
      this.bus.publish({
        seq: null, timestamp: Date.now(),
        subject: { kind: 'module', module: 'system' },
        family: 'admin', subtype: 'permissionChanged', handles: {},
        payload: { ruleId: rule.ruleId, subject: rule.subject, action: rule.action, object: rule.object, effect: rule.effect },
        value: null,
      });
    }
  }

  stop(): void {
    // Phase 0 修复⑤：先停心跳轮询（在 gateway.stop 前）
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.timer.stop();
    this.schedulerRules.stop();
    // Phase 0 修复⑧：自动化引擎的 bus 订阅与规则定时器随 System 一起停（此前泄漏）
    this.automationRules.stop();
    this.supervisor.stopAll();   // Phase F.4：清重启定时器 + kill 全部子进程（在 projStore 关闭前）
    this.unwirePermissionSync(); // Phase F.5：解订权限热改同步（在 eventStore 关闭前）
    this.projector.stop();
    this.gateway.stop();
    this.feed.stop();
    this.projStore.close();
    this.eventStore.close();
    this.started = false;
  }

  describe(): SystemSnapshot {
    return describeSystem(this.projStore, this.eventStore, this.configLoader.getConfigDir());
  }

  getTransport(): TransportLayer {
    return this.transport;
  }
}

export function createSystem(opts: SystemOptions): System {
  return new System(opts);
}
