import { describe, it, expect } from 'vitest';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import { TaskCommands } from '../../src/services/task/commands.js';
import { AutomationRules } from '../../src/core/scheduler/automation-rules.js';
import type { AutomationRule } from '../../src/config/loader.js';

describe('AutomationRules 热加载（admin.ruleChanged）', () => {
  it('ruleChanged → 重读文件：新规则生效旧规则失效；解析错误保旧表不崩', () => {
    const eventStore = new EventStore(':memory:');
    const bus = new EventBus(eventStore);
    const taskCommands = new TaskCommands(bus, [
      { subject: 'module:automation', action: 'task:create', object: '*', decision: 'allow' },
      { subject: 'module:automation', action: 'task:judge', object: '*', decision: 'require-approval' },
    ]);
    const controlChannel = { sendCommand: () => {} } as any;
    let fileRules: AutomationRule[] | 'BROKEN' = [];
    const engine = new AutomationRules({
      bus, taskCommands, controlChannel,
      loadRules: () => { if (fileRules === 'BROKEN') throw new Error('yaml parse error'); return fileRules; },
    });
    const ruleA: AutomationRule = {
      ruleId: 'rule-a', trigger: { type: 'event', family: 'task', subtype: 'nodeJudged' },
      subjectAllowlist: ['human:*'],
      action: { type: 'createTask', goal: 'A {taskId}', priority: 5 }, enabled: true,
    };
    const ruleB: AutomationRule = {
      ruleId: 'rule-b', trigger: { type: 'event', family: 'task', subtype: 'nodeSubmitted' },
      subjectAllowlist: ['human:*'],
      action: { type: 'createTask', goal: 'B {taskId}', priority: 5 }, enabled: true,
    };
    const fire = (subtype: string, taskId: string) => bus.publish({
      seq: null, timestamp: Date.now(), subject: { kind: 'human', userId: 'u1' },
      family: 'task', subtype, handles: { taskId }, payload: {}, value: null,
    });
    const created = () => eventStore.getByFamily('task').filter(e => e.subtype === 'created' && e.subject.kind === 'module');
    const skipped = () => eventStore.getByFamily('admin').filter(e => e.subtype === 'automationSkipped');

    engine.start();
    fileRules = [ruleA];
    bus.publish({ seq: null, timestamp: Date.now(), subject: { kind: 'module', module: 'panel' }, family: 'admin', subtype: 'ruleChanged', handles: {}, payload: {}, value: null });
    fire('nodeJudged', 't1');   // rule-a 命中
    expect(created()).toHaveLength(1);
    fire('nodeSubmitted', 't1'); // rule-b 尚未生效
    expect(created()).toHaveLength(1);

    fileRules = [ruleB];         // 面板改文件后提交 → ruleChanged
    bus.publish({ seq: null, timestamp: Date.now(), subject: { kind: 'module', module: 'panel' }, family: 'admin', subtype: 'ruleChanged', handles: {}, payload: {}, value: null });
    fire('nodeJudged', 't2');    // rule-a 已失效
    expect(created()).toHaveLength(1);
    fire('nodeSubmitted', 't2'); // rule-b 生效
    expect(created()).toHaveLength(2);

    fileRules = 'BROKEN';        // 文件语法坏了
    bus.publish({ seq: null, timestamp: Date.now(), subject: { kind: 'module', module: 'panel' }, family: 'admin', subtype: 'ruleChanged', handles: {}, payload: {}, value: null });
    expect(skipped().map(e => e.payload.reason)).toContain('parse-error');
    fire('nodeSubmitted', 't3'); // 旧规则表（rule-b）仍生效
    expect(created()).toHaveLength(3);

    engine.stop(); eventStore.close();
  });
});
