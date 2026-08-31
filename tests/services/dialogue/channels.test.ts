import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DialogueCommands } from '../../src/services/dialogue/channels.js';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import type { PermissionRule } from '../../src/core/permission/rule-loader.js';

function setup() {
  const eventStore = new EventStore(':memory:');
  const bus = new EventBus(eventStore);
  const rules: PermissionRule[] = [
    { subject: 'human:*', action: 'dialogue:open', object: '*', decision: 'allow' },
    { subject: 'human:*', action: 'dialogue:post', object: '*', decision: 'allow' },
    { subject: 'agent:*', action: 'dialogue:post', object: '*', decision: 'allow' },
  ];
  const commands = new DialogueCommands(bus, rules);
  return { eventStore, bus, commands };
}

describe('DialogueCommands 对话服务', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => { ctx.eventStore.close(); });

  it('openDialogue 产 turnPosted 事件（user 通道）', () => {
    const ack = ctx.commands.openDialogue('human:u1', 'd1', 'user', '你好');
    expect(ack.seq).toBe(1);
    const events = ctx.eventStore.getByFamily('dialogue');
    expect((events[0].payload as any).channel).toBe('user');
  });

  it('postTurn 产 turnPosted 事件（task 通道）', () => {
    ctx.commands.openDialogue('human:u1', 'd1', 'user', '你好');
    const ack = ctx.commands.postTurn('agent:res-01', 'd1', 'task', '任务对话内容');
    expect(ack.seq).toBe(2);
    const events = ctx.eventStore.getByFamily('dialogue');
    expect((events[1].payload as any).channel).toBe('task');
  });

  it('postTurn plan 通道', () => {
    ctx.commands.openDialogue('human:u1', 'd1', 'user', '你好');
    const ack = ctx.commands.postTurn('agent:plan-01', 'd1', 'plan', '方案对话内容');
    expect(ack.seq).toBe(2);
    expect((ctx.eventStore.getByFamily('dialogue')[1].payload as any).channel).toBe('plan');
  });

  it('openDialogue 权限拒绝时不产事件', () => {
    const rules: PermissionRule[] = [
      { subject: 'agent:*', action: 'dialogue:open', object: '*', decision: 'deny' },
    ];
    const cmds = new DialogueCommands(ctx.bus, rules);
    expect(() => cmds.openDialogue('agent:res-01', 'd1', 'task', 'x')).toThrow('权限拒绝');
    expect(ctx.eventStore.getMaxSeq()).toBe(0);
  });
});
