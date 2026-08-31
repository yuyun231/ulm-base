import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConsultCommands, ConsultQueries } from '../../src/services/comm/consult.js';
import { DocCommands, DocQueries } from '../../src/services/doc/read.js';
import { DialogueCommands, DialogueQueries } from '../../src/services/dialogue/channels.js';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import { ProjectionsStore } from '../../src/core/projector/projections-store.js';
import type { PermissionRule } from '../../src/core/permission/rule-loader.js';

function setup() {
  const eventStore = new EventStore(':memory:');
  const bus = new EventBus(eventStore);
  const projStore = new ProjectionsStore(':memory:');
  const rules: PermissionRule[] = [
    { subject: 'agent:*', action: 'comm:initiate', object: '*', decision: 'allow' },
    { subject: 'agent:*', action: 'doc:read', object: '*', decision: 'allow' },
    { subject: 'human:*', action: 'dialogue:open', object: '*', decision: 'allow' },
  ];
  const consultCmd = new ConsultCommands(bus, rules);
  const consultQ = new ConsultQueries(projStore);
  const docCmd = new DocCommands(bus, rules);
  const docQ = new DocQueries(projStore);
  const dialogueCmd = new DialogueCommands(bus, rules);
  const dialogueQ = new DialogueQueries(projStore);
  return { eventStore, bus, projStore, consultCmd, consultQ, docCmd, docQ, dialogueCmd, dialogueQ };
}

describe('缺失查询面补全', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => { ctx.projStore.close(); ctx.eventStore.close(); });

  it('ConsultQueries.consultDetail 查询', () => {
    ctx.consultCmd.initiateConsult('agent:res-01', 't1', 'agg-1', '问题', 'res-01', 'dlg-1', 'subtask-1');
    // 查询返回 undefined（投影表首版未实现 consults 表，查询语法合法即可）
    const detail = ctx.consultQ.consultDetail('t1');
    expect(detail).toBeUndefined(); // 首版 consults 投影表占位，F1 补完
  });

  it('DocQueries.delta 查询', () => {
    const delta = ctx.docQ.delta('res-01', 'memory/global');
    expect(delta).toEqual([]); // 首版返回空（F3 补完水印 delta 注入）
  });

  it('DocQueries.watermarks 查询', () => {
    const wms = ctx.docQ.watermarks('res-01');
    expect(wms).toEqual([]); // 首版返回空（F3 补完）
  });

  it('DialogueQueries.dialogueDetail 查询', () => {
    ctx.dialogueCmd.openDialogue('human:u1', 'd1', 'user', '你好');
    const detail = ctx.dialogueQ.dialogueDetail('d1');
    expect(detail).toBeUndefined(); // 首版 dialogues 投影表占位
  });

  it('DialogueQueries.mode 查询', () => {
    ctx.dialogueCmd.openDialogue('human:u1', 'd1', 'user', '你好');
    const mode = ctx.dialogueQ.mode('d1');
    expect(mode).toBeUndefined(); // 首版返回 undefined（F2 补完双模式）
  });
});
