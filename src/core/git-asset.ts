import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// 设计锚点 G8：基座通过 child_process 调 git 做准入 commit。
// 设计锚点 2.4：文档资产走 git 轨，事件库存指针。
// 共享基础设施：F2（对话原文存档）、F3（共享记忆读取）、F4（LLM 原文存档）共用。

export class GitAsset {
  private repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  // 初始化 git 仓库（如果尚未初始化）
  initRepo(): void {
    if (!fs.existsSync(path.join(this.repoRoot, '.git'))) {
      execSync('git init', { cwd: this.repoRoot, stdio: 'pipe' });
      execSync('git config user.name "ulm-base"', { cwd: this.repoRoot, stdio: 'pipe' });
      execSync('git config user.email "ulm@base.local"', { cwd: this.repoRoot, stdio: 'pipe' });
    }
  }

  // 在指定相对路径写文件（自动创建目录）
  writeFile(relPath: string, content: string): void {
    const fullPath = path.join(this.repoRoot, relPath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, content, 'utf-8');
  }

  // 读取文件内容
  readFile(relPath: string): string {
    const fullPath = path.join(this.repoRoot, relPath);
    return fs.readFileSync(fullPath, 'utf-8');
  }

  // 提交单个文件到 git
  commitFile(relPath: string, message: string): void {
    execSync(`git add "${relPath}"`, { cwd: this.repoRoot, stdio: 'pipe' });
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: this.repoRoot, stdio: 'pipe' });
  }

  // 一步写文件+提交
  writeAndCommit(relPath: string, content: string, message: string): void {
    this.writeFile(relPath, content);
    this.commitFile(relPath, message);
  }

  // 检查文件是否存在
  fileExists(relPath: string): boolean {
    const fullPath = path.join(this.repoRoot, relPath);
    return fs.existsSync(fullPath);
  }

  // 列出目录下的文件名（仅文件，不含子目录）
  listDir(relPath: string): string[] {
    const fullPath = path.join(this.repoRoot, relPath);
    if (!fs.existsSync(fullPath)) return [];
    return fs.readdirSync(fullPath)
      .filter(name => fs.statSync(path.join(fullPath, name)).isFile());
  }

  // 获取文件最新 git 版本号（commit hash 短格式）
  getLatestVersion(relPath: string): string | null {
    try {
      const hash = execSync(`git log -1 --format="%h" -- "${relPath}"`, {
        cwd: this.repoRoot,
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim();
      return hash || null;
    } catch {
      return null;
    }
  }

  // 获取 git log（用于测试验证）
  getGitLog(): string {
    try {
      return execSync('git log --oneline', {
        cwd: this.repoRoot,
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim();
    } catch {
      return '';
    }
  }
}
