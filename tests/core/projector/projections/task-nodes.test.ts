import { describe, it, expect, beforeEach } from 'vitest';
import { ProjectionsStore } from '../../../src/core/projector/projections-store.js';
import { TaskNodesProjection } from '../../../src/core/projector/projections/task-nodes.js';
import type { StoredEventEnvelope } from '../../../src/core/event-bus/envelope.js';

function makeEvent(seq: number, subtype: string, handles: object = {}, payload: object = {}): StoredEventEnvelope {
  return { seq, timestamp: Date.now(), subject: { kind: 'agent', agentId: 'res-01' }, family: 'task', subtype, handles, payload, value: null } as StoredEventEnvelope;
}

describe('TaskNodesProjection DAG节点投影', () => {
  let projStore: ProjectionsStore;
  let proj: TaskNodesProjection;

  beforeEach(() => {
    projStore = new ProjectionsStore(':memory:');
    proj = new TaskNodesProjection();
    proj.initSchema(projStore);
  });

  it('created 事件中的 DAG 节点写入投影', () => {
    proj.applyEvent(projStore, makeEvent(1, 'created', { taskId: 'task-1' }, {
      dagNodes: [
        { nodeId: 'n1', goal: '步骤1', acceptanceCriteria: '通过', executor: 'res-01' },
        { nodeId: 'n2', goal: '步骤2', acceptanceCriteria: '完成', executor: 'res-01' },
      ],
    } as any));
    const nodes = projStore.all('SELECT * FROM task_nodes WHERE taskId = ? ORDER BY nodeId', 'task-1') as any[];
    expect(nodes).toHaveLength(2);
    expect(nodes[0].nodeId).toBe('n1');
    expect(nodes[0].nodeState).toBe('pending');
  });

  it('nodeSubmitted 事件改节点状态为审批', () => {
    proj.applyEvent(projStore, makeEvent(1, 'created', { taskId: 'task-1' }, { dagNodes: [{ nodeId: 'n1' }] } as any));
    proj.applyEvent(projStore, makeEvent(2, 'nodeSubmitted', { taskId: 'task-1' }, { nodeId: 'n1', material: '完成' }));
    const node = projStore.get('SELECT * FROM task_nodes WHERE taskId = ? AND nodeId = ?', 'task-1', 'n1') as any;
    expect(node.nodeState).toBe('underReview');
  });

  it('nodeJudged 通过改节点状态为完成', () => {
    proj.applyEvent(projStore, makeEvent(1, 'created', { taskId: 'task-1' }, { dagNodes: [{ nodeId: 'n1' }] } as any));
    proj.applyEvent(projStore, makeEvent(2, 'nodeSubmitted', { taskId: 'task-1' }, { nodeId: 'n1' }));
    proj.applyEvent(projStore, makeEvent(3, 'nodeJudged', { taskId: 'task-1' }, { nodeId: 'n1', result: 'pass' }));
    const node = projStore.get('SELECT * FROM task_nodes WHERE taskId = ? AND nodeId = ?', 'task-1', 'n1') as any;
    expect(node.nodeState).toBe('done');
  });

  it('nodeJudged 驳回改节点状态回进行', () => {
    proj.applyEvent(projStore, makeEvent(1, 'created', { taskId: 'task-1' }, { dagNodes: [{ nodeId: 'n1' }] } as any));
    proj.applyEvent(projStore, makeEvent(2, 'nodeSubmitted', { taskId: 'task-1' }, { nodeId: 'n1' }));
    proj.applyEvent(projStore, makeEvent(3, 'nodeJudged', { taskId: 'task-1' }, { nodeId: 'n1', result: 'reject' }));
    const node = projStore.get('SELECT * FROM task_nodes WHERE taskId = ? AND nodeId = ?', 'task-1', 'n1') as any;
    expect(node.nodeState).toBe('inProgress');
  });

  it('restructured 事件写入新版本节点（旧版本保留）', () => {
    proj.applyEvent(projStore, makeEvent(1, 'created', { taskId: 'task-1' }, { dagNodes: [{ nodeId: 'n1' }] } as any));
    proj.applyEvent(projStore, makeEvent(2, 'restructured', { taskId: 'task-1' }, {
      newVersion: 2, addNodes: [{ nodeId: 'n2', goal: '新步骤' }],
    } as any));
    const v1 = projStore.all('SELECT * FROM task_nodes WHERE taskId = ? AND dagVersion = 1', 'task-1') as any[];
    const v2 = projStore.all('SELECT * FROM task_nodes WHERE taskId = ? AND dagVersion = 2', 'task-1') as any[];
    expect(v1).toHaveLength(1);
    // F7 git 式重构：旧版本节点复制进新版本（主枝），再加新增节点
    expect(v2).toHaveLength(2);
    expect(v2.some((n: any) => n.nodeId === 'n2')).toBe(true);
  });
});
