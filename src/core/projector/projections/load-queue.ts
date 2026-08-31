import type { ProjectionsStore } from '../projections-store.js';
import type { StoredEventEnvelope } from '../../event-bus/envelope.js';

// 设计锚点 9.5：load-queue 投影表
// 澄清6：加载队列是完整视图，不过滤——消费 task.created/assigned/stateChanged
// pending 且 assignedAgent 为空的任务入队；assigned 出队；stateChanged 更新状态但不出队

export class LoadQueueProjection {
  initSchema(db: ProjectionsStore): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS load_queue (
        taskId TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'pending',
        priority INTEGER DEFAULT 0,
        workspaceId TEXT,
        createdAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_loadqueue_state ON load_queue(state);
      CREATE INDEX IF NOT EXISTS idx_loadqueue_priority ON load_queue(priority);
    `);
  }

  applyEvent(db: ProjectionsStore, env: StoredEventEnvelope): void {
    if (env.family !== 'task') return;
    const taskId = env.handles.taskId;
    if (!taskId) return;

    switch (env.subtype) {
      case 'created':
        // 入队：pending 且无 assignedAgent
        db.run(
          'INSERT INTO load_queue (taskId, state, priority, workspaceId, createdAt) VALUES (?, ?, ?, ?, ?)',
          taskId, 'pending',
          (env.payload as any)?.priority ?? 0,
          (env.payload as any)?.workspaceId ?? env.handles.workspaceId ?? null,
          env.timestamp
        );
        break;
      case 'assigned':
        // 出队：已分配 agent，从队列删除
        db.run('DELETE FROM load_queue WHERE taskId = ?', taskId);
        break;
      case 'stateChanged':
        // 澄清6：完整视图不过滤——只更新状态，不出队
        db.run('UPDATE load_queue SET state = ? WHERE taskId = ?',
          (env.payload as any).newState, taskId);
        break;
      case 'rejected':
        // 驳回→回进行，仍在队列中（状态更新为 inProgress）
        db.run('UPDATE load_queue SET state = ? WHERE taskId = ?',
          'inProgress', taskId);
        break;
    }
  }
}
