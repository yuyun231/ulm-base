import type { ProjectionsStore } from '../projections-store.js';
import type { StoredEventEnvelope } from '../../event-bus/envelope.js';

// 设计锚点 8.7：registry 投影表（seam.handshake register 事件）
// 占位结构：建表 + 空 applyEvent，等阶段 6（接缝A）填充 seam 事件逻辑

export class RegistryProjection {
  initSchema(db: ProjectionsStore): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS registry (
        seamId TEXT PRIMARY KEY,
        moduleName TEXT,
        version TEXT,
        registeredAt INTEGER,
        state TEXT NOT NULL DEFAULT 'registered'
      );
      CREATE INDEX IF NOT EXISTS idx_registry_module ON registry(moduleName);
    `);
  }

  applyEvent(_db: ProjectionsStore, _env: StoredEventEnvelope): void {
    // 占位：等阶段 6（接缝A）填充 seam.handshake.register 逻辑
  }
}
