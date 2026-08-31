import type { ProjectionsStore } from '../projections-store.js';
import type { StoredEventEnvelope } from '../../event-bus/envelope.js';

// 设计锚点 7.7：按 purposeId 串事件链
// 每条带有 purposeId 的事件按 seq 串成链，用于按目的重放

export class ReplayByPurposeProjection {
  initSchema(db: ProjectionsStore): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS events_by_purpose (
        purposeId TEXT NOT NULL,
        seq INTEGER NOT NULL,
        family TEXT NOT NULL,
        subtype TEXT NOT NULL,
        taskId TEXT,
        timestamp INTEGER,
        PRIMARY KEY (purposeId, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_purpose_seq ON events_by_purpose(purposeId, seq);
    `);
  }

  applyEvent(db: ProjectionsStore, env: StoredEventEnvelope): void {
    const purposeId = env.handles.purposeId;
    if (!purposeId) return;

    db.run(
      'INSERT INTO events_by_purpose (purposeId, seq, family, subtype, taskId, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
      purposeId, env.seq, env.family, env.subtype, env.handles.taskId ?? null, env.timestamp
    );
  }
}
