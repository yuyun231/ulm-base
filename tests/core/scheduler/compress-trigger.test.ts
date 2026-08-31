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
import type { TransportMessage } from '../../src/seam/transport.js';

describe('F2 压缩触发 — 对话原文存档', () => {
  let eventStore: EventStore;
  let bus: EventBus;
  let projStore: ProjectionsStore;
  let runner: ProjectionRunner;
  let rules: SchedulerRules;
  let controlChannel: ControlChannel;
  let gitAsset: GitAsset;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ulm-compress-test-'));
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
    // compressThreshold=3，传给 rules
    // Phase 0 修复③：调度器派发走命令面——测试配 module:scheduler 放行规则
    const taskCommands = new TaskCommands(bus, [
      { subject: 'module:scheduler', action: 'task:assign', object: '*', decision: 'allow' },
    ] as any);
    rules = new SchedulerRules(bus, projStore, gate, loadQueue, timer, controlChannel, taskCommands, {
      gitAsset,
      compressThreshold: 3,
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

  it('turn 数超过 compressThreshold → 对话原文写入 git archive/', () => {
    // 发 3 条 turn（threshold=3）
    for (let i = 0; i < 3; i++) {
      bus.publish({
        seq: null, timestamp: Date.now(),
        subject: { kind: 'agent', agentId: 'res-01' },
        family: 'dialogue', subtype: 'turnPosted',
        handles: { dialogueId: 'dlg-1' },
        payload: { channel: 'task', author: 'agent:res-01', content: `turn ${i + 1}` },
        value: null,
      });
    }

    // 验证：git archive/ 下有对话原文文件
    const archivePath = 'archive/dialogue/dlg-1';
    expect(gitAsset.fileExists(`${archivePath}/dialogue.txt`)).toBe(true);
    const content = gitAsset.readFile(`${archivePath}/dialogue.txt`);
    expect(content).toContain('turn 1');
    expect(content).toContain('turn 2');
    expect(content).toContain('turn 3');
  });

  it('压缩后产 admitted 事件（⑦文档准入族）', () => {
    for (let i = 0; i < 3; i++) {
      bus.publish({
        seq: null, timestamp: Date.now(),
        subject: { kind: 'agent', agentId: 'res-01' },
        family: 'dialogue', subtype: 'turnPosted',
        handles: { dialogueId: 'dlg-1' },
        payload: { channel: 'task', author: 'agent:res-01', content: `turn ${i + 1}` },
        value: null,
      });
    }

    // 验证：admitted 事件已落库
    const events = eventStore.query(
      "SELECT * FROM events WHERE family = 'doc' AND subtype = 'admitted' AND handles->>'dialogueId' = 'dlg-1'"
    );
    expect(events.length).toBeGreaterThan(0);
    const payload = JSON.parse((events[0] as any).payload);
    expect(payload.scope).toBe('archive:dialogue');
    expect(payload.filePath).toContain('archive/dialogue/dlg-1');
  });

  it('turn 数未超阈值时不触发存档', () => {
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'agent', agentId: 'res-01' },
      family: 'dialogue', subtype: 'turnPosted',
      handles: { dialogueId: 'dlg-2' },
      payload: { channel: 'task', author: 'agent:res-01', content: '只有一条' },
      value: null,
    });

    expect(gitAsset.fileExists('archive/dialogue/dlg-2/dialogue.txt')).toBe(false);
    const events = eventStore.query(
      "SELECT * FROM events WHERE family = 'doc' AND subtype = 'admitted' AND handles->>'dialogueId' = 'dlg-2'"
    );
    expect(events.length).toBe(0);
  });
});
