import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitAsset } from '../../src/core/git-asset.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('GitAsset', () => {
  let tmpDir: string;
  let asset: GitAsset;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ulm-git-test-'));
    // 初始化 git 仓库
    asset = new GitAsset(tmpDir);
    asset.initRepo();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writeFile 在指定子路径写文件', () => {
    asset.writeFile('archive/dialogue/task-1/dialogue.txt', '对话原文内容');
    const content = fs.readFileSync(path.join(tmpDir, 'archive/dialogue/task-1/dialogue.txt'), 'utf-8');
    expect(content).toBe('对话原文内容');
  });

  it('commitFile 写文件并提交到 git', () => {
    const relPath = 'archive/dialogue/task-1/dialogue.txt';
    asset.writeFile(relPath, '对话原文内容');
    asset.commitFile(relPath, 'feat: archive dialogue for task-1');
    const log = asset.getGitLog();
    expect(log).toContain('feat: archive dialogue for task-1');
  });

  it('writeAndCommit 一步写+提交', () => {
    const relPath = 'archive/value-compare/vc-1.txt';
    asset.writeAndCommit(relPath, 'LLM 判定原文', 'feat: archive judge raw output');
    const content = fs.readFileSync(path.join(tmpDir, relPath), 'utf-8');
    expect(content).toBe('LLM 判定原文');
    const log = asset.getGitLog();
    expect(log).toContain('feat: archive judge raw output');
  });

  it('fileExists 检查文件是否存在', () => {
    asset.writeFile('memory/global/mem-1.md', '# 记忆条目');
    expect(asset.fileExists('memory/global/mem-1.md')).toBe(true);
    expect(asset.fileExists('memory/global/mem-2.md')).toBe(false);
  });

  it('readFile 读取文件内容', () => {
    asset.writeFile('memory/agg/task-1/entry-1.md', '# 条目1\n内容');
    const content = asset.readFile('memory/agg/task-1/entry-1.md');
    expect(content).toBe('# 条目1\n内容');
  });

  it('listDir 列出目录下的文件（仅文件名，不含子目录）', () => {
    asset.writeFile('memory/agg/task-1/entry-1.md', 'a');
    asset.writeFile('memory/agg/task-1/entry-2.md', 'b');
    asset.writeFile('memory/agg/task-1/entry-3.md', 'c');
    const files = asset.listDir('memory/agg/task-1');
    expect(files).toHaveLength(3);
    expect(files).toContain('entry-1.md');
    expect(files).toContain('entry-2.md');
    expect(files).toContain('entry-3.md');
  });

  it('getLatestVersion 获取文件最新 git 版本号（commit hash 短格式）', () => {
    asset.writeAndCommit('memory/global/mem-1.md', 'v1', 'feat: v1');
    const v1 = asset.getLatestVersion('memory/global/mem-1.md');
    expect(v1).toBeTruthy();
    expect(v1!.length).toBeGreaterThanOrEqual(7);
  });
});
