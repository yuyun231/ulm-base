import type { ProjectionsStore } from '../projections-store.js';
import type { StoredEventEnvelope } from '../../event-bus/envelope.js';

// 设计锚点 9.5：consults 投影表（F1 补完）
// 消费 consultInitiated / consultAnswered / consultRejected 事件
// 决策：补 initiatorAgentId / sourceDialogueId / sourceTaskId / targetAgentId 字段

export class ConsultsProjection {
  initSchema(db: ProjectionsStore): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS consults (
        consultId TEXT PRIMARY KEY,
        taskId TEXT,
        aggregateTaskId TEXT,
        initiatorAgentId TEXT,
        sourceDialogueId TEXT,
        sourceTaskId TEXT,
        targetAgentId TEXT,
        question TEXT,
        answer TEXT,
        state TEXT NOT NULL DEFAULT 'initiated',
        createdAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_consults_task ON consults(taskId);
      CREATE INDEX IF NOT EXISTS idx_consults_initiator ON consults(initiatorAgentId);
      CREATE INDEX IF NOT EXISTS idx_consults_target ON consults(targetAgentId);
    `);
  }

  applyEvent(db: ProjectionsStore, env: StoredEventEnvelope): void {
    if (env.family !== 'comm') return;
    const taskId = env.handles.taskId;
    if (!taskId) return;

    switch (env.subtype) {
      case 'consultInitiated': {
        const p = env.payload as any;
        db.run(
          `INSERT INTO consults (consultId, taskId, aggregateTaskId, initiatorAgentId, sourceDialogueId, sourceTaskId, targetAgentId, question, state, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'initiated', ?)`,
          taskId, taskId,
          p.aggregateTaskId ?? null,
          p.initiatorAgentId ?? null,
          p.sourceDialogueId ?? null,
          p.sourceTaskId ?? null,
          p.targetAgentId ?? null,
          p.question ?? null,
          env.timestamp
        );
        break;
      }
      case 'consultAnswered': {
        const p = env.payload as any;
        db.run(
          `UPDATE consults SET state = 'answered', answer = ? WHERE consultId = ?`,
          p.answer ?? null, taskId
        );
        break;
      }
      case 'consultRejected': {
        const p = env.payload as any;
        db.run(
          `UPDATE consults SET state = 'rejected', answer = ? WHERE consultId = ?`,
          p.reason ?? null, taskId
        );
        break;
      }
    }
  }
}
