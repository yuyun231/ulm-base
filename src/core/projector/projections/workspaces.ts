import type { ProjectionsStore } from '../projections-store.js';
import type { StoredEventEnvelope } from '../../event-bus/envelope.js';

// 设计锚点 9.5：workspaces 投影表
// 消费 task.created 事件，从 handles.workspaceId 或 payload.workspaceId 建工作区记录

export class WorkspacesProjection {
  initSchema(db: ProjectionsStore): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        workspaceId TEXT PRIMARY KEY,
        createdAt INTEGER
      );
    `);
  }

  applyEvent(db: ProjectionsStore, env: StoredEventEnvelope): void {
    if (env.family !== 'task') return;
    if (env.subtype !== 'created') return;

    const workspaceId = env.handles.workspaceId ?? (env.payload as any)?.workspaceId;
    if (!workspaceId) return;

    db.run(
      'INSERT OR IGNORE INTO workspaces (workspaceId, createdAt) VALUES (?, ?)',
      workspaceId, env.timestamp
    );
  }
}
