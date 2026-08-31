import type { EventBus } from '../event-bus/bus.js';
import type { ProjectionsStore } from '../projector/projections-store.js';
import type { ConcurrencyGate } from './concurrency-gate.js';
import type { LoadQueue } from './load-queue.js';
import type { TimerService } from './timer.js';
import type { StoredEventEnvelope } from '../event-bus/envelope.js';
import type { ControlChannel } from '../../seam/control-channel.js';
import type { TaskCommands } from '../../services/task/commands.js';
import type { GitAsset } from '../git-asset.js';

// F2/F3 软编码配置：易迭代点均可选可配，默认值与补完计划一致
export interface SchedulerConfig {
  gitAsset?: GitAsset;
  compressThreshold: number;
  injectInlineMaxBytes: number;
  // 软编码：对话原文存档路径模板（{dialogueId} 占位符）
  archiveDialoguePathTemplate?: string;
  // 软编码：对话原文拼接格式（{channel}/{author}/{content} 占位符）
  archiveDialogueContentTemplate?: string;
  // 软编码：共享记忆目录映射（scope 前缀 → git 目录）
  memoryGlobalDir?: string;
  memoryAggDirTemplate?: string; // {scope} 占位符 = 去掉 'agg:' 前缀的聚合任务id
}

// 设计锚点 3.2：纯规则机，消费事件+读投影+产决策事件，自身不改状态。
// 3.3 五项职责：①任务状态机推进②agent状态机推进③长期任务定时④并发上限⑤分配执行
// 3.8 focus过滤（澄清6：在调度器内不在投影器）
// 3.9 查阅算调度→重置倒计时（澄清7）
// 4.2 DAG节点就绪→解锁后继

export class SchedulerRules {
  private bus: EventBus;
  private projStore: ProjectionsStore;
  private concurrencyGate: ConcurrencyGate;
  private loadQueue: LoadQueue;
  private timer: TimerService;
  private controlChannel: ControlChannel;
  private taskCommands: TaskCommands;
  private gitAsset: GitAsset | null;
  private compressThreshold: number;
  private injectInlineMaxBytes: number;
  private archiveDialoguePathTemplate: string;
  private archiveDialogueContentTemplate: string;
  private memoryGlobalDir: string;
  private memoryAggDirTemplate: string;
  private unsub: (() => void) | null = null;
  // Phase 0 修复⑨：待回执判定请求（commandId → 任务/节点）；回执转换后移除
  private pendingJudge = new Map<string, { taskId: string; nodeId: string | null }>();

  constructor(
    bus: EventBus,
    projStore: ProjectionsStore,
    concurrencyGate: ConcurrencyGate,
    loadQueue: LoadQueue,
    timer: TimerService,
    controlChannel: ControlChannel,  // 新增
    taskCommands: TaskCommands,      // Phase 0 修复③：派发走命令面（产 task.assigned → 投影出队/记账）
    config: SchedulerConfig,         // F2：必选，含阈值与 git 资产（可空依赖）
  ) {
    this.bus = bus;
    this.projStore = projStore;
    this.concurrencyGate = concurrencyGate;
    this.loadQueue = loadQueue;
    this.timer = timer;
    this.controlChannel = controlChannel;
    this.taskCommands = taskCommands;
    this.gitAsset = config.gitAsset ?? null;
    this.compressThreshold = config.compressThreshold;
    this.injectInlineMaxBytes = config.injectInlineMaxBytes;
    this.archiveDialoguePathTemplate = config.archiveDialoguePathTemplate ?? 'archive/dialogue/{dialogueId}/dialogue.txt';
    this.archiveDialogueContentTemplate = config.archiveDialogueContentTemplate ?? '[{channel}] {author}: {content}';
    this.memoryGlobalDir = config.memoryGlobalDir ?? 'memory/global';
    this.memoryAggDirTemplate = config.memoryAggDirTemplate ?? 'memory/agg/{scope}';
  }

  start(): void {
    this.unsub = this.bus.subscribe((env) => this.handleEvent(env));
  }

  stop(): void {
    if (this.unsub) { this.unsub(); this.unsub = null; }
  }

  private handleEvent(env: StoredEventEnvelope): void {
    // 3.3②③ + 澄清7：查阅重置倒计时
    if (env.family === 'schedule' && env.subtype === 'docRead' && env.subject.kind === 'agent') {
      this.timer.resetSleepCountdown(env.subject.agentId);
    }

    // E.2 决策1：定时器到期→休眠链路闭环（timerFired → slept 事件 + sleep 指令下发）
    if (env.family === 'schedule' && env.subtype === 'timerFired') {
      const agentId = (env.payload as any).agentId;
      if (agentId) this.handleSleep(agentId);
    }

    // 3.3①②⑤：任务分配触发 agent 加载链路
    if (env.family === 'task' && env.subtype === 'assigned') {
      const agentId = (env.payload as any).agentId;
      const taskId = env.handles.taskId;
      if (agentId && taskId) {
        this.handleAssignment(agentId, taskId);
      }
    }

    // Phase 0 修复③：任务创建后自动派发（3.3⑤ 调度器执行分配；澄清4 待办→进行=调度器分配）
    if (env.family === 'task' && env.subtype === 'created') {
      this.tryAssignFromQueue();
    }

    // Phase 0 修复⑤（8.7 补充2）：心跳超时失联 → handshake 产 agentLost（投影标 lost=1），
    // 调度器将其进行中任务转「暂停」（材料保留在事件流/投影中）
    if (env.family === 'schedule' && env.subtype === 'agentLost' && env.subject.kind === 'agent') {
      const agentId = env.subject.agentId;
      const active = this.projStore.all(
        "SELECT taskId FROM tasks WHERE assignedAgent = ? AND state = 'inProgress'", agentId
      ) as any[];
      for (const t of active) {
        this.bus.publish({
          seq: null, timestamp: Date.now(),
          subject: { kind: 'module', module: 'scheduler' },
          family: 'task', subtype: 'stateChanged',
          handles: { taskId: t.taskId }, payload: { newState: 'paused' }, value: null,
        });
      }
    }

    // 3.3①：任务状态机推进——判定后状态恢复 + 全节点完成才收敛任务
    // Phase 0 修复④：pass 后恢复 agent 状态（此前不产 loaded → agent 永卡 waiting）
    // Phase 0 修复⑬：reject 后打回重做（4.8 补充1：任务回进行，原 agent 继续；不发 redo）
    if (env.family === 'task' && env.subtype === 'nodeJudged') {
      const result = (env.payload as any).result;
      const taskId = env.handles.taskId;
      if (result === 'pass') {
        // 投影同步消费 nodeJudged 先把当前节点置 done（投影器先于调度器订阅），此处查剩余未完成节点
        const rest = this.projStore.get(
          "SELECT COUNT(*) AS n FROM task_nodes WHERE taskId = ? AND dagVersion = (SELECT MAX(dagVersion) FROM task_nodes WHERE taskId = ?) AND nodeState != 'done'",
          taskId, taskId
        ) as any;
        if (!rest || rest.n === 0) {
          // 全部节点完成 → 任务完成 + agent 恢复 idle
          this.concurrencyGate.decrementWorking();
          this.bus.publish({
            seq: null, timestamp: Date.now(),
            subject: { kind: 'module', module: 'scheduler' },
            family: 'task', subtype: 'stateChanged',
            handles: { taskId }, payload: { newState: 'done' }, value: null,
          });
          this.restoreAgent(taskId, 'idle');
        } else {
          // 中间节点通过 → agent 继续后继节点（保持 working，并发不释放）
          this.restoreAgent(taskId, 'working');
        }
      } else if (result === 'reject') {
        // 驳回 → 节点回 inProgress（投影完成），agent 回 working 重做；并发保持占用
        this.restoreAgent(taskId, 'working');
      }
      // 尝试取下一任务（4.2 后继节点解锁 或 新任务）
      this.tryAssignFromQueue();
    }

    // 3.3②：agent 提交材料→waiting + 判定请求下发
    if (env.family === 'task' && env.subtype === 'nodeSubmitted') {
      const agentId = env.subject.kind === 'agent' ? env.subject.agentId : null;
      if (agentId) {
        this.bus.publish({
          seq: null, timestamp: Date.now(),
          subject: { kind: 'agent', agentId },
          family: 'schedule', subtype: 'loaded', // 用 loaded 事件表达 workState 变化
          handles: env.handles, payload: { workState: 'waiting' }, value: null,
        });
      }
      // Phase 0 修复⑨：向判定人下发判定请求（4.3 判定人：人/任务管理员/自动校验器，缺省任务管理员）
      this.dispatchJudgeRequest(env);
    }

    // Phase 0 修复⑨：记录已下发的判定请求（commandId → 任务/节点），回执到达时转换为 approve/reject
    // 覆盖两条来源：调度器经 sendCommand 下发（type=judgeResult）、agent 经 service judgeRequest 发起（type=judgeRequest）
    if (env.family === 'admin' && env.subtype === 'piercingIssued') {
      const p = env.payload as any;
      if ((p.type === 'judgeRequest' || p.type === 'judgeResult') && p.commandId && p.taskId) {
        this.pendingJudge.set(p.commandId, { taskId: p.taskId, nodeId: p.nodeId ?? null });
      }
    }

    // Phase 0 修复⑨：判定回执 → nodeJudged 转换桥（澄清8：调度器订阅 piercingAcked 推进调度）
    // 回执契约：内核回 ack 携带 commandId + result('pass'|'reject') + detail（判定依据）
    if (env.family === 'admin' && env.subtype === 'piercingAcked') {
      const p = env.payload as any;
      if (p.commandId && this.pendingJudge.has(p.commandId)) {
        const ref = this.pendingJudge.get(p.commandId)!;
        this.pendingJudge.delete(p.commandId);
        if (ref.nodeId && p.result === 'pass') {
          this.taskCommands.approve('module:scheduler', ref.taskId, ref.nodeId,
            p.note ?? p.detail ?? '判定通过', 'pass');
        } else if (ref.nodeId && p.result === 'reject') {
          this.taskCommands.reject('module:scheduler', ref.taskId, ref.nodeId,
            p.note ?? p.detail ?? '判定驳回');
        }
        // 无 result（如未连接合成回执 success=false）→ 不转换；节点停留 underReview，
        // 可经面板人工判定（approveTask/rejectTask）兜底
      }
    }

    // 3.4：定时器到期检查——F11 补完后由 TimerService 自循环发布 timerFired，
    // Phase 0 修复：移除此处 checkExpired() 调用（丢弃返回值会与自循环抢删到期条目，静默吞事件）

    // F1：征求决策投递——consultInitiated → inject 给方案助手
    if (env.family === 'comm' && env.subtype === 'consultInitiated') {
      const p = env.payload as any;
      // 从 consults 投影表读取方案对话id（聚合任务的方案对话）
      const consult = this.projStore.get('SELECT * FROM consults WHERE consultId = ?', env.handles.taskId) as any;
      const dialogueId = consult?.sourceDialogueId ?? `plan-${p.aggregateTaskId}`;
      // 产 inject 控制流指令投递征求任务给方案助手
      this.controlChannel.sendCommand(
        'module:scheduler',
        p.targetAgentId ?? 'plan-assistant',
        'inject',
        { dialogueId, question: p.question, consultTaskId: env.handles.taskId }
      );
    }

    // F1：征求决策回传——consultAnswered → inject 答案给发起方原对话
    if (env.family === 'comm' && env.subtype === 'consultAnswered') {
      const consult = this.projStore.get('SELECT * FROM consults WHERE consultId = ?', env.handles.taskId) as any;
      if (consult) {
        // inject 载荷只含答案文本，回传到发起方原对话
        this.controlChannel.sendCommand(
          'module:scheduler',
          consult.initiatorAgentId,
          'inject',
          { dialogueId: consult.sourceDialogueId, content: (env.payload as any).answer }
        );
      }
    }

    // F5：指导注入——当下指导(type=now) guidanceIssued → correct 指令 + guidanceInjected
    if (env.family === 'task' && env.subtype === 'guidanceIssued') {
      const p = env.payload as any;
      if (p.type === 'now') {
        // 7.10① 当下指导：经 correct 控制流指令注入
        // agentId 从任务投影读取执行者（inProgress 任务的 assignedAgent）
        const task = this.projStore.get(
          "SELECT assignedAgent FROM tasks WHERE taskId = ? AND state = 'inProgress'",
          env.handles.taskId
        ) as any;
        this.controlChannel.sendCommand(
          'module:scheduler',
          task?.assignedAgent ?? '',
          'correct',
          { guidanceId: p.guidanceId, content: p.content, taskId: env.handles.taskId }
        );
        // 产 guidanceInjected 事件
        this.bus.publish({
          seq: null, timestamp: Date.now(),
          subject: { kind: 'module', module: 'scheduler' },
          family: 'task', subtype: 'guidanceInjected',
          handles: { taskId: env.handles.taskId },
          payload: { guidanceId: p.guidanceId }, value: null,
        });
      }
      // 7.10② 未来指导(type=future)：不立即注入，存任务载荷（调度器加载任务时打包）
      // 未来指导的打包逻辑在任务分配时处理
    }

    // F2：压缩触发——turnPosted 且 turnCount 达到阈值 → 存档原文 + admitted 事件
    if (env.family === 'dialogue' && env.subtype === 'turnPosted') {
      const dialogueId = env.handles.dialogueId;
      if (dialogueId) {
        const dlg = this.projStore.get('SELECT * FROM dialogues WHERE dialogueId = ?', dialogueId) as any;
        if (dlg && dlg.turnCount >= this.compressThreshold && dlg.archived === 0 && this.gitAsset) {
          // 读取全部 turn 原文
          const turns = this.projStore.all(
            'SELECT * FROM dialogue_turns WHERE dialogueId = ? ORDER BY seq ASC', dialogueId
          ) as any[];
          // 拼接对话原文（拼接格式软编码，默认 [{channel}] {author}: {content}）
          const dialogueContent = turns.map(t =>
            this.archiveDialogueContentTemplate
              .replace('{channel}', t.channel ?? '')
              .replace('{author}', t.author ?? '')
              .replace('{content}', t.content ?? '')
          ).join('\n');
          // 写入 git archive/（存档路径模板软编码，默认 archive/dialogue/{dialogueId}/dialogue.txt）
          const archivePath = this.archiveDialoguePathTemplate.replace('{dialogueId}', dialogueId);
          this.gitAsset.writeAndCommit(archivePath, dialogueContent, `feat: archive dialogue ${dialogueId}`);
          // 标记已存档
          this.projStore.run('UPDATE dialogues SET archived = 1 WHERE dialogueId = ?', dialogueId);
          // 产 admitted 事件（⑦文档准入族，payload 含 git 文件指针）
          this.bus.publish({
            seq: null, timestamp: Date.now(),
            subject: { kind: 'module', module: 'scheduler' },
            family: 'doc', subtype: 'admitted',
            handles: { dialogueId },
            payload: { scope: 'archive:dialogue', filePath: archivePath, basis: 'compressThreshold' },
            value: null,
          });
        }
      }
    }

    // F3：记忆水印 delta 注入——turnPosted 且对话有 memoryScope → 从 git 读 delta → 产 docRead
    if (env.family === 'dialogue' && env.subtype === 'turnPosted') {
      const dialogueId = env.handles.dialogueId;
      if (dialogueId && this.gitAsset) {
        const dlg = this.projStore.get('SELECT * FROM dialogues WHERE dialogueId = ?', dialogueId) as any;
        if (dlg && dlg.memoryScope) {
          // 5.9② 从 git memory/ 读取水印之后的新条目（目录映射软编码，默认 global/agg 两目录）
          const scope = dlg.memoryScope as string; // 'global' 或 'agg:task-1'
          const memoryDir = scope.startsWith('agg:')
            ? this.memoryAggDirTemplate.replace('{scope}', scope.substring(4))
            : this.memoryGlobalDir;
          const allFiles = this.gitAsset.listDir(memoryDir);
          // 水印是上次读到的最后一个文件名（空字符串=全部是 delta）
          const watermark = dlg.watermark || '';
          const deltaFiles = allFiles.filter(f => f > watermark);
          if (deltaFiles.length > 0) {
            // 读取 delta 内容
            const deltaContents: string[] = [];
            for (const f of deltaFiles) {
              deltaContents.push(this.gitAsset.readFile(`${memoryDir}/${f}`));
            }
            const deltaContent = deltaContents.join('\n---\n');
            // 5.9③ 产 docRead 事件（③调度族，payload 含 delta 内容）
            this.bus.publish({
              seq: null, timestamp: Date.now(),
              subject: { kind: 'module', module: 'scheduler' },
              family: 'schedule', subtype: 'docRead',
              handles: { dialogueId },
              payload: { scope, content: deltaContent, deltaFiles },
              value: null,
            });
            // 更新 watermark 到最后一个文件名
            const newWatermark = deltaFiles[deltaFiles.length - 1];
            this.projStore.run(
              'UPDATE dialogues SET watermark = ? WHERE dialogueId = ?',
              newWatermark, dialogueId
            );
          }
        }
      }
    }
  }

  // 3.3⑤ 分配执行完整链路：唤醒→加载→工作
  private handleAssignment(agentId: string, taskId: string): void {
    // 3.3④ 并发上限检查
    if (!this.concurrencyGate.canStart(agentId)) return;

    // 3.3② 唤醒链路：休眠→唤醒空闲
    const agent = this.projStore.get('SELECT * FROM agents WHERE agentId = ?', agentId) as any;
    if (!agent || agent.wakeState === 'dormant') {
      this.bus.publish({
        seq: null, timestamp: Date.now(),
        subject: { kind: 'agent', agentId },
        family: 'schedule', subtype: 'woken',
        handles: {}, payload: {}, value: null,
      });
      this.timer.startTracking(agentId);
    }

    // 3.3② 唤醒空闲→工作（loaded 事件）
    this.bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'agent', agentId },
      family: 'schedule', subtype: 'loaded',
      handles: { taskId }, payload: {}, value: null,
    });
    this.concurrencyGate.incrementWorking();

    // E.2：8.6 唤醒载荷装配——产完 woken/loaded 事件后经控制通道发 wake 指令
    const taskRow = this.projStore.get('SELECT * FROM tasks WHERE taskId = ?', taskId) as any;
    const dialogueId: string | null = taskRow?.dialogueId ?? null;
    const dialogueRow = dialogueId
      ? this.projStore.get('SELECT * FROM dialogues WHERE dialogueId = ?', dialogueId) as any
      : null;
    const guidances = this.projStore.all(
      'SELECT * FROM guidances WHERE taskId = ?', taskId
    ) as any[];
    const permissions = this.projStore.all(
      'SELECT * FROM permission_rules WHERE subject = ?', `agent:${agentId}`
    ) as any[];
    // Phase 0 修复⑦：节点目标 + DAG 快照（此前 wake 载荷不读 task_nodes/task_edges，
    // agent 拿不到节点目标与依赖结构）
    const dagVersion = taskRow?.dagVersion ?? 1;
    const dagNodes = this.projStore.all(
      'SELECT * FROM task_nodes WHERE taskId = ? AND dagVersion = ? ORDER BY nodeId ASC',
      taskId, dagVersion
    ) as any[];
    const dagEdges = this.projStore.all(
      'SELECT * FROM task_edges WHERE taskId = ? AND dagVersion = ? ORDER BY fromNode ASC, toNode ASC',
      taskId, dagVersion
    ) as any[];
    // 当前应执行节点：首个 pending/inProgress 节点（单节点任务即 node-1；无节点数据时为 null）
    const currentNode = dagNodes.find(n => n.nodeState === 'pending' || n.nodeState === 'inProgress') ?? null;
    this.controlChannel.sendCommand('module:scheduler', agentId, 'wake', {
      taskId,
      nodeId: currentNode?.nodeId ?? null,
      dag: { version: dagVersion, nodes: dagNodes, edges: dagEdges },
      task: {
        taskId,
        taskType: taskRow?.taskType ?? 'normal',
        goal: taskRow?.goal ?? null,
        acceptanceCriteria: taskRow?.acceptanceCriteria ?? null,
        dagVersion: taskRow?.dagVersion ?? 1,
        parentTaskId: taskRow?.parentTaskId ?? null,
        dialogueId,
        workspaceId: taskRow?.workspaceId ?? null,
      },
      // 对话指示：dialogues 表有该行 → continue（沿用既有对话）；无 → new（由内核建立）
      dialogue: { dialogueId, mode: dialogueRow ? 'continue' : 'new' },
      guidance: guidances,
      permissions,
      workspace: { workspaceId: taskRow?.workspaceId ?? null },
    });
  }

  // E.2 决策1：休眠链路闭环——timerFired(agentId) → 产 slept 事件（投影落 dormant）+ sleep 指令下发
  private handleSleep(agentId: string): void {
    this.bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'agent', agentId },
      family: 'schedule', subtype: 'slept',
      handles: {}, payload: {}, value: null,
    });
    this.controlChannel.sendCommand('module:scheduler', agentId, 'sleep', {});
  }

  // Phase 0 修复④⑬：判定后 agent 状态恢复（waiting→idle / waiting→working）
  // agent 身份取 tasks 投影 assignedAgent（nodeJudged 的主体是判定人，不是执行者）
  private restoreAgent(taskId: string | null | undefined, workState: 'idle' | 'working'): void {
    if (!taskId) return;
    const task = this.projStore.get('SELECT assignedAgent FROM tasks WHERE taskId = ?', taskId) as any;
    const agentId: string | null = task?.assignedAgent ?? null;
    if (!agentId) return;
    this.bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'agent', agentId },
      family: 'schedule', subtype: 'loaded',
      handles: { taskId }, payload: { workState }, value: null,
    });
  }

  // Phase 0 修复⑨：判定请求下发——经 judgeResult 指令（8.4 语义：请求判定）请求判定人裁决
  private dispatchJudgeRequest(env: StoredEventEnvelope): void {
    const taskId = env.handles.taskId;
    const p = env.payload as any;
    const nodeId: string | null = p.nodeId ?? null;
    if (!taskId || !nodeId) return;
    const judge = this.resolveJudge(taskId, nodeId);
    if (!judge) return; // 判定人=人（human）时经面板人工判定，不向 agent 下发
    this.controlChannel.sendCommand('module:scheduler', judge, 'judgeResult', {
      taskId, nodeId,
      material: p.material ?? null,
      question: `节点 ${nodeId} 验收判定：请对照验收标准给出 pass/reject 与依据`,
      context: { taskId, nodeId, isLastNode: p.isLastNode ?? null },
    });
  }

  // Phase 0 修复⑨：判定人解析——节点 executor 配置优先（'human'/'auto' 不走 agent 派发），
  // 否则取 agent_registry 中具 task:judge capability 的 agent，缺省 task-admin（4.3 默认判定人）
  private resolveJudge(taskId: string, nodeId: string): string | null {
    const node = this.projStore.get(
      'SELECT executor FROM task_nodes WHERE taskId = ? AND nodeId = ? AND dagVersion = (SELECT MAX(dagVersion) FROM task_nodes WHERE taskId = ? AND nodeId = ?)',
      taskId, nodeId, taskId, nodeId
    ) as any;
    const executor: string | null = node?.executor ?? null;
    if (executor) {
      if (executor === 'human' || executor === 'auto') return null;
      return executor;
    }
    try {
      const reg = this.projStore.get(
        "SELECT agentId FROM agent_registry WHERE capabilities LIKE '%task:judge%' AND enabled = 1 ORDER BY agentId ASC LIMIT 1"
      ) as any;
      return reg?.agentId ?? 'task-admin';
    } catch {
      // agent_registry 投影未装配（最小测试装配）→ 缺省判定人
      return 'task-admin';
    }
  }

  // 3.3⑤ + 3.8：待分配区→工作区分配，含 focus 过滤
  // Phase 0 修复③：经 TaskCommands.assign 命令面派发（产 task.assigned → tasks 投影记 assignedAgent、
  // load_queue 出队），替代此前直调 handleAssignment 绕过投影记账的缺陷
  private tryAssignFromQueue(): void {
    if (!this.concurrencyGate.hasCapacity()) return;
    // 查空闲且未失联的 agent
    const idleAgents = this.projStore.all(
      "SELECT * FROM agents WHERE wakeState = 'awakened' AND workState = 'idle' AND lost = 0"
    ) as any[];
    for (const agent of idleAgents) {
      if (!this.concurrencyGate.hasCapacity()) break;
      // 3.3④：并发上限预检——不满足则跳过该 agent，不消费任务（任务留待分配区）
      if (!this.concurrencyGate.canStart(agent.agentId)) continue;
      // 3.8/澄清6：focus 过滤在调度器内
      const assignment = this.loadQueue.nextAssignmentForAgent(this.projStore, agent.agentId);
      if (!assignment) continue;
      // 经命令面派发：publish task.assigned → 订阅同步触发 handleAssignment（唤醒+加载+wake）
      this.taskCommands.assign('module:scheduler', assignment.taskId, agent.agentId);
    }
  }
}
