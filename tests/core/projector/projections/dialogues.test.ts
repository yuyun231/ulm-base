import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProjectionsStore } from '../../../src/core/projector/projections-store.js';
import { DialoguesProjection } from '../../../src/core/projector/projections/dialogues.js';
import { EventStore } from '../../../src/core/event-bus/store.js';
import { EventBus } from '../../../src/core/event-bus/bus.js';
import { ProjectionRunner } from '../../../src/core/projector/runner.js';
import type { StoredEventEnvelope } from '../../../src/core/event-bus/envelope.js';

function makeDialogueEvent(seq: number, handles: object = {}, payload: object = {}): StoredEventEnvelope {
  return { seq, timestamp: Date.now(), subject: { kind: 'agent', agentId: 'res-01' }, family: 'dialogue', subtype: 'turnPosted', handles, payload, value: null } as StoredEventEnvelope;
}

describe('DialoguesProjection 对话投影', () => {
  let projStore: ProjectionsStore;
  let proj: DialoguesProjection;

  beforeEach(() => {
    projStore = new ProjectionsStore(':memory:');
    proj = new DialoguesProjection();
    proj.initSchema(projStore);
  });

  it('turnPosted 事件写入对话轮次记录', () => {
    proj.applyEvent(projStore, makeDialogueEvent(1,
      { dialogueId: 'dlg-1' },
      { channel: 'task', content: '你好', author: 'res-01' } as any));
    const turns = projStore.all('SELECT * FROM dialogue_turns WHERE dialogueId = ?', 'dlg-1') as any[];
    expect(turns).toHaveLength(1);
    expect(turns[0].channel).toBe('task');
    expect(turns[0].content).toBe('你好');
  });

  it('多条 turnPosted 按序号排列', () => {
    proj.applyEvent(projStore, makeDialogueEvent(1, { dialogueId: 'dlg-1' }, { channel: 'task', content: '第一条' } as any));
    proj.applyEvent(projStore, makeDialogueEvent(2, { dialogueId: 'dlg-1' }, { channel: 'task', content: '第二条' } as any));
    proj.applyEvent(projStore, makeDialogueEvent(3, { dialogueId: 'dlg-1' }, { channel: 'task', content: '第三条' } as any));
    const turns = projStore.all('SELECT * FROM dialogue_turns WHERE dialogueId = ? ORDER BY seq', 'dlg-1') as any[];
    expect(turns).toHaveLength(3);
    expect(turns[2].content).toBe('第三条');
  });

  it('无 dialogueId 的事件不处理', () => {
    proj.applyEvent(projStore, makeDialogueEvent(1, {}, { channel: 'task' } as any));
    expect(projStore.all('SELECT * FROM dialogue_turns')).toHaveLength(0);
  });

  it('非对话族事件不处理', () => {
    proj.applyEvent(projStore, { ...makeDialogueEvent(1, { dialogueId: 'dlg-1' }, { channel: 'task' } as any), family: 'task', subtype: 'created' } as any);
    expect(projStore.all('SELECT * FROM dialogue_turns')).toHaveLength(0);
  });
});

// ===== F2/F3 补完：dialogues 主表（watermark/memoryScope/turnCount）=====
describe('DialoguesProjection F2/F3 补完 — dialogues 主表', () => {
  let projStore: ProjectionsStore;
  let eventStore: EventStore;
  let bus: EventBus;
  let runner: ProjectionRunner;

  beforeEach(() => {
    projStore = new ProjectionsStore(':memory:');
    eventStore = new EventStore(':memory:');
    bus = new EventBus(eventStore);
    runner = new ProjectionRunner(bus, eventStore, projStore, [new DialoguesProjection()]);
    runner.start();
  });

  afterEach(() => {
    runner.stop();
    projStore.close();
    eventStore.close();
  });

  it('首条 turnPosted 创建 dialogues 主表记录', () => {
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'agent', agentId: 'res-01' },
      family: 'dialogue', subtype: 'turnPosted',
      handles: { dialogueId: 'dlg-1' },
      payload: { channel: 'task', author: 'agent:res-01', content: '你好' },
      value: null,
    });

    const row = projStore.get('SELECT * FROM dialogues WHERE dialogueId = ?', 'dlg-1') as any;
    expect(row).toBeTruthy();
    expect(row.turnCount).toBe(1);
    expect(row.mode).toBe('B'); // 默认单任务单对话
  });

  it('后续 turnPosted 递增 turnCount', () => {
    for (let i = 0; i < 3; i++) {
      bus.publish({
        seq: null, timestamp: Date.now(),
        subject: { kind: 'agent', agentId: 'res-01' },
        family: 'dialogue', subtype: 'turnPosted',
        handles: { dialogueId: 'dlg-1' },
        payload: { channel: 'task', author: 'agent:res-01', content: `turn ${i}` },
        value: null,
      });
    }

    const row = projStore.get('SELECT * FROM dialogues WHERE dialogueId = ?', 'dlg-1') as any;
    expect(row.turnCount).toBe(3);
  });

  it('turnPosted 带 subscription payload 时写入 memoryScope + watermark', () => {
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'user-1' },
      family: 'dialogue', subtype: 'turnPosted',
      handles: { dialogueId: 'dlg-1' },
      payload: {
        channel: 'system', content: '',
        subscription: { scope: 'agg:task-1', agentId: 'res-01' },
      },
      value: null,
    });

    const row = projStore.get('SELECT * FROM dialogues WHERE dialogueId = ?', 'dlg-1') as any;
    expect(row.memoryScope).toBe('agg:task-1');
    expect(row.watermark).toBe(''); // 初始水印为空字符串
  });

  it('dialogue_turns 表仍正常记录每条 turn（向后兼容）', () => {
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'agent', agentId: 'res-01' },
      family: 'dialogue', subtype: 'turnPosted',
      handles: { dialogueId: 'dlg-1' },
      payload: { channel: 'task', author: 'agent:res-01', content: 'turn1' },
      value: null,
    });

    const turns = projStore.all('SELECT * FROM dialogue_turns WHERE dialogueId = ?', 'dlg-1');
    expect(turns).toHaveLength(1);
    expect((turns[0] as any).content).toBe('turn1');
  });
});
