import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AdminCommands } from '../../src/services/admin/params.js';
import { PiercingCommands } from '../../src/services/admin/piercing.js';
import { PermissionCommands } from '../../src/services/admin/permissions.js';
import { FocusCommands } from '../../src/services/admin/focus.js';
import { ControlChannel } from '../../src/seam/control-channel.js';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import type { PermissionRule } from '../../src/core/permission/rule-loader.js';

function setup() {
  const eventStore = new EventStore(':memory:');
  const bus = new EventBus(eventStore);
  const rules: PermissionRule[] = [
    { subject: 'human:*', action: 'admin:setParam', object: '*', decision: 'allow' },
    { subject: 'human:*', action: 'admin:forceWake', object: '*', decision: 'allow' },
    { subject: 'human:*', action: 'admin:forceSleep', object: '*', decision: 'allow' },
    { subject: 'human:*', action: 'admin:setFocus', object: '*', decision: 'allow' },
    { subject: 'human:*', action: 'admin:setPermission', object: '*', decision: 'allow' },
    { subject: 'human:*', action: 'admin:toggleFullAuto', object: '*', decision: 'allow' },
    { subject: 'human:*', action: 'admin:pushConfig', object: '*', decision: 'allow' },
    { subject: 'agent:*', action: 'admin:*', object: '*', decision: 'deny' },
  ];
  const admin = new AdminCommands(bus, rules);
  // Phase 0 修复②：PiercingCommands 经 ControlChannel 真实下发（stub transport 只承接广播）
  const controlChannel = new ControlChannel(bus, {
    send: () => {}, sendTo: () => {}, onMessage: () => () => {}, onDisconnect: () => () => {}, close: () => {},
  } as any);
  const piercing = new PiercingCommands({ rules, controlChannel });
  const permissions = new PermissionCommands(bus, rules);
  const focus = new FocusCommands(bus, rules);
  return { eventStore, bus, admin, piercing, permissions, focus };
}

describe('AdminService 管理服务', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => { ctx.eventStore.close(); });

  it('setParam 产 paramChanged 事件', () => {
    const ack = ctx.admin.setParam('human:u1', 'agent.sleepCountdownSec', 60);
    expect(ack.seq).toBe(1);
    expect((ctx.eventStore.getByFamily('admin')[0].payload as any).key).toBe('agent.sleepCountdownSec');
  });

  it('forceWake 产 forceCommanded 事件', () => {
    const ack = ctx.admin.forceWake('human:u1', 'res-01');
    expect(ack.seq).toBe(1);
    expect((ctx.eventStore.getByFamily('admin')[0].payload as any).action).toBe('forceWake');
  });

  it('forceSleep 产 forceCommanded 事件', () => {
    const ack = ctx.admin.forceSleep('human:u1', 'res-01');
    expect(ack.seq).toBe(1);
  });

  it('setFocusBinding 产 focusBound 事件（经调度族）', () => {
    const ack = ctx.focus.setFocusBinding('human:u1', 'res-01', 'agg-1');
    expect(ack.seq).toBe(1);
    const events = ctx.eventStore.getByFamily('schedule');
    expect(events[0].subtype).toBe('focusBound');
  });

  it('setFocusBinding 解绑传 null', () => {
    const ack = ctx.focus.setFocusBinding('human:u1', 'res-01', null);
    expect(ack.seq).toBe(1);
  });

  it('setPermissionRule 产 permissionChanged 事件', () => {
    const ack = ctx.permissions.setPermissionRule('human:u1', {
      subject: 'agent:res-01', action: 'task:reportIssue', object: 'task:t1', decision: 'allow',
    });
    expect(ack.seq).toBe(1);
  });

  it('toggleFullAutomation 产 fullAutoToggled 事件', () => {
    const ack = ctx.admin.toggleFullAutomation('human:u1', true);
    expect(ack.seq).toBe(1);
  });

  it('pushModelConfig 产 piercingIssued 事件（含 commandId，经 ControlChannel 下发）', () => {
    const ack = ctx.piercing.pushModelConfig('human:u1', 'res-01', { model: 'gpt-4' });
    expect(ack.seq).toBe(1);
    const payload = (ctx.eventStore.getByFamily('admin')[0].payload as any);
    expect(payload.type).toBe('modelConfig');
    expect(payload.commandId).toBeTruthy();
    expect(payload.config).toEqual({ model: 'gpt-4' });
  });

  it('admin 命令对 agent 权限拒绝', () => {
    expect(() => ctx.admin.setParam('agent:res-01', 'x', 1)).toThrow('权限拒绝');
  });

  it('pushWhitelist 产 piercingIssued 事件', () => {
    const ack = ctx.piercing.pushWhitelist('human:u1', 'res-01', ['ls', 'cat']);
    expect(ack.seq).toBe(1);
  });

  it('Phase F.5：removePermissionRule 发布 permissionRemoved（载荷只带 ruleId）', () => {
    ctx.permissions.setPermissionRule('human:u1', {
      subject: 'agent:res-01', action: 'doc:read', object: '*', decision: 'allow',
    });
    ctx.permissions.removePermissionRule('human:u1', 'perm-agent_res-01-doc_read');
    const events = ctx.eventStore.getByFamily('admin');
    expect(events[events.length - 1].subtype).toBe('permissionRemoved');
    expect(events[events.length - 1].payload).toEqual({ ruleId: 'perm-agent_res-01-doc_read' });
  });

  it('Phase F.5：removePermissionRule 无权限拒绝不发事件', () => {
    const denyRules: PermissionRule[] = [
      { subject: 'human:*', action: 'admin:setPermission', object: '*', decision: 'deny' },
    ];
    const permissions = new PermissionCommands(ctx.bus, denyRules);
    expect(() => permissions.removePermissionRule('human:u1', 'r1')).toThrow('权限拒绝');
    expect(ctx.eventStore.getByFamily('admin').length).toBe(0);
  });
});
