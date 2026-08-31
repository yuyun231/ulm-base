import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PurposeCommands } from '../../../src/services/admin/purpose.js';
import { EventStore } from '../../../src/core/event-bus/store.js';
import { EventBus } from '../../../src/core/event-bus/bus.js';
import type { PermissionRule } from '../../../src/core/permission/rule-loader.js';

// 计划测试缺陷适配：checkPermission 空规则无匹配默认 deny（6.7 最小权限原则），
// 命令面测试须按 admin.test.ts 惯例给 allow 规则夹具，否则计划测试自身必挂
const rules: PermissionRule[] = [
  { subject: 'human:*', action: 'admin:createPurpose', object: '*', decision: 'allow' },
  { subject: 'human:*', action: 'admin:confirmPurpose', object: '*', decision: 'allow' },
  { subject: 'human:*', action: 'admin:launchPurpose', object: '*', decision: 'allow' },
];

describe('F10 目的命令面', () => {
  let eventStore: EventStore;
  let bus: EventBus;
  let cmds: PurposeCommands;

  beforeEach(() => {
    eventStore = new EventStore(':memory:');
    bus = new EventBus(eventStore);
    cmds = new PurposeCommands(bus, rules);
  });

  afterEach(() => { eventStore.close(); });

  it('createPurpose 产 purposeCreated 事件', () => {
    cmds.createPurpose('human:user-1', 'p1', 'dlg-1', '做一个工具');
    const events = eventStore.query("SELECT * FROM events WHERE subtype = 'purposeCreated'");
    expect(events.length).toBe(1);
    const payload = JSON.parse((events[0] as any).payload);
    expect(payload.description).toBe('做一个工具');
  });

  it('confirmPurpose 产 purposeConfirmed 事件', () => {
    cmds.createPurpose('human:user-1', 'p1', 'dlg-1', '做工具');
    cmds.confirmPurpose('human:user-1', 'p1', 'refining');
    const events = eventStore.query("SELECT * FROM events WHERE subtype = 'purposeConfirmed'");
    expect(events.length).toBe(1);
  });

  it('launchPurpose 产 purposeLaunched 事件', () => {
    cmds.createPurpose('human:user-1', 'p1', 'dlg-1', '做工具');
    cmds.confirmPurpose('human:user-1', 'p1', 'refining');
    cmds.confirmPurpose('human:user-1', 'p1', 'valueConfirmed');
    cmds.confirmPurpose('human:user-1', 'p1', 'pathConfirmed');
    cmds.confirmPurpose('human:user-1', 'p1', 'detailsReady');
    cmds.launchPurpose('human:user-1', 'p1', 'task-1');
    const events = eventStore.query("SELECT * FROM events WHERE subtype = 'purposeLaunched'");
    expect(events.length).toBe(1);
  });
});
