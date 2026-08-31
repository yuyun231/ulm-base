import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DocCommands } from '../../src/services/doc/read.js';
import { AdmissionCommands } from '../../src/services/doc/admission.js';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import type { PermissionRule } from '../../src/core/permission/rule-loader.js';

function setup() {
  const eventStore = new EventStore(':memory:');
  const bus = new EventBus(eventStore);
  const rules: PermissionRule[] = [
    { subject: 'agent:*', action: 'doc:read', object: '*', decision: 'allow' },
    { subject: 'human:*', action: 'doc:admit', object: '*', decision: 'allow' },
  ];
  const docCommands = new DocCommands(bus, rules);
  const admissionCommands = new AdmissionCommands(bus, rules);
  return { eventStore, bus, docCommands, admissionCommands };
}

describe('DocService 文档服务', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => { ctx.eventStore.close(); });

  it('read 产 docRead 事件（归调度族）', () => {
    const ack = ctx.docCommands.read('agent:res-01', 'memory/global', 'doc-1', 'v1');
    expect(ack.seq).toBe(1);
    const events = ctx.eventStore.getByFamily('schedule');
    expect(events[0].subtype).toBe('docRead');
  });

  it('admit 产 admitted 事件（归文档准入族）', () => {
    const ack = ctx.admissionCommands.admit('human:u1', 'knowledge', '/path/to/file.md', '准入依据');
    expect(ack.seq).toBe(1);
    const events = ctx.eventStore.getByFamily('doc');
    expect(events[0].subtype).toBe('admitted');
  });

  it('admit 记录作用域字段（5.2）', () => {
    const ack = ctx.admissionCommands.admit('human:u1', 'memory/agg', '/path/agg.md', '聚合记忆准入', 'agg-1');
    expect(ack.seq).toBe(1);
    const events = ctx.eventStore.getByFamily('doc');
    expect((events[0].payload as any).scopeTaskId).toBe('agg-1');
  });
});
