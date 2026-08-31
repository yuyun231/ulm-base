import type { ProjectionsStore } from '../projections-store.js';
import type { StoredEventEnvelope } from '../../event-bus/envelope.js';

// 设计锚点 3.3② agent状态机推进
// 澄清5：两层结构 dormant / awakened(idle/working/waiting)，focusBinding 正交
// 澄清7：docRead 更新 lastActivityAt（倒计时在定时器内存态，投影只记活动时间）

export class AgentsProjection {
  initSchema(db: ProjectionsStore): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        agentId TEXT PRIMARY KEY,
        wakeState TEXT NOT NULL DEFAULT 'dormant',
        workState TEXT,
        focusBinding TEXT,
        lastActivityAt INTEGER,
        lost INTEGER NOT NULL DEFAULT 0,
        firstSeenAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_agents_wake ON agents(wakeState);
      CREATE INDEX IF NOT EXISTS idx_agents_focus ON agents(focusBinding);
    `);
  }

  applyEvent(db: ProjectionsStore, env: StoredEventEnvelope): void {
    if (env.family !== 'schedule') return;
    if (env.subject.kind !== 'agent') return;
    const agentId = env.subject.agentId;

    // 确保 agent 记录存在
    db.run('INSERT OR IGNORE INTO agents (agentId, wakeState, firstSeenAt) VALUES (?, ?, ?)',
      agentId, 'dormant', env.timestamp);

    switch (env.subtype) {
      case 'woken':
        // 唤醒→空闲
        db.run('UPDATE agents SET wakeState = ?, workState = ?, lastActivityAt = ? WHERE agentId = ?',
          'awakened', 'idle', env.timestamp, agentId);
        break;
      case 'loaded': {
        // 空闲→工作 或 等待→工作；payload.workState 可指定目标状态（如 'waiting'）
        const workState = (env.payload as any)?.workState ?? 'working';
        db.run('UPDATE agents SET workState = ?, lastActivityAt = ? WHERE agentId = ?',
          workState, env.timestamp, agentId);
        break;
      }
      case 'slept':
        // 唤醒→休眠（workState 清空）
        db.run('UPDATE agents SET wakeState = ?, workState = NULL WHERE agentId = ?',
          'dormant', agentId);
        break;
      case 'focusBound':
        // 澄清6：focusBinding 正交标记，绑定/解绑
        db.run('UPDATE agents SET focusBinding = ? WHERE agentId = ?',
          (env.payload as any).aggregateTaskId ?? null, agentId);
        break;
      case 'docRead':
        // 澄清7：查阅算工作活动，更新 lastActivityAt
        db.run('UPDATE agents SET lastActivityAt = ? WHERE agentId = ?',
          env.timestamp, agentId);
        break;
      case 'agentLost':
        db.run('UPDATE agents SET lost = 1 WHERE agentId = ?', agentId);
        break;
    }
  }
}
