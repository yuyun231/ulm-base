import type { ProjectionsStore } from '../projections-store.js';
import type { StoredEventEnvelope } from '../../event-bus/envelope.js';

// 设计锚点 9.5：permission-rules 投影表
// 消费 admin.permissionChanged 事件，物化权限规则（UPSERT 语义）

export class PermissionRulesProjection {
  initSchema(db: ProjectionsStore): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS permission_rules (
        ruleId TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        action TEXT NOT NULL,
        effect TEXT NOT NULL,
        updatedAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_permrules_subject ON permission_rules(subject);
      CREATE INDEX IF NOT EXISTS idx_permrules_action ON permission_rules(action);
    `);
  }

  applyEvent(db: ProjectionsStore, env: StoredEventEnvelope): void {
    if (env.family !== 'admin') return;
    // Phase F.5（决策点 1）：面板删除权限规则（事件只带 ruleId）与 UPSERT 共存
    if (env.subtype !== 'permissionChanged' && env.subtype !== 'permissionRemoved') return;

    const p = env.payload as any;
    if (env.subtype === 'permissionRemoved') {
      db.run('DELETE FROM permission_rules WHERE ruleId = ?', p.ruleId);
      return;
    }
    db.run(
      `INSERT INTO permission_rules (ruleId, subject, action, effect, updatedAt)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(ruleId) DO UPDATE SET subject=excluded.subject, action=excluded.action, effect=excluded.effect, updatedAt=excluded.updatedAt`,
      p.ruleId, p.subject, p.action, p.effect, env.timestamp
    );
  }
}
