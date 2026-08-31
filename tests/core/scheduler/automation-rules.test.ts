import { describe, it, expect } from 'vitest';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import { TaskCommands } from '../../src/services/task/commands.js';
import { AutomationRules } from '../../src/core/scheduler/automation-rules.js';
import type { AutomationRule } from '../../src/config/loader.js';

function makeCtx(rules: AutomationRule[], taskRules: any[] = [
  // 门禁基线（决策点 2）：引擎 createTask 放行 + 审批卡点（require-approval）
  { subject: 'module:automation', action: 'task:create', object: '*', decision: 'allow' },
  { subject: 'module:automation', action: 'task:judge', object: '*', decision: 'require-approval' },
]) {
  const eventStore = new EventStore(':memory:');
  const bus = new EventBus(eventStore);
  const taskCommands = new TaskCommands(bus, taskRules);
  const wakeCalls: Array<{ subject: string; agentId: string; command: string; payload: any }> = [];
  const controlChannel = {
    sendCommand: (subject: string, agentId: string, command: string, payload: any) =>
      wakeCalls.push({ subject, agentId, command, payload }),
  } as any;
  const timers: Array<{ fn: () => void; ms: number } | null> = [];
  let now = 1_000_000;
  const engine = new AutomationRules({
    bus, taskCommands, controlChannel,
    loadRules: () => rules,
    now: () => now,
    setIntervalFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearIntervalFn: (t) => { timers[t as number] = null; },
  });
  return {
    bus, eventStore, wakeCalls, timers, engine,
    tick(i: number) { timers[i]?.fn(); },
    setNow(n: number) { now = n; },
    stop() { engine.stop(); eventStore.close(); },
  };
}

const archiveRule: AutomationRule = {
  ruleId: 'auto-archive-on-verify-pass',
  trigger: { type: 'event', family: 'task', subtype: 'nodeJudged' },
  filter: { 'payload.result': 'pass', 'payload.nodeKey': 'verify' },
  action: { type: 'createTask', taskType: 'normal', goal: '归档 {taskId}', acceptanceCriteria: '', priority: 3, procedure: 'archive' },
  guard: { maxDepth: 2, cooldownSec: 60 },
  trackDepth: true,   // 链式深度测试需要；默认规则不开启（决策点 1）
  subjectAllowlist: ['human:*'],   // 人类判定触发的归档规则；缺省 allowlist 见下个专项测试
  enabled: true,
};

function publishNodeJudged(bus: EventBus, taskId: string, result = 'pass', nodeKey = 'verify', subject = 'human:u1', extraPayload: Record<string, any> = {}) {
  bus.publish({
    seq: null, timestamp: Date.now(),
    subject: subject.startsWith('human:') ? { kind: 'human', userId: subject.split(':')[1] } : { kind: 'module', module: subject.split(':')[1] },
    family: 'task', subtype: 'nodeJudged', handles: { taskId },
    payload: { result, nodeKey, judgeNote: '', ...extraPayload },
    value: null,
  });
}

describe('AutomationRules 防环三件套与动作执行', () => {
  it('事件规则命中 filter → createTask 产 created 事件（trackDepth 规则携 depth/origin，require 卡审批）', () => {
    const ctx = makeCtx([archiveRule]);
    ctx.engine.start();
    publishNodeJudged(ctx.bus, 't-src');
    const created = ctx.eventStore.getByFamily('task').filter(e => e.subtype === 'created' && e.subject.kind === 'module');
    expect(created).toHaveLength(1);
    expect(created[0].payload.goal).toBe('归档 t-src');
    expect(created[0].payload.originTaskId).toBe('t-src');
    expect(created[0].payload.regenerationDepth).toBe(1);
    expect(created[0].payload.requireApproval).toBe(true);   // 缺省 approval=require → 审批卡点
    ctx.stop();
  });

  it('默认规则（不 trackDepth）→ 不透传 depth/origin（再生追踪可选）', () => {
    const plain: AutomationRule = { ...archiveRule, ruleId: 'plain', trackDepth: undefined };
    const ctx = makeCtx([plain]);
    ctx.engine.start();
    publishNodeJudged(ctx.bus, 't-src');
    const created = ctx.eventStore.getByFamily('task').filter(e => e.subtype === 'created' && e.subject.kind === 'module');
    expect(created).toHaveLength(1);
    expect(created[0].payload.regenerationDepth).toBeUndefined();
    expect(created[0].payload.originTaskId).toBeUndefined();
    ctx.stop();
  });

  it('approval=auto → 不透传 requireApproval（常再生任务配置留口子）', () => {
    const auto: AutomationRule = { ...archiveRule, ruleId: 'auto', approval: 'auto' };
    const ctx = makeCtx([auto]);
    ctx.engine.start();
    publishNodeJudged(ctx.bus, 't-src');
    const created = ctx.eventStore.getByFamily('task').filter(e => e.subtype === 'created' && e.subject.kind === 'module');
    expect(created).toHaveLength(1);
    expect(created[0].payload.requireApproval).toBeUndefined();
    ctx.stop();
  });

  it('filter 不匹配（result=fail）→ 无 created 无 skipped', () => {
    const ctx = makeCtx([archiveRule]);
    ctx.engine.start();
    publishNodeJudged(ctx.bus, 't-src', 'fail');
    expect(ctx.eventStore.getByFamily('task').filter(e => e.subtype === 'created')).toHaveLength(0);
    expect(ctx.eventStore.getByFamily('admin').filter(e => e.subtype === 'automationSkipped')).toHaveLength(0);
    ctx.stop();
  });

  it('缺省 allowlist：module 族来源命中，human 来源被跳过（subject-not-allowed）', () => {
    const defaultAllow: AutomationRule = { ...archiveRule, ruleId: 'def', subjectAllowlist: undefined };
    const ctx = makeCtx([defaultAllow]);
    ctx.engine.start();
    publishNodeJudged(ctx.bus, 't-src', 'pass', 'verify', 'module:timer');   // 缺省白名单命中
    expect(ctx.eventStore.getByFamily('task').filter(e => e.subtype === 'created')).toHaveLength(1);
    publishNodeJudged(ctx.bus, 't-src', 'pass', 'verify', 'human:u1');       // human 不在缺省白名单
    const skipped = ctx.eventStore.getByFamily('admin').filter(e => e.subtype === 'automationSkipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].payload.reason).toBe('subject-not-allowed');
    ctx.stop();
  });

  it('来源不在 allowlist → automationSkipped(subject-not-allowed)，不执行动作', () => {
    const rule: AutomationRule = { ...archiveRule, subjectAllowlist: ['module:timer'] };
    const ctx = makeCtx([rule]);
    ctx.engine.start();
    publishNodeJudged(ctx.bus, 't-src');
    const skipped = ctx.eventStore.getByFamily('admin').filter(e => e.subtype === 'automationSkipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].payload.reason).toBe('subject-not-allowed');
    expect(ctx.eventStore.getByFamily('task').filter(e => e.subtype === 'created')).toHaveLength(0);
    ctx.stop();
  });

  it('冷却期内二触 → skipped(cooldown)；跨窗口后恢复执行', () => {
    const ctx = makeCtx([archiveRule]);
    ctx.engine.start();
    ctx.bus.publish({
      seq: null, timestamp: Date.now(), subject: { kind: 'human', userId: 'u1' },
      family: 'task', subtype: 'created', handles: { taskId: 't-src', workspaceId: 'ws-1' },
      payload: { taskType: 'normal', goal: '源', priority: 5, workspaceId: 'ws-1' }, value: null,
    });
    publishNodeJudged(ctx.bus, 't-src');
    ctx.setNow(1_000_000 + 1000);           // 窗口内（cooldownSec=60）
    publishNodeJudged(ctx.bus, 't-src');
    let skipped = ctx.eventStore.getByFamily('admin').filter(e => e.subtype === 'automationSkipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].payload.reason).toBe('cooldown');
    ctx.setNow(1_000_000 + 61_000);          // 跨窗口
    publishNodeJudged(ctx.bus, 't-src');
    skipped = ctx.eventStore.getByFamily('admin').filter(e => e.subtype === 'automationSkipped');
    expect(skipped).toHaveLength(1);         // 不再新增
    ctx.stop();
  });

  it('trackDepth 链式：事件自带 depth 逐代 +1，gen3 depth3 > maxDepth=2 → skipped(max-depth)', () => {
    const ctx = makeCtx([archiveRule]);
    ctx.engine.start();
    publishNodeJudged(ctx.bus, 't-src');                       // 源事件无 depth → gen1 depth=1
    let created = ctx.eventStore.getByFamily('task').filter(e => e.subtype === 'created' && e.subject.kind === 'module');
    const gen1 = created[0].handles.taskId;
    expect(created[0].payload.regenerationDepth).toBe(1);
    // gen1 被人工判定（subject 在 allowlist 内），事件 payload 自带上一代 depth=1 → 再生 gen2 depth=2
    ctx.setNow(1_000_000 + 61_000);            // 跨冷却窗口
    ctx.bus.publish({
      seq: null, timestamp: Date.now(), subject: { kind: 'human', userId: 'u1' },
      family: 'task', subtype: 'nodeJudged', handles: { taskId: gen1 },
      payload: { result: 'pass', nodeKey: 'verify', judgeNote: '', regenerationDepth: 1 },
      value: null,
    });
    created = ctx.eventStore.getByFamily('task').filter(e => e.subtype === 'created' && e.subject.kind === 'module');
    expect(created).toHaveLength(2);
    const gen2 = created[1].handles.taskId;
    expect(created[1].payload.regenerationDepth).toBe(2);
    // gen2 再次被人工判定，事件自带 depth=2 → 再算出 3 > maxDepth → 跳过
    ctx.setNow(1_000_000 + 122_000);           // 跨冷却窗口
    ctx.bus.publish({
      seq: null, timestamp: Date.now(), subject: { kind: 'human', userId: 'u1' },
      family: 'task', subtype: 'nodeJudged', handles: { taskId: gen2 },
      payload: { result: 'pass', nodeKey: 'verify', judgeNote: '', regenerationDepth: 2 },
      value: null,
    });
    created = ctx.eventStore.getByFamily('task').filter(e => e.subtype === 'created' && e.subject.kind === 'module');
    expect(created).toHaveLength(2);
    const skipped = ctx.eventStore.getByFamily('admin').filter(e => e.subtype === 'automationSkipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].payload.reason).toBe('max-depth');
    expect(skipped[0].payload.depth).toBe(3);
    ctx.stop();
  });

  it('门禁拒绝 → skipped(action-error)，不崩引擎', () => {
    const ctx = makeCtx([archiveRule], []);   // 无任何放行规则
    ctx.engine.start();
    publishNodeJudged(ctx.bus, 't-src');
    const skipped = ctx.eventStore.getByFamily('admin').filter(e => e.subtype === 'automationSkipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].payload.reason).toBe('action-error');
    ctx.stop();
  });

  it('定时规则：tick 触发 → timerFired 落库（reason=automationSchedule）→ 消费执行 wake', () => {
    const rule: AutomationRule = {
      ruleId: 'historian-hourly',
      trigger: { type: 'schedule', intervalSec: 3600 },
      action: { type: 'wake', agentId: 'historian' },
      enabled: true,
    };
    const ctx = makeCtx([rule]);
    ctx.engine.start();
    expect(ctx.timers).toHaveLength(1);
    ctx.tick(0);
    const fired = ctx.eventStore.getByFamily('schedule').filter(e => e.subtype === 'timerFired');
    expect(fired).toHaveLength(1);
    expect(fired[0].payload).toEqual({ ruleId: 'historian-hourly', reason: 'automationSchedule' });
    expect(ctx.wakeCalls).toEqual([{
      subject: 'module:automation', agentId: 'historian', command: 'wake',
      payload: { ruleId: 'historian-hourly', reason: 'automationSchedule' },
    }]);
    ctx.stop();
  });

  it('wake 动作缺 agentId → skipped(action-error)', () => {
    const rule: AutomationRule = {
      ruleId: 'bad-wake', trigger: { type: 'schedule', intervalSec: 1 },
      action: { type: 'wake' }, enabled: true,
    };
    const ctx = makeCtx([rule]);
    ctx.engine.start();
    ctx.tick(0);
    const skipped = ctx.eventStore.getByFamily('admin').filter(e => e.subtype === 'automationSkipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].payload.reason).toBe('action-error');
    ctx.stop();
  });
});
