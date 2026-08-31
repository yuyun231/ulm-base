import { describe, it, expect } from 'vitest';
import { ProjectionsStore } from '../../src/core/projector/projections-store.js';

describe('ProjectionsStore 投影存储', () => {
  it('创建内存库无异常', () => {
    const store = new ProjectionsStore(':memory:');
    store.close();
  });

  it('exec 建表后可插入查询', () => {
    const store = new ProjectionsStore(':memory:');
    store.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)');
    store.run('INSERT INTO test VALUES (1, ?)', 'hello');
    const row = store.get('SELECT val FROM test WHERE id = 1') as { val: string };
    expect(row.val).toBe('hello');
    store.close();
  });

  it('all 查询返回数组', () => {
    const store = new ProjectionsStore(':memory:');
    store.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)');
    store.run('INSERT INTO test VALUES (1, ?)', 'a');
    store.run('INSERT INTO test VALUES (2, ?)', 'b');
    const rows = store.all('SELECT * FROM test ORDER BY id') as { id: number; val: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[1].val).toBe('b');
    store.close();
  });

  it('事务 commit 后可见', () => {
    const store = new ProjectionsStore(':memory:');
    store.exec('CREATE TABLE test (id INTEGER PRIMARY KEY)');
    store.transaction(() => {
      store.run('INSERT INTO test VALUES (1)');
      store.run('INSERT INTO test VALUES (2)');
    });
    const rows = store.all('SELECT * FROM test') as any[];
    expect(rows).toHaveLength(2);
    store.close();
  });

  it('clearAll 清空所有表数据（用于全量重放前清空）', () => {
    const store = new ProjectionsStore(':memory:');
    store.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY)');
    store.exec('CREATE TABLE t2 (id INTEGER PRIMARY KEY)');
    store.run('INSERT INTO t1 VALUES (1)');
    store.run('INSERT INTO t2 VALUES (1)');
    store.clearAll();
    expect(store.all('SELECT * FROM t1')).toHaveLength(0);
    expect(store.all('SELECT * FROM t2')).toHaveLength(0);
    store.close();
  });
});
