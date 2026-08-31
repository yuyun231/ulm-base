import type { EventBus } from '../../core/event-bus/bus.js';
import type { PermissionRule } from '../../core/permission/rule-loader.js';
import { checkPermission } from '../../core/permission/check.js';
import type { EventEnvelope } from '../../core/event-bus/envelope.js';
import type { ProjectionsStore } from '../../core/projector/projections-store.js';

// 设计锚点 3.9：查阅即调度，产 docRead 事件归③调度族（非 doc 族）

function parseSubject(s: string): EventEnvelope['subject'] {
  const [kind, id] = s.split(':');
  if (kind === 'agent') return { kind: 'agent', agentId: id };
  if (kind === 'human') return { kind: 'human', userId: id };
  return { kind: 'module', module: id };
}

export class DocCommands {
  private bus: EventBus;
  private rules: PermissionRule[];
  constructor(bus: EventBus, rules: PermissionRule[]) { this.bus = bus; this.rules = rules; }

  // 3.9 查阅：产 docRead 调度事件
  read(subject: string, scope: string, docId: string, version: string) {
    const perm = checkPermission(this.rules, subject, 'doc:read', `doc:${docId}`);
    if (perm.decision === 'deny') throw new Error(`权限拒绝：${subject} 不可查阅 doc:${docId}`);
    return this.bus.publish({
      seq: null, timestamp: Date.now(),
      subject: parseSubject(subject),
      family: 'schedule', subtype: 'docRead',
      handles: {}, payload: { scope, docId, version }, value: null,
    });
  }
}

// 9.2 查询清单：delta(agentId,scope) / watermarks
export class DocQueries {
  private projStore: ProjectionsStore;
  constructor(projStore: ProjectionsStore) { this.projStore = projStore; }

  // F3 补完：从水印 seq 之后获取 delta 事件
  delta(agentId: string, scope: string): any[] {
    try { return this.projStore.all('SELECT * FROM dialogues WHERE scope = ? AND agentId = ?', scope, agentId); }
    catch { return []; }
  }

  // F3 补完：查询 agent 的所有水印
  watermarks(agentId: string): any[] {
    try { return this.projStore.all('SELECT * FROM dialogues WHERE agentId = ?', agentId); }
    catch { return []; }
  }
}
