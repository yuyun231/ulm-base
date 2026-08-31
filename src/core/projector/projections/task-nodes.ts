import type { ProjectionsStore } from '../projections-store.js';
import type { StoredEventEnvelope } from '../../event-bus/envelope.js';

// 设计锚点 4.2 DAG 节点 + 4.5 版本化重构
// F7 补完：新增 task_edges 表存节点依赖关系；重构处理边的增删；主枝查询只返回最高 dagVersion

export class TaskNodesProjection {
  initSchema(db: ProjectionsStore): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_nodes (
        taskId TEXT NOT NULL, nodeId TEXT NOT NULL, dagVersion INTEGER NOT NULL DEFAULT 1,
        goal TEXT, acceptanceCriteria TEXT, executor TEXT, nodeState TEXT NOT NULL DEFAULT 'pending',
        PRIMARY KEY (taskId, nodeId, dagVersion)
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_task ON task_nodes(taskId);
      CREATE INDEX IF NOT EXISTS idx_nodes_version ON task_nodes(taskId, dagVersion);
      CREATE TABLE IF NOT EXISTS task_edges (
        taskId TEXT NOT NULL, dagVersion INTEGER NOT NULL,
        fromNode TEXT NOT NULL, toNode TEXT NOT NULL,
        PRIMARY KEY (taskId, dagVersion, fromNode, toNode)
      );
      CREATE INDEX IF NOT EXISTS idx_edges_task ON task_edges(taskId, dagVersion);
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
      case 'nodeSubmitted':
        db.run('UPDATE task_nodes SET nodeState = ? WHERE taskId = ? AND nodeId = ? AND dagVersion = (SELECT MAX(dagVersion) FROM task_nodes WHERE taskId = ? AND nodeId = ?)',
          'underReview', taskId, (env.payload as any).nodeId, taskId, (env.payload as any).nodeId);
        break;
      case 'nodeJudged': {
        const result = (env.payload as any).result;
        db.run('UPDATE task_nodes SET nodeState = ? WHERE taskId = ? AND nodeId = ? AND dagVersion = (SELECT MAX(dagVersion) FROM task_nodes WHERE taskId = ? AND nodeId = ?)',
          result === 'pass' ? 'done' : 'inProgress', taskId, (env.payload as any).nodeId, taskId, (env.payload as any).nodeId);
        break;
      }
      case 'restructured':
        this.handleRestructured(db, env, taskId);
        break;
    }
  }

  private handleCreated(db: ProjectionsStore, env: StoredEventEnvelope, taskId: string): void {
    const p = env.payload as any;
    const nodes = (p.dagNodes ?? []) as any[];
    for (const node of nodes) {
      db.run(`INSERT INTO task_nodes (taskId, nodeId, dagVersion, goal, acceptanceCriteria, executor, nodeState) VALUES (?, ?, 1, ?, ?, ?, 'pending')`,
        taskId, node.nodeId, node.goal ?? null, node.acceptanceCriteria ?? null, node.executor ?? null);
    }
    // F7：写入边
    const edges = (p.dagEdges ?? []) as any[];
    for (const edge of edges) {
      db.run('INSERT INTO task_edges (taskId, dagVersion, fromNode, toNode) VALUES (?, 1, ?, ?)',
        taskId, edge.from, edge.to);
    }
  }

  private handleRestructured(db: ProjectionsStore, env: StoredEventEnvelope, taskId: string): void {
    const p = env.payload as any;
    const newVersion = p.newVersion;
    // 先复制当前最高版本的节点到新版本
    const maxVersion = db.get('SELECT MAX(dagVersion) as maxV FROM task_nodes WHERE taskId = ?', taskId) as any;
    const oldVersion = maxVersion?.maxV ?? 1;
    const oldNodes = db.all('SELECT * FROM task_nodes WHERE taskId = ? AND dagVersion = ?', taskId, oldVersion) as any[];
    for (const node of oldNodes) {
      db.run(`INSERT INTO task_nodes (taskId, nodeId, dagVersion, goal, acceptanceCriteria, executor, nodeState) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        taskId, node.nodeId, newVersion, node.goal, node.acceptanceCriteria, node.executor, node.nodeState);
    }
    // 复制边
    const oldEdges = db.all('SELECT * FROM task_edges WHERE taskId = ? AND dagVersion = ?', taskId, oldVersion) as any[];
    for (const edge of oldEdges) {
      db.run('INSERT INTO task_edges (taskId, dagVersion, fromNode, toNode) VALUES (?, ?, ?, ?)',
        taskId, newVersion, edge.fromNode, edge.toNode);
    }
    // 处理新增节点
    for (const node of (p.addNodes ?? [])) {
      db.run(`INSERT INTO task_nodes (taskId, nodeId, dagVersion, goal, acceptanceCriteria, executor, nodeState) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        taskId, node.nodeId, newVersion, node.goal ?? null, node.acceptanceCriteria ?? null, node.executor ?? null);
    }
    // 处理删除节点
    for (const nodeId of (p.removeNodes ?? [])) {
      db.run('DELETE FROM task_nodes WHERE taskId = ? AND nodeId = ? AND dagVersion = ?', taskId, nodeId, newVersion);
    }
    // F7：处理新增边
    for (const edge of (p.addEdges ?? [])) {
      db.run('INSERT OR IGNORE INTO task_edges (taskId, dagVersion, fromNode, toNode) VALUES (?, ?, ?, ?)',
        taskId, newVersion, edge.from, edge.to);
    }
    // F7：处理删除边
    for (const edge of (p.removeEdges ?? [])) {
      db.run('DELETE FROM task_edges WHERE taskId = ? AND dagVersion = ? AND fromNode = ? AND toNode = ?',
        taskId, newVersion, edge.from, edge.to);
    }
  }
}
