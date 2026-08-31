import type { EventBus } from '../core/event-bus/bus.js';
import type { ProjectionsStore } from '../core/projector/projections-store.js';
import type { FactoryAgentConfig } from '../config/loader.js';

// Phase F.2 D8：出厂 agent 导入——补缺不覆盖
// 存在且 configSource=panel → 跳过（面板注册为最高事实源）；不存在 → agentRegistered；存在且 factory → agentUpdated 对齐
export function importFactoryAgents(bus: EventBus, projStore: ProjectionsStore, agents: FactoryAgentConfig[]): void {
  for (const a of agents) {
    let existing: any = null;
    try {
      existing = projStore.get('SELECT configSource FROM agent_registry WHERE agentId = ?', a.agentId);
    } catch { /* 表未建（极端调用方）→ 视为不存在 */ }
    if (existing && existing.configSource === 'panel') continue;
    const subtype = existing ? 'agentUpdated' : 'agentRegistered';
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'module', module: 'system' },
      family: 'admin', subtype, handles: {},
      payload: {
        agentId: a.agentId, role: a.role, description: a.description ?? null,
        capabilities: a.capabilities ?? [], spawnPolicy: a.spawnPolicy ?? 'external',
        configSource: 'factory', enabled: true,
      },
      value: null,
    });
  }
}
