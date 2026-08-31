import type { ProjectionsStore } from '../projections-store.js';
import type { StoredEventEnvelope } from '../../event-bus/envelope.js';

// 设计锚点 4.1 任务实体字段：编号/类型/内容目标/验收条件/执行体(DAG)/归属工作区/状态/创建主体/归属agent/优先级/父任务id/关联对话id
// 设计锚点 4.8 加载区是投影，任务事件子类型清单
// 澄清4：任务级「审批」位仅在末节点提交时进入

export class TasksProjection {
  initSchema(db: ProjectionsStore): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        taskId TEXT PRIMARY KEY,
        taskType TEXT NOT NULL,
        goal TEXT,
        acceptanceCriteria TEXT,
        dagVersion INTEGER DEFAULT 1,
        workspaceId TEXT,
        state TEXT NOT NULL DEFAULT 'pending',
        createdBy TEXT,
        assignedAgent TEXT,
        priority INTEGER DEFAULT 0,
        parentTaskId TEXT,
        dialogueId TEXT,
        createdAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
      CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspaceId);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parentTaskId);
    `);
  }

  applyEvent(db: ProjectionsStore, env: StoredEventEnvelope): void {
    if (env.family !== 'task') return;
    const taskId = env.handles.taskId;
    if (!taskId) return;

    switch (env.subtype) {
      case 'created':
        this.handleCreated(db, env, taskId);
        break;
      case 'assigned':
        db.run('UPDATE tasks SET state = ?, assignedAgent = ? WHERE taskId = ?',
          'inProgress', (env.payload as any).agentId, taskId);
        break;
      case 'stateChanged':
        db.run('UPDATE tasks SET state = ? WHERE taskId = ?',
          (env.payload as any).newState, taskId);
        break;
      case 'rejected':
        // 4.8 补充1：驳回→任务回进行（原 agent 继续）
        db.run('UPDATE tasks SET state = ? WHERE taskId = ?', 'inProgress', taskId);
        break;
      case 'restructured':
        // 4.5 DAG版本号+1
        db.run('UPDATE tasks SET dagVersion = dagVersion + 1 WHERE taskId = ?', taskId);
        break;
      case 'childPublished':
        this.handleChildPublished(db, env, taskId);
        break;
      // nodeSubmitted/nodeJudged 落 task-nodes 投影（Task 2.4），tasks 投影不改
      // issueReported/pathChangeRequested 不改任务状态，只记录
      // guidance* 落 guidances 投影（Task 2.8）
    }
  }

  private handleCreated(db: ProjectionsStore, env: StoredEventEnvelope, taskId: string): void {
    const p = env.payload as any;
    const creator = env.subject.kind === 'human' ? env.subject.userId
      : env.subject.kind === 'agent' ? env.subject.agentId
      : env.subject.module;
    db.run(
      `INSERT INTO tasks (taskId, taskType, goal, acceptanceCriteria, workspaceId, state, createdBy, priority, parentTaskId, dialogueId, createdAt)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      taskId, p.taskType ?? 'normal', p.goal ?? null, p.acceptanceCriteria ?? null,
      p.workspaceId ?? null, creator,
      p.priority ?? 0, p.parentTaskId ?? null, p.dialogueId ?? null, env.timestamp
    );
  }

  private handleChildPublished(db: ProjectionsStore, env: StoredEventEnvelope, taskId: string): void {
    // 4.4 子任务走正常接取流程，parentTaskId 指向聚合任务
    const p = env.payload as any;
    db.run(
      `INSERT INTO tasks (taskId, taskType, goal, acceptanceCriteria, workspaceId, state, createdBy, priority, parentTaskId, createdAt)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      p.childTaskId, p.taskType ?? 'normal', p.goal ?? null, p.acceptanceCriteria ?? null,
      p.workspaceId ?? null, taskId, p.priority ?? 0, taskId, env.timestamp
    );
  }
}
