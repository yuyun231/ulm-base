import type { ProjectionsStore } from '../projector/projections-store.js';

// 设计锚点 3.8 focus入队过滤；4.8 排序=优先级+创建时间升序
// 澄清6：过滤在调度器规则内，读 load-queue 投影 + agents 投影

export interface Assignment {
  taskId: string;
  agentId: string;
  workspaceId: string;
}

export class LoadQueue {
  // 3.8：无 focus 绑定时，返回待分配区第一个任务（状态=pending 的任务）
  nextAssignment(projStore: ProjectionsStore): Assignment | null {
    const tasks = projStore.all(
      "SELECT * FROM tasks WHERE state = 'pending' ORDER BY priority DESC, createdAt ASC LIMIT 1"
    ) as any[];
    if (tasks.length === 0) return null;
    const task = tasks[0];
    // 找一个空闲的 agent
    const agents = projStore.all(
      "SELECT * FROM agents WHERE wakeState = 'awakened' AND workState = 'idle' AND lost = 0 LIMIT 1"
    ) as any[];
    if (agents.length === 0) return null;
    return { taskId: task.taskId, agentId: agents[0].agentId, workspaceId: task.workspaceId };
  }

  // 3.8：有 focus 绑定时，只返回该聚合任务的子任务
  nextAssignmentForAgent(projStore: ProjectionsStore, agentId: string): Assignment | null {
    const agent = projStore.get('SELECT * FROM agents WHERE agentId = ?', agentId) as any;
    if (!agent) return null;
    const focusBinding = agent.focusBinding;
    if (!focusBinding) return this.nextAssignment(projStore);
    // 澄清6：filter 在这里，不在投影层
    const tasks = projStore.all(
      "SELECT * FROM tasks WHERE state = 'pending' AND parentTaskId = ? ORDER BY priority DESC, createdAt ASC LIMIT 1",
      focusBinding
    ) as any[];
    if (tasks.length === 0) return null;
    return { taskId: tasks[0].taskId, agentId, workspaceId: tasks[0].workspaceId };
  }

  getQueueForWorkspace(projStore: ProjectionsStore, workspaceId: string): any[] {
    return projStore.all(
      "SELECT * FROM tasks WHERE state = 'pending' AND workspaceId = ? ORDER BY priority DESC, createdAt ASC",
      workspaceId
    ) as any[];
  }
}
