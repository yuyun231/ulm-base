import type { ProjectionsStore } from '../../core/projector/projections-store.js';
import type { EventStore } from '../../core/event-bus/store.js';

// 设计锚点 3.5：查询只读投影表。9.2 查询清单。
// 面板任务详情扩充（P.5）：任务树（parentTaskId 递归）/ DAG 节点依赖 / 指导区 / 反馈区（7.2 事件视图）。

export class TaskQueries {
  private projStore: ProjectionsStore;
  private eventStore: EventStore | null;
  constructor(projStore: ProjectionsStore, eventStore?: EventStore | null) {
    this.projStore = projStore;
    this.eventStore = eventStore ?? null;
  }

  taskDetail(taskId: string): any {
    return this.projStore.get('SELECT * FROM tasks WHERE taskId = ?', taskId) ?? undefined;
  }

  workspace(workspaceId: string): any[] {
    return this.projStore.all('SELECT * FROM tasks WHERE workspaceId = ? ORDER BY priority DESC, createdAt ASC', workspaceId);
  }

  loadQueue(workspaceId: string): any[] {
    // 澄清6：完整视图不过滤，过滤在调度器
    return this.projStore.all("SELECT * FROM tasks WHERE workspaceId = ? AND state = 'pending' ORDER BY priority DESC, createdAt ASC", workspaceId);
  }

  // P.5 任务树：聚合任务→子任务→子任务的子任务（parentTaskId 递归），树依赖关系数据源
  taskTree(taskId: string): any[] {
    return this.projStore.all(`
      WITH RECURSIVE subtree(taskId) AS (
        SELECT taskId FROM tasks WHERE taskId = ?
        UNION ALL
        SELECT t.taskId FROM tasks t JOIN subtree s ON t.parentTaskId = s.taskId
      )
      SELECT taskId, taskType, state, goal, priority, parentTaskId, assignedAgent, dagVersion, createdAt
      FROM tasks WHERE taskId IN (SELECT taskId FROM subtree)
      ORDER BY createdAt ASC, taskId ASC
    `, taskId);
  }

  // P.5 任务 DAG：节点 + 依赖边（当前最高 dagVersion），节点含执行状态
  taskDag(taskId: string): any {
    const task = this.projStore.get('SELECT dagVersion FROM tasks WHERE taskId = ?', taskId) as any;
    const dagVersion = task?.dagVersion ?? 1;
    const nodes = this.projStore.all(
      'SELECT nodeId, goal, acceptanceCriteria, executor, nodeState FROM task_nodes WHERE taskId = ? AND dagVersion = ? ORDER BY nodeId ASC',
      taskId, dagVersion,
    );
    const edges = this.projStore.all(
      'SELECT fromNode, toNode FROM task_edges WHERE taskId = ? AND dagVersion = ? ORDER BY fromNode ASC, toNode ASC',
      taskId, dagVersion,
    );
    return { taskId, dagVersion, nodes, edges };
  }

  guidanceZone(taskId: string): any[] {
    // F5：guidances 投影表（issued→injected→acked→closed 全生命周期）
    return this.projStore.all('SELECT * FROM guidances WHERE taskId = ? ORDER BY createdAt ASC, guidanceId ASC', taskId);
  }

  // P.5 反馈区（设计锚点 7.2：反馈区=事件视图，无自有数据）——
  // 汇聚与任务相关的反馈类事件（上报问题/判定意见/指导回执/指令回执）+ 价值裁决记录
  feedbackZone(taskId: string): any[] {
    if (!this.eventStore) return [];
    const items: any[] = [];
    const rows = this.eventStore.query(`
      SELECT seq, timestamp, subject_kind, subject_id, family, subtype, handles, payload
      FROM events
      WHERE json_extract(handles, '$.taskId') = ?
        AND subtype IN ('issueReported', 'nodeJudged', 'guidanceAcked', 'piercingAcked')
      ORDER BY seq ASC
    `, taskId) as any[];
    for (const r of rows) {
      const p = JSON.parse(r.payload ?? '{}');
      const handles = JSON.parse(r.handles ?? '{}');
      const base = { seq: r.seq, timestamp: r.timestamp, source: r.subject_id, taskId: handles.taskId ?? taskId };
      switch (r.subtype) {
        case 'issueReported':
          items.push({ ...base, kind: 'issue', summary: p.issue ?? '', detail: p });
          break;
        case 'nodeJudged': {
          const passed = p.result === 'pass';
          items.push({
            ...base, kind: 'judge',
            summary: `节点 ${p.nodeId ?? '?'} ${passed ? '通过' : '驳回'}：${p.judgeNote ?? p.rejectReason ?? ''}`,
            detail: p,
          });
          break;
        }
        case 'guidanceAcked':
          items.push({ ...base, kind: 'guidance-ack', summary: `指导 ${p.guidanceId ?? '?'} 回执：${p.ackNote ?? ''}`, detail: p });
          break;
        case 'piercingAcked':
          items.push({
            ...base, kind: 'ack',
            summary: `${p.success === false ? '指令失败' : '指令回执'}：${p.detail ?? ''}${p.commandId ? `（commandId=${p.commandId}）` : ''}`,
            detail: p,
          });
          break;
      }
    }
    // 价值裁决记录（7.12 价值对抗区：judgeRequest→裁决）；最小装配无该投影时跳过
    try {
      const verdicts = this.projStore.all(
        'SELECT id, purposeId, verdict, requestedAt, judgedAt FROM value_compare WHERE taskId = ? ORDER BY id ASC', taskId,
      ) as any[];
      for (const v of verdicts) {
        items.push({
          seq: null, timestamp: v.judgedAt ?? v.requestedAt, source: 'value-compare', taskId,
          kind: 'verdict', summary: `价值裁决：${v.verdict ?? '（未裁决）'}`, detail: v,
        });
      }
    } catch { /* value_compare 投影未装配 */ }
    return items.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || (a.seq ?? 0) - (b.seq ?? 0));
  }

  replay(purposeId: string): any[] {
    // 7.7 按目的id串事件链
    return this.projStore.all("SELECT * FROM replay_by_purpose WHERE purposeId = ? ORDER BY seq", purposeId);
  }

  purposeDetail(purposeId: string): any {
    // F10 补完：目的查询面
    return this.projStore.get('SELECT * FROM purposes WHERE purposeId = ?', purposeId) ?? undefined;
  }

  purposesByState(state: string): any[] {
    return this.projStore.all('SELECT * FROM purposes WHERE state = ? ORDER BY createdAt ASC', state);
  }
}
