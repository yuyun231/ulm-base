import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';

// 决策点 G5：projections.sqlite 独立文件。
// 投影表的底层封装。各投影通过它操作自己的表。

export class ProjectionsStore {
  private db: DB;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, ...params: any[]): void {
    this.db.prepare(sql).run(...params);
  }

  get(sql: string, ...params: any[]): any {
    return this.db.prepare(sql).get(...params);
  }

  all(sql: string, ...params: any[]): any[] {
    return this.db.prepare(sql).all(...params) as any[];
  }

  transaction(fn: () => void): void {
    this.db.transaction(fn)();
  }

  // 全量重放前清空所有表数据（保留表结构）
  clearAll(): void {
    const tables = this.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'") as { name: string }[];
    this.db.transaction(() => {
      for (const t of tables) {
        this.db.exec(`DELETE FROM ${t.name}`);
      }
    })();
  }

  close(): void {
    this.db.close();
  }
}
