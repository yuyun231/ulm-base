import { describe, it, expect } from 'vitest';
import {
  EVENT_FAMILIES,
  type EventEnvelope,
  type EventSubject,
  type EventHandles,
  type ValueBinding,
} from '../../src/core/event-bus/envelope.js';
import {
  ORGAN_SUBTYPES,
  TASK_SUBTYPES,
  SCHEDULE_SUBTYPES,
  COMM_SUBTYPES,
  DIALOGUE_SUBTYPES,
  ADMIN_SUBTYPES,
  DOC_SUBTYPES,
} from '../../src/core/event-bus/envelope.js';
import { validateEnvelope } from '../../src/core/event-bus/envelope.js';

describe('EventEnvelope 类型与枚举', () => {
  it('EVENT_FAMILIES 包含7族', () => {
    expect(EVENT_FAMILIES).toEqual([
      'organ',      // ①器官事件
      'task',       // ②任务事件
      'schedule',   // ③调度事件
      'comm',       // ④通讯事件
      'dialogue',   // ⑤对话事件
      'admin',      // ⑥管理操作事件
      'doc',        // ⑦文档准入事件
    ]);
  });

  it('EventSubject agent 主体', () => {
    const subject: EventSubject = { kind: 'agent', agentId: 'res-01' };
    expect(subject.kind).toBe('agent');
  });

  it('EventSubject module 主体', () => {
    const subject: EventSubject = { kind: 'module', module: 'scheduler' };
    expect(subject.kind).toBe('module');
  });

  it('EventSubject human 主体', () => {
    const subject: EventSubject = { kind: 'human', userId: 'user-1' };
    expect(subject.kind).toBe('human');
  });

  it('ValueBinding 首版为 null', () => {
    const value: ValueBinding | null = null;
    expect(value).toBeNull();
  });

  it('EventHandles 空对象表示无关联', () => {
    const handles: EventHandles = {};
    expect(Object.keys(handles)).toHaveLength(0);
  });

  it('EventHandles 含任务id', () => {
    const handles: EventHandles = { taskId: 'task-1' };
    expect(handles.taskId).toBe('task-1');
  });

  it('构造完整信封', () => {
    const envelope: EventEnvelope = {
      seq: null,           // 落库前为 null，sequencer 赋值
      timestamp: Date.now(),
      subject: { kind: 'agent', agentId: 'res-01' },
      family: 'task',
      subtype: 'created',
      handles: { taskId: 'task-1' },
      payload: { title: '测试任务' },
      value: null,
    };
    expect(envelope.family).toBe('task');
    expect(envelope.subtype).toBe('created');
  });
});

describe('事件子类型注册表（9.3）', () => {
  it('①器官族子类型', () => {
    expect(ORGAN_SUBTYPES).toEqual(['action', 'thought']);
  });

  it('②任务族子类型', () => {
    expect(TASK_SUBTYPES).toEqual([
      'created', 'assigned', 'stateChanged', 'nodeSubmitted', 'nodeJudged',
      'rejected', 'restructured', 'childPublished', 'issueReported',
      'pathChangeRequested', 'guidanceIssued', 'guidanceInjected',
      'guidanceAcked', 'guidanceClosed',
      // F10 补完：目的状态机子类型归入②任务族
      'purposeCreated', 'purposeConfirmed', 'purposeLaunched',
    ]);
  });

  it('③调度族子类型', () => {
    expect(SCHEDULE_SUBTYPES).toEqual([
      'woken', 'slept', 'loaded', 'docRead', 'timerFired',
      'focusBound', 'orderChanged', 'agentLost',
    ]);
  });

  it('④通讯族子类型', () => {
    expect(COMM_SUBTYPES).toEqual(['consultInitiated', 'consultAnswered', 'consultRejected']);
  });

  it('⑤对话族子类型', () => {
    expect(DIALOGUE_SUBTYPES).toEqual(['turnPosted']);
  });

  it('⑥管理操作族子类型', () => {
    expect(ADMIN_SUBTYPES).toEqual([
      'paramChanged', 'piercingIssued', 'piercingAcked', 'forceCommanded',
      'judgeConfigChanged', 'permissionChanged', 'fullAutoToggled',
      // Phase F.5（决策点 1）：面板权限删除
      'permissionRemoved',
      // Phase F 补完：agent 注册表生命周期与准入审计
      'agentRegistered', 'agentUpdated', 'agentRemoved',
      'agentRegisterRejected', 'agentCapabilityMismatch',
      // Phase F.3：自动化规则热加载与防环跳过审计
      'ruleChanged', 'automationSkipped',
      // Phase F.4：Supervisor 托管审计
      'agentSpawned', 'agentExited', 'agentRestartScheduled',
    ]);
  });

  it('⑦文档准入族子类型', () => {
    expect(DOC_SUBTYPES).toEqual(['admitted']);
  });
});

describe('validateEnvelope 信封校验', () => {
  const validEnvelope: EventEnvelope = {
    seq: null,
    timestamp: Date.now(),
    subject: { kind: 'agent', agentId: 'res-01' },
    family: 'task',
    subtype: 'created',
    handles: {},
    payload: {},
    value: null,
  };

  it('合法信封通过校验', () => {
    expect(() => validateEnvelope(validEnvelope)).not.toThrow();
  });

  it('缺少 timestamp 报错', () => {
    const bad = { ...validEnvelope, timestamp: undefined };
    expect(() => validateEnvelope(bad)).toThrow('timestamp');
  });

  it('非法 family 报错', () => {
    const bad = { ...validEnvelope, family: 'invalid' as any };
    expect(() => validateEnvelope(bad)).toThrow('family');
  });

  it('非法 subtype 报错', () => {
    const bad = { ...validEnvelope, subtype: 'nonExistent' };
    expect(() => validateEnvelope(bad)).toThrow('subtype');
  });

  it('family 与 subtype 不匹配报错（task 族不能用 woken）', () => {
    const bad = { ...validEnvelope, family: 'task', subtype: 'woken' };
    expect(() => validateEnvelope(bad)).toThrow('subtype');
  });

  it('缺少 subject 报错', () => {
    const bad = { ...validEnvelope, subject: undefined as any };
    expect(() => validateEnvelope(bad)).toThrow('subject');
  });

  it('Phase F：agent 注册族子类型通过校验', () => {
    for (const subtype of ['agentRegistered', 'agentUpdated', 'agentRemoved', 'agentRegisterRejected', 'agentCapabilityMismatch']) {
      expect(() => validateEnvelope({ ...validEnvelope, family: 'admin', subtype, payload: {} })).not.toThrow();
    }
  });

  it('Phase F.3：ruleChanged / automationSkipped 通过校验，未声明子类型仍拒绝', () => {
    expect(() => validateEnvelope({ ...validEnvelope, family: 'admin', subtype: 'ruleChanged', payload: {} })).not.toThrow();
    expect(() => validateEnvelope({ ...validEnvelope, family: 'admin', subtype: 'automationSkipped', payload: {} })).not.toThrow();
    expect(() => validateEnvelope({ ...validEnvelope, family: 'admin', subtype: 'ruleChanged2', payload: {} })).toThrow('subtype');
  });

  it('Phase F.4：Supervisor 托管审计子类型通过校验', () => {
    for (const subtype of ['agentSpawned', 'agentExited', 'agentRestartScheduled']) {
      expect(() => validateEnvelope({ ...validEnvelope, family: 'admin', subtype, payload: {} })).not.toThrow();
    }
  });

  it('Phase F.5：admin.permissionRemoved 合法（决策点 1，载荷 {ruleId}）', () => {
    expect(() => validateEnvelope({
      seq: null, timestamp: Date.now(), subject: { kind: 'human', userId: 'u1' },
      family: 'admin', subtype: 'permissionRemoved', handles: {}, payload: { ruleId: 'rule-1' }, value: null,
    } as any)).not.toThrow();
  });
});
