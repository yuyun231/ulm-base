import type { ProjectionsStore } from '../projections-store.js';
import type { StoredEventEnvelope } from '../../event-bus/envelope.js';

// 设计锚点 9.5：dialogues 投影表
// 5.7 对话实体字段：模式/常驻键/压缩策略/记忆订阅清单/水印集
// 5.9 水印存 dialogues 投影表 watermark 字段
// 5.10 压缩触发阈值进 params.yaml
// 澄清9：channel 字段落 turn 记录

export class DialoguesProjection {
  initSchema(db: ProjectionsStore): void {
    // F2/F3 补完：新增 dialogues 主表
    db.exec(`
      CREATE TABLE IF NOT EXISTS dialogues (
        dialogueId TEXT PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'B',
        residentKey TEXT,
        compressStrategy TEXT,
        memoryScope TEXT,
        watermark TEXT NOT NULL DEFAULT '',
        turnCount INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER
      );
    `);
    // 原有 dialogue_turns 表保持不变
    db.exec(`
      CREATE TABLE IF NOT EXISTS dialogue_turns (
        seq INTEGER PRIMARY KEY,
        dialogueId TEXT NOT NULL,
        channel TEXT,
        author TEXT,
        content TEXT,
        postedAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_dialogues_id ON dialogue_turns(dialogueId);
    `);
  }

  applyEvent(db: ProjectionsStore, env: StoredEventEnvelope): void {
    if (env.family !== 'dialogue') return;
    if (env.subtype !== 'turnPosted') return;

    const dialogueId = env.handles.dialogueId;
    if (!dialogueId) return;

    const p = env.payload as any;

    // 写 turn 记录（原有逻辑，向后兼容）
    db.run(
      'INSERT INTO dialogue_turns (seq, dialogueId, channel, author, content, postedAt) VALUES (?, ?, ?, ?, ?, ?)',
      env.seq, dialogueId, p.channel ?? null, p.author ?? null, p.content ?? null, env.timestamp
    );

    // F2/F3 补完：维护 dialogues 主表
    const existing = db.get('SELECT * FROM dialogues WHERE dialogueId = ?', dialogueId) as any;
    if (!existing) {
      // 首条 turn → 创建对话记录（mode 默认 'B' 单任务单对话；初始水印为空字符串）
      db.run(
        `INSERT INTO dialogues (dialogueId, mode, memoryScope, watermark, turnCount, archived, createdAt)
         VALUES (?, 'B', ?, ?, 1, 0, ?)`,
        dialogueId,
        p.subscription?.scope ?? null,
        '',
        env.timestamp
      );
    } else {
      // 后续 turn → 递增 turnCount
      db.run(
        'UPDATE dialogues SET turnCount = turnCount + 1 WHERE dialogueId = ?',
        dialogueId
      );
      // 如果 turn 带 subscription payload，更新 memoryScope
      if (p.subscription) {
        db.run(
          'UPDATE dialogues SET memoryScope = ? WHERE dialogueId = ?',
          p.subscription.scope ?? null, dialogueId
        );
      }
    }
  }
}
