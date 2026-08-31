import type { ProjectionsStore } from '../projections-store.js';
import type { StoredEventEnvelope } from '../../event-bus/envelope.js';

// 设计锚点 9.5：guidances 投影表（F5 补完）
// 消费 guidanceIssued / guidanceInjected / guidanceAcked / guidanceClosed 事件
// 7.10 双投递：now=立即 inject；future=存任务载荷
// 7.11 闭环：injected→acked→closed

export class GuidancesProjection {
  initSchema(db: ProjectionsStore): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS guidances (
        guidanceId TEXT PRIMARY KEY,
        taskId TEXT,
        issuedBy TEXT,
        content TEXT,
        type TEXT NOT NULL DEFAULT 'now',
        state TEXT NOT NULL DEFAULT 'issued',
        ackNote TEXT,
        createdAt INTEGER,
        injectedAt INTEGER,
        ackedAt INTEGER,
        closedAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_guidances_task ON guidances(taskId);
      CREATE INDEX IF NOT EXISTS idx_guidances_state ON guidances(state);
    `);
  }

  applyEvent(db: ProjectionsStore, env: StoredEventEnvelope): void {
    if (env.family !== 'task') return;
    const taskId = env.handles.taskId;
    if (!taskId) return;

    switch (env.subtype) {
      case 'guidanceIssued': {
        const p = env.payload as any;
        const subjectStr = env.subject.kind === 'agent' ? `agent:${env.subject.agentId}`
          : env.subject.kind === 'human' ? `human:${env.subject.userId}`
          : `module:${env.subject.module}`;
        db.run(
          `INSERT INTO guidances (guidanceId, taskId, issuedBy, content, type, state, createdAt)
           VALUES (?, ?, ?, ?, ?, 'issued', ?)`,
          p.guidanceId, taskId, subjectStr,
          p.content ?? null, p.type ?? 'now', env.timestamp
        );
        break;
      }
      case 'guidanceInjected': {
        const p = env.payload as any;
        db.run(
          `UPDATE guidances SET state = 'injected', injectedAt = ? WHERE guidanceId = ?`,
          env.timestamp, p.guidanceId
        );
        break;
      }
      case 'guidanceAcked': {
        const p = env.payload as any;
        db.run(
          `UPDATE guidances SET state = 'acked', ackNote = ?, ackedAt = ? WHERE guidanceId = ?`,
          p.ackNote ?? null, env.timestamp, p.guidanceId
        );
        break;
      }
      case 'guidanceClosed': {
        const p = env.payload as any;
        db.run(
          `UPDATE guidances SET state = 'closed', closedAt = ? WHERE guidanceId = ?`,
          env.timestamp, p.guidanceId
        );
        break;
      }
    }
  }
}
