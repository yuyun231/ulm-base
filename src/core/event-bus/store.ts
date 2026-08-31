import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import type { EventEnvelope, StoredEventEnvelope, EventFamily } from './envelope.js';

// 设计锚点 2.1：append-only 事件存储。无 update/delete 方法。
// 决策点 G5：events.sqlite 文件。

export class EventStore {
  private db: DB;

  constructor(path: string) {
    this.db = new Database(path);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        family TEXT NOT NULL,
        subtype TEXT NOT NULL,
        handles TEXT NOT NULL,
        payload TEXT NOT NULL,
        value TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_family ON events(family);
      CREATE INDEX IF NOT EXISTS idx_events_subtype ON events(subtype);
    `);
  }

  // 2.1 append-only：只追加，seq 唯一
  append(env: EventEnvelope & { seq: number }): StoredEventEnvelope {
    const subjectId = env.subject.kind === 'agent' ? env.subject.agentId
      : env.subject.kind === 'module' ? env.subject.module
      : env.subject.userId;
    const stmt = this.db.prepare(
      `INSERT INTO events (seq, timestamp, subject_kind, subject_id, family, subtype, handles, payload, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      env.seq,
      env.timestamp,
      env.subject.kind,
      subjectId,
      env.family,
      env.subtype,
      JSON.stringify(env.handles),
      JSON.stringify(env.payload),
      env.value === null ? null : JSON.stringify(env.value),
    );
    return env as StoredEventEnvelope;
  }

  getMaxSeq(): number {
    const row = this.db.prepare('SELECT MAX(seq) as maxSeq FROM events').get() as { maxSeq: number | null };
    return row.maxSeq ?? 0;
  }

  getBySeq(seq: number): StoredEventEnvelope | undefined {
    const row = this.db.prepare('SELECT * FROM events WHERE seq = ?').get(seq) as any;
    return row ? this.rowToEnvelope(row) : undefined;
  }

  getRange(fromSeq: number, toSeq: number): StoredEventEnvelope[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE seq >= ? AND seq <= ? ORDER BY seq').all(fromSeq, toSeq) as any[];
    return rows.map(r => this.rowToEnvelope(r));
  }

  getByFamily(family: EventFamily): StoredEventEnvelope[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE family = ? ORDER BY seq').all(family) as any[];
    return rows.map(r => this.rowToEnvelope(r));
  }

  getAll(): StoredEventEnvelope[] {
    const rows = this.db.prepare('SELECT * FROM events ORDER BY seq').all() as any[];
    return rows.map(r => this.rowToEnvelope(r));
  }

  private rowToEnvelope(row: any): StoredEventEnvelope {
    const subjectKind = row.subject_kind;
    const subject = subjectKind === 'agent'
      ? { kind: 'agent' as const, agentId: row.subject_id }
      : subjectKind === 'module'
      ? { kind: 'module' as const, module: row.subject_id }
      : { kind: 'human' as const, userId: row.subject_id };
    return {
      seq: row.seq,
      timestamp: row.timestamp,
      subject,
      family: row.family,
      subtype: row.subtype,
      handles: JSON.parse(row.handles),
      payload: JSON.parse(row.payload),
      value: row.value === null ? null : JSON.parse(row.value),
    };
  }

  // 通用查询（测试和投影重建用）
  query(sql: string, ...params: any[]): any[] {
    return this.db.prepare(sql).all(...params) as any[];
  }

  close(): void {
    this.db.close();
  }
}
