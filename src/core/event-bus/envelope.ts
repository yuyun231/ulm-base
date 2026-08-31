// 设计锚点：2.2 信封7字段；9.3 七族事件注册表
// 澄清1：主体判别联合；澄清2：价值占位；澄清3：关联柄对象

export const EVENT_FAMILIES = [
  'organ',      // ①器官事件（action/thought）
  'task',       // ②任务事件
  'schedule',   // ③调度事件
  'comm',       // ④通讯事件
  'dialogue',   // ⑤对话事件
  'admin',      // ⑥管理操作事件
  'doc',        // ⑦文档准入事件
] as const;

export type EventFamily = typeof EVENT_FAMILIES[number];

// 澄清1：主体判别联合（agent/module/human 三类）
export type EventSubject =
  | { kind: 'agent'; agentId: string }
  | { kind: 'module'; module: string }
  | { kind: 'human'; userId: string };

// 澄清3：关联柄对象（四个独立可空字段）
export interface EventHandles {
  taskId?: string;
  dialogueId?: string;
  workspaceId?: string;
  purposeId?: string;
}

// 澄清2：价值挂载位（首版占位，所有事件 value 填 null）
export interface ValueBinding {
  cost?: number;
  gain?: number;
  penalty?: number;
  note?: string;
}

// 2.2 事件信封：7字段
export interface EventEnvelope {
  seq: number | null;          // 落库前 null，sequencer 赋单调递增 seq
  timestamp: number;           // 毫秒时间戳
  subject: EventSubject;       // 主体（agent/module/human）
  family: EventFamily;         // 事件族（7族之一）
  subtype: string;             // 子类型（9.3 清单）
  handles: EventHandles;       // 关联柄（可空字段）
  payload: unknown;            // 载荷（各族 schema 不同）
  value: ValueBinding | null;  // 价值挂载位（首版 null）
}

// 落库后的信封（seq 已赋值）
export interface StoredEventEnvelope extends EventEnvelope {
  seq: number;                 // 落库后 seq 必有值
}

// 9.3 事件子类型注册表（硬约束清单，实现中只能出现这些子类型）
export const ORGAN_SUBTYPES = ['action', 'thought'] as const;
export const TASK_SUBTYPES = [
  'created', 'assigned', 'stateChanged', 'nodeSubmitted', 'nodeJudged',
  'rejected', 'restructured', 'childPublished', 'issueReported',
  'pathChangeRequested', 'guidanceIssued', 'guidanceInjected',
  'guidanceAcked', 'guidanceClosed',
  // F10 补完：目的状态机子类型归入②任务族
  'purposeCreated', 'purposeConfirmed', 'purposeLaunched',
] as const;
export const SCHEDULE_SUBTYPES = [
  'woken', 'slept', 'loaded', 'docRead', 'timerFired',
  'focusBound', 'orderChanged', 'agentLost',
] as const;
export const COMM_SUBTYPES = ['consultInitiated', 'consultAnswered', 'consultRejected'] as const;
export const DIALOGUE_SUBTYPES = ['turnPosted'] as const;
export const ADMIN_SUBTYPES = [
  'paramChanged', 'piercingIssued', 'piercingAcked', 'forceCommanded',
  'judgeConfigChanged', 'permissionChanged', 'fullAutoToggled',
  // Phase F.5（决策点 1）：面板权限删除——与 agent 族 Registered/Updated/Removed 对称
  'permissionRemoved',
  // Phase F 补完：agent 注册表生命周期与准入审计
  'agentRegistered', 'agentUpdated', 'agentRemoved',
  'agentRegisterRejected', 'agentCapabilityMismatch',
  // Phase F.3：自动化规则热加载与防环跳过审计
  'ruleChanged', 'automationSkipped',
  // Phase F.4：Supervisor 托管审计
  'agentSpawned', 'agentExited', 'agentRestartScheduled',
] as const;
export const DOC_SUBTYPES = ['admitted'] as const;

// 全部子类型集合（用于校验）
export const ALL_SUBTYPES: readonly string[] = [
  ...ORGAN_SUBTYPES, ...TASK_SUBTYPES, ...SCHEDULE_SUBTYPES,
  ...COMM_SUBTYPES, ...DIALOGUE_SUBTYPES, ...ADMIN_SUBTYPES, ...DOC_SUBTYPES,
];

// family → 合法子类型映射
const FAMILY_SUBTYPES: Record<EventFamily, readonly string[]> = {
  organ: ORGAN_SUBTYPES,
  task: TASK_SUBTYPES,
  schedule: SCHEDULE_SUBTYPES,
  comm: COMM_SUBTYPES,
  dialogue: DIALOGUE_SUBTYPES,
  admin: ADMIN_SUBTYPES,
  doc: DOC_SUBTYPES,
};

// 3.1 信封校验：必填字段、族合法、子类型合法且匹配族
export function validateEnvelope(env: EventEnvelope): void {
  if (env.timestamp === undefined || env.timestamp === null || typeof env.timestamp !== 'number') {
    throw new Error('信封校验失败：timestamp 缺失或非数值');
  }
  if (!env.subject) {
    throw new Error('信封校验失败：subject 缺失');
  }
  if (!EVENT_FAMILIES.includes(env.family)) {
    throw new Error(`信封校验失败：family "${env.family}" 不在7族中`);
  }
  const allowed = FAMILY_SUBTYPES[env.family];
  if (!allowed.includes(env.subtype)) {
    throw new Error(`信封校验失败：subtype "${env.subtype}" 不属于 family "${env.family}"`);
  }
  if (env.handles === undefined || env.handles === null) {
    throw new Error('信封校验失败：handles 缺失（应为对象，可空对象）');
  }
  if (env.payload === undefined) {
    throw new Error('信封校验失败：payload 缺失');
  }
}
