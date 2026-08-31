import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConsultCommands } from '../../src/services/comm/consult.js';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import type { PermissionRule } from '../../src/core/permission/rule-loader.js';

function setup() {
  const eventStore = new EventStore(':memory:');
  const bus = new EventBus(eventStore);
  const rules: PermissionRule[] = [
    { subject: 'agent:*', action: 'comm:initiate', object: '*', decision: 'allow' },
    { subject: 'agent:*', action: 'comm:answer', object: '*', decision: 'allow' },
  ];
  const commands = new ConsultCommands(bus, rules);
  return { eventStore, bus, commands };
}

describe('ConsultCommands 征求决策命令', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => { ctx.eventStore.close(); });

  it('initiateConsult 产 consultInitiated 事件', () => {
    const ack = ctx.commands.initiateConsult('agent:res-01', 'task:t1', 'agg-1', '问题描述', 'res-01', 'dlg-1', 'subtask-1');
    expect(ack.seq).toBe(1);
  });

  it('initiateConsult 硬闸：无进行中子任务时拒绝', () => {
    // 硬闸校验：发起方必须持有该聚合任务的进行中子任务
    // 传 isSubtaskInProgress=false 时拒绝
    expect(() => ctx.commands.initiateConsult('agent:res-01', 'task:t1', 'agg-1', '问题', 'res-01', 'dlg-1', 'subtask-1', 'plan-assistant', false))
      .toThrow('硬闸');
  });

  it('submitConsultAnswer 产 consultAnswered 事件', () => {
    ctx.commands.initiateConsult('agent:res-01', 'task:t1', 'agg-1', '问题', 'res-01', 'dlg-1', 'subtask-1');
    const ack = ctx.commands.submitConsultAnswer('agent:plan-01', 'task:t1', '答案内容');
    expect(ack.seq).toBe(2);
  });

  it('initiateConsult 权限拒绝时不产事件', () => {
    const rules: PermissionRule[] = [
      { subject: 'agent:*', action: 'comm:initiate', object: '*', decision: 'deny' },
    ];
    const cmds = new ConsultCommands(ctx.bus, rules);
    expect(() => cmds.initiateConsult('agent:res-01', 'task:t1', 'agg-1', '问题', 'res-01', 'dlg-1', 'subtask-1')).toThrow('权限拒绝');
    expect(ctx.eventStore.getMaxSeq()).toBe(0);
  });
});
