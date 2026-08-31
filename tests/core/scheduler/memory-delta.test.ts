import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import { ProjectionsStore } from '../../src/core/projector/projections-store.js';
import { ProjectionRunner } from '../../src/core/projector/runner.js';
import { SchedulerRules } from '../../src/core/scheduler/rules.js';
import { ConcurrencyGate } from '../../src/core/scheduler/concurrency-gate.js';
import { LoadQueue } from '../../src/core/scheduler/load-queue.js';
import { TimerService } from '../../src/core/scheduler/timer.js';
import { DialoguesProjection } from '../../src/core/projector/projections/dialogues.js';
import { createInMemoryPair } from '../../src/seam/in-memory-transport.js';
import { ControlChannel } from '../../src/seam/control-channel.js';
import { TaskCommands } from '../../src/services/task/commands.js';
import { GitAsset } from '../../src/core/git-asset.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('F3 记忆水印 delta 注入', () => {
  let eventStore: EventStore;
  let bus: EventBus;
  let projStore: ProjectionsStore;
  let runner: ProjectionRunner;
  let rules: SchedulerRules;
  let controlChannel: ControlChannel;
  let gitAsset: GitAsset;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ulm-delta-test-'));
    gitAsset = new GitAsset(tmpDir);
    gitAsset.initRepo();

    eventStore = new EventStore(':memory:');
    bus = new EventBus(eventStore);
    projStore = new ProjectionsStore(':memory:');
    runner = new ProjectionRunner(bus, eventStore, projStore, [new DialoguesProjection()]);
    runner.start();

    const { server } = createInMemoryPair();
    controlChannel = new ControlChannel(bus, server);
    controlChannel.start();

    const gate = new ConcurrencyGate(4);
    const loadQueue = new LoadQueue();
    const timer = new TimerService(bus, {
      sleepCountdownSec: 60, heartbeatIntervalSec: 30, heartbeatTimeoutSec: 90,
    });
    // Phase 0 修复③：调度器派发走命令面——测试配 module:scheduler 放行规则
    const taskCommands = new TaskCommands(bus, [
      { subject: 'module:scheduler', action: 'task:assign', object: '*', decision: 'allow' },
    ] as any);
    rules = new SchedulerRules(bus, projStore, gate, loadQueue, timer, controlChannel, taskCommands, {
      gitAsset,
      compressThreshold: 100, // 高阈值避免触发 F2
      injectInlineMaxBytes: 4096,
    });
    rules.start();
  });

  afterEach(() => {
    rules.stop();
    controlChannel.stop();
    runner.stop();
    projStore.close();
    eventStore.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('对话有 subscription → turnPosted 时检测 delta → 有新条目则产 docRead 事件', () => {
    // 1. 在 git memory/agg/task-1/ 下写两条记忆条目
    gitAsset.writeAndCommit('memory/agg/task-1/entry-1.md', '# 条目1\n这是第一条记忆', 'test: add entry-1');
    gitAsset.writeAndCommit('memory/agg/task-1/entry-2.md', '# 条目2\n这是第二条记忆', 'test: add entry-2');

    // 2. 开对话时带 subscription（scope = agg:task-1）
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'user-1' },
      family: 'dialogue', subtype: 'turnPosted',
      handles: { dialogueId: 'dlg-1' },
      payload: {
        channel: 'task', author: 'human:user-1', content: '开始任务',
        subscription: { scope: 'agg:task-1', agentId: 'res-01' },
      },
      value: null,
    });

    // 3. 验证：docRead 事件已落库（delta 含两条记忆）
    const events = eventStore.query(
      "SELECT * FROM events WHERE family = 'schedule' AND subtype = 'docRead' AND handles->>'dialogueId' = 'dlg-1'"
    );
    expect(events.length).toBeGreaterThan(0);
    const payload = JSON.parse((events[0] as any).payload);
    expect(payload.scope).toBe('agg:task-1');
    expect(payload.content).toContain('条目1');
    expect(payload.content).toContain('条目2');
  });

  it('无新 delta 时不产 docRead 事件', () => {
    // 1. 写一条记忆
    gitAsset.writeAndCommit('memory/agg/task-1/entry-1.md', '# 条目1', 'test: add entry-1');

    // 2. 开对话带 subscription
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'user-1' },
      family: 'dialogue', subtype: 'turnPosted',
      handles: { dialogueId: 'dlg-1' },
      payload: {
        channel: 'task', author: 'human:user-1', content: '开始',
        subscription: { scope: 'agg:task-1', agentId: 'res-01' },
      },
      value: null,
    });
    // 第一条 turn 会注入 delta（因为 watermark 为空）
    // 记录第一次的 docRead 数量
    const firstDelta = eventStore.query(
      "SELECT * FROM events WHERE family = 'schedule' AND subtype = 'docRead' AND handles->>'dialogueId' = 'dlg-1'"
    );

    // 3. 发第二条 turn（无新记忆）
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'agent', agentId: 'res-01' },
      family: 'dialogue', subtype: 'turnPosted',
      handles: { dialogueId: 'dlg-1' },
      payload: { channel: 'task', author: 'agent:res-01', content: '收到' },
      value: null,
    });

    // 4. 验证：第二条 turn 不产新的 docRead（delta 为空）
    const secondDelta = eventStore.query(
      "SELECT * FROM events WHERE family = 'schedule' AND subtype = 'docRead' AND handles->>'dialogueId' = 'dlg-1'"
    );
    expect(secondDelta.length).toBe(firstDelta.length); // 无新增
  });

  it('新增记忆条目后下次 turnPosted 注入 delta', () => {
    // 1. 写一条记忆
    gitAsset.writeAndCommit('memory/agg/task-1/entry-1.md', '# 条目1', 'test: add entry-1');

    // 2. 开对话带 subscription
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'user-1' },
      family: 'dialogue', subtype: 'turnPosted',
      handles: { dialogueId: 'dlg-1' },
      payload: {
        channel: 'task', author: 'human:user-1', content: '开始',
        subscription: { scope: 'agg:task-1', agentId: 'res-01' },
      },
      value: null,
    });

    // 3. 新增一条记忆
    gitAsset.writeAndCommit('memory/agg/task-1/entry-2.md', '# 条目2\n新记忆', 'test: add entry-2');

    // 4. 发第二条 turn
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'agent', agentId: 'res-01' },
      family: 'dialogue', subtype: 'turnPosted',
      handles: { dialogueId: 'dlg-1' },
      payload: { channel: 'task', author: 'agent:res-01', content: '继续' },
      value: null,
    });

    // 5. 验证：第二次 turn 产了新的 docRead，delta 含 entry-2
    const events = eventStore.query(
      "SELECT * FROM events WHERE family = 'schedule' AND subtype = 'docRead' AND handles->>'dialogueId' = 'dlg-1'"
    );
    expect(events.length).toBeGreaterThanOrEqual(2);
    // 最后一条 docRead 的 payload 应含 entry-2
    const lastPayload = JSON.parse((events[events.length - 1] as any).payload);
    expect(lastPayload.content).toContain('新记忆');
  });

  it('对话无 subscription 时不触发 delta 注入', () => {
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'agent', agentId: 'res-01' },
      family: 'dialogue', subtype: 'turnPosted',
      handles: { dialogueId: 'dlg-1' },
      payload: { channel: 'task', author: 'agent:res-01', content: '无订阅的对话' },
      value: null,
    });

    const events = eventStore.query(
      "SELECT * FROM events WHERE family = 'schedule' AND subtype = 'docRead' AND handles->>'dialogueId' = 'dlg-1'"
    );
    expect(events.length).toBe(0);
  });
});
