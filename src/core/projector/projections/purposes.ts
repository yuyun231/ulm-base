import type { ProjectionsStore } from '../projections-store.js';
import type { StoredEventEnvelope } from '../../event-bus/envelope.js';

// 设计锚点 7.5：目的＝状态机+目的对话
// 决策：状态机在基座，状态存投影表；目的不需要 git
// 状态：draft → refining → valueConfirmed → pathConfirmed → detailsReady → launched

const VALID_TRANSITIONS: Record<string, string> = {
  draft: 'refining',
  refining: 'valueConfirmed',
  valueConfirmed: 'pathConfirmed',
  pathConfirmed: 'detailsReady',
  detailsReady: 'launched',
};

export class PurposesProjection {
  initSchema(db: ProjectionsStore): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS purposes (
        purposeId TEXT PRIMARY KEY,
        taskId TEXT,
        dialogueId TEXT,
        description TEXT,
        state TEXT NOT NULL DEFAULT 'draft',
        createdAt INTEGER,
        updatedAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_purposes_task ON purposes(taskId);
      CREATE INDEX IF NOT EXISTS idx_purposes_state ON purposes(state);
    `);
  }

  applyEvent(db: ProjectionsStore, env: StoredEventEnvelope): void {
    if (env.family !== 'task') return;
    const purposeId = env.handles.purposeId;
    if (!purposeId) return;

    switch (env.subtype) {
      case 'purposeCreated': {
        const p = env.payload as any;
        db.run(
          `INSERT OR IGNORE INTO purposes (purposeId, dialogueId, description, state, createdAt, updatedAt)
           VALUES (?, ?, ?, 'draft', ?, ?)`,
          purposeId, p.dialogueId ?? null, p.description ?? null, env.timestamp, env.timestamp
        );
        break;
      }
      case 'purposeConfirmed': {
        const p = env.payload as any;
        const row = db.get('SELECT state FROM purposes WHERE purposeId = ?', purposeId) as any;
        if (row) {
          const targetState = p.confirmedState ?? VALID_TRANSITIONS[row.state];
          // 状态机约束：只允许合法转换
          if (VALID_TRANSITIONS[row.state] === targetState) {
            db.run('UPDATE purposes SET state = ?, updatedAt = ? WHERE purposeId = ?',
              targetState, env.timestamp, purposeId);
          }
        }
        break;
      }
      case 'purposeLaunched': {
        const row = db.get('SELECT state FROM purposes WHERE purposeId = ?', purposeId) as any;
        // 只能从 detailsReady 转为 launched
        if (row && row.state === 'detailsReady') {
          db.run('UPDATE purposes SET state = ?, taskId = ?, updatedAt = ? WHERE purposeId = ?',
            'launched', env.handles.taskId ?? null, env.timestamp, purposeId);
        }
        break;
      }
    }
  }
}
