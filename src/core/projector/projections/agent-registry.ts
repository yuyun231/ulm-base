import type { ProjectionsStore } from '../projections-store.js';
import type { StoredEventEnvelope } from '../../event-bus/envelope.js';

// Phase F.1：agent 注册表投影（身份态；与 agents 运行态表分离——注册低频、运行态高频）
// 消费 admin.agentRegistered / agentUpdated（UPSERT）/ agentRemoved（DELETE）
export class AgentRegistryProjection {
  initSchema(db: ProjectionsStore): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_registry (
        agentId      TEXT PRIMARY KEY,
        role         TEXT NOT NULL,
        description  TEXT,
        capabilities TEXT,
        spawnPolicy  TEXT NOT NULL DEFAULT 'external',
        configSource TEXT NOT NULL DEFAULT 'panel',
        enabled      INTEGER NOT NULL DEFAULT 1,
        createdAt    INTEGER,
        updatedAt    INTEGER
      );
    `);
  }

  applyEvent(db: ProjectionsStore, env: StoredEventEnvelope): void {
    if (env.family !== 'admin') return;
    const p = env.payload as any;

    if (env.subtype === 'agentRegistered' || env.subtype === 'agentUpdated') {
      const capabilities = JSON.stringify(p.capabilities ?? []);
      // enabled 归一：布尔 false 与数字 0 均视为停用（避免 0===false 窄契约缺陷，20260831 修复）
      const enabledBit = p.enabled === false || p.enabled === 0 ? 0 : 1;
      const existing = db.get('SELECT agentId FROM agent_registry WHERE agentId = ?', p.agentId) as any;
      if (existing) {
        db.run(
          `UPDATE agent_registry
           SET role = ?, description = ?, capabilities = ?, spawnPolicy = ?, configSource = ?, enabled = ?, updatedAt = ?
           WHERE agentId = ?`,
          p.role, p.description ?? null, capabilities, p.spawnPolicy ?? 'external',
          p.configSource ?? 'panel', enabledBit, env.timestamp, p.agentId,
        );
      } else {
        db.run(
          `INSERT INTO agent_registry
             (agentId, role, description, capabilities, spawnPolicy, configSource, enabled, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          p.agentId, p.role, p.description ?? null, capabilities, p.spawnPolicy ?? 'external',
          p.configSource ?? 'panel', enabledBit, env.timestamp, env.timestamp,
        );
      }
      return;
    }

    if (env.subtype === 'agentRemoved') {
      db.run('DELETE FROM agent_registry WHERE agentId = ?', p.agentId);
    }
  }
}
