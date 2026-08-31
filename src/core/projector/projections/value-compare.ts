import type { ProjectionsStore } from '../projections-store.js';
import type { StoredEventEnvelope } from '../../event-bus/envelope.js';

// 设计锚点 7.12：价值对抗区＝对照 projection
// 决策：value-compare 表存 taskId/purposeId/裁决结果/时间，LLM 原文存 git archive/
// 两层：记录沉淀层（LLM原文指针）+ 实际调度层（裁决结果）

export class ValueCompareProjection {
  initSchema(db: ProjectionsStore): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS value_compare (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        taskId TEXT,
        purposeId TEXT,
        requestPayload TEXT,
        resultPayload TEXT,
        verdict TEXT,
        rawArchivePath TEXT,
        requestedAt INTEGER,
        judgedAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_vc_task ON value_compare(taskId);
      CREATE INDEX IF NOT EXISTS idx_vc_purpose ON value_compare(purposeId);
    `);
  }

  applyEvent(db: ProjectionsStore, env: StoredEventEnvelope): void {
    if (env.family !== 'admin') return;

    switch (env.subtype) {
      case 'piercingIssued': {
        const p = env.payload as any;
        if (p.type !== 'judgeRequest') return;
        db.run(
          `INSERT INTO value_compare (taskId, purposeId, requestPayload, requestedAt)
           VALUES (?, ?, ?, ?)`,
          env.handles.taskId ?? null,
          env.handles.purposeId ?? null,
          JSON.stringify(p),
          env.timestamp
        );
        break;
      }
      case 'piercingAcked': {
        const p = env.payload as any;
        // 更新最近一条未裁决的记录
        const row = db.get(
          'SELECT id FROM value_compare WHERE taskId = ? AND verdict IS NULL ORDER BY id DESC LIMIT 1',
          env.handles.taskId ?? ''
        ) as any;
        if (row) {
          db.run(
            `UPDATE value_compare SET resultPayload = ?, verdict = ?, rawArchivePath = ?, judgedAt = ? WHERE id = ?`,
            JSON.stringify(p),
            p.result ?? (p.success ? 'agree' : 'disagree'),
            p.rawOutput ? `archive/judge/${env.handles.taskId}/${row.id}.txt` : null,
            env.timestamp,
            row.id
          );
        }
        break;
      }
    }
  }
}
