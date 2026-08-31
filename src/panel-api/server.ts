import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { System } from '../system.js';
import type { StoredEventEnvelope } from '../core/event-bus/envelope.js';

// 设计锚点 1.4/6.7 的生产装配：把进程内 PanelApi 暴露为 HTTP 面（驾驶舱首版，P 阶段）。
// REST（查询/命令）+ SSE 事件流（/api/stream）+ ui/ 静态托管。
// 零新增依赖（node:http）；首版无鉴权，安全边界=默认仅绑定 127.0.0.1。
// 面板主体固定 human:local——出厂 permission-rules.yaml 的 human:* 基线放行。

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface PanelServerOptions {
  port?: number;   // 默认 8100；0 = 随机端口（测试）
  host?: string;   // 默认 127.0.0.1
  uiDir?: string;  // 静态文件目录，默认 <repo>/ui（src 与 dist 布局均上溯两级）
}

// 统一响应形状：成功 {ok:true,data}；失败 {ok:false,error}
const USER_ID = 'local';
const MAX_BODY_BYTES = 1_000_000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export class PanelHttpServer {
  private system: System;
  private port: number;
  private host: string;
  private uiDir: string;
  private server: Server;
  private sseClients: Set<ServerResponse> = new Set();
  private unsubBus: (() => void) | null = null;

  constructor(system: System, opts: PanelServerOptions = {}) {
    this.system = system;
    this.port = opts.port ?? 8100;
    this.host = opts.host ?? '127.0.0.1';
    this.uiDir = opts.uiDir ?? join(__dirname, '..', '..', 'ui');
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => this.json(res, 500, { ok: false, error: 'internal error' }));
    });
  }

  start(): Promise<void> {
    if (this.unsubBus) return Promise.resolve();
    this.unsubBus = this.system.bus.subscribe((env) => this.broadcastEvent(env));
    // listen 异步：等 listening 事件再返回，保证随后 getAddress() 拿到真实端口（port:0 场景）
    return new Promise((resolve, reject) => {
      const onErr = (e: Error) => reject(e);
      this.server.once('error', onErr);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', onErr);
        resolve();
      });
    });
  }

  stop(): void {
    if (this.unsubBus) { this.unsubBus(); this.unsubBus = null; }
    for (const res of this.sseClients) res.destroy();
    this.sseClients.clear();
    this.server.close();
    this.server.closeAllConnections();
  }

  getAddress(): string {
    const addr = this.server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : this.port;
    return `http://${this.host}:${port}`;
  }

  // ---- 路由 ----

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    try {
      if (pathname.startsWith('/api/')) {
        await this.handleApi(req, res, pathname, url);
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        await this.serveStatic(res, pathname);
      } else {
        this.json(res, 404, { ok: false, error: 'not found' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 权限拒绝→403；缺字段/语法先验失败等→400
      this.json(res, msg.includes('权限') ? 403 : 400, { ok: false, error: msg });
    }
  }

  private async handleApi(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
    switch (req.method) {
      case 'GET': return this.routeGet(res, pathname, url);
      case 'POST': return this.routePost(req, res, pathname);
      case 'PUT': return this.routePut(req, res, pathname);
      case 'DELETE': return this.routeDelete(res, pathname);
      default: this.json(res, 405, { ok: false, error: 'method not allowed' });
    }
  }

  private routeGet(res: ServerResponse, pathname: string, url: URL): void {
    const p = this.system.panelApi;
    const ok = (data: unknown) => this.json(res, 200, { ok: true, data });

    if (pathname === '/api/stream') return this.handleSse(res);
    if (pathname === '/api/agents') return ok(p.queryAgents());
    if (pathname === '/api/tasks') return ok(p.queryTasks());
    if (pathname === '/api/purposes') return ok(p.queryPurposes());
    if (pathname === '/api/automations') return ok(p.queryAutomations());
    if (pathname === '/api/procedures') return ok(p.queryProcedures());
    if (pathname === '/api/permissions') return ok(p.queryPermissionRules());
    if (pathname === '/api/describe') return ok(this.system.describe());
    if (pathname === '/api/events') return ok(this.queryEvents(url));

    const seg = pathname.split('/').filter(Boolean); // ['api', ...]
    if (seg[1] === 'agents' && seg.length === 3) {
      const d = p.queryAgentsDetail(seg[2]);
      if (!d) return this.json(res, 404, { ok: false, error: `agent 不存在: ${seg[2]}` });
      return ok(d);
    }
    if (seg[1] === 'tasks' && seg.length === 3) {
      const d = p.queryTask(seg[2]);
      if (!d) return this.json(res, 404, { ok: false, error: `task 不存在: ${seg[2]}` });
      return ok(d);
    }
    // P.5 任务详情子资源：树依赖 / DAG 节点 / 指导区 / 反馈区
    if (seg[1] === 'tasks' && seg.length === 4) {
      switch (seg[3]) {
        case 'tree': return ok(p.queryTaskTree(seg[2]));
        case 'dag': return ok(p.queryTaskDag(seg[2]));
        case 'guidance': return ok(p.queryTaskGuidance(seg[2]));
        case 'feedback': return ok(p.queryTaskFeedback(seg[2]));
      }
    }
    if (seg[1] === 'workflows' && seg.length === 3) return ok(p.queryWorkflow(seg[2])); // null=尚未编写
    // 资产原文（编辑器用，避免解析对象丢注释）
    if (pathname === '/api/assets/automations') return ok(p.queryAutomationsRaw());
    if (seg[1] === 'assets' && seg[2] === 'procedures' && seg.length === 4) {
      return ok(p.queryProcedureRaw(seg[3]));
    }
    this.json(res, 404, { ok: false, error: 'not found' });
  }

  private async routePost(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const p = this.system.panelApi;
    const b = await this.readJson(req);
    const seg = pathname.split('/').filter(Boolean);
    const ok = (data: unknown) => this.json(res, 200, { ok: true, data });

    if (pathname === '/api/tasks') {
      requireFields(b, ['taskId', 'taskType', 'goal', 'workspaceId']);
      return ok(p.createTask(USER_ID, { ...b, priority: b.priority ?? 0 }));
    }
    // 人发起指导（7.10）：type=now 调度器立即注入；type=future 存任务载荷随 wake 下发
    if (seg[1] === 'tasks' && seg[3] === 'guidance') {
      requireFields(b, ['content']);
      return ok(p.issueTaskGuidance(USER_ID, seg[2], b.content, b.type === 'future' ? 'future' : 'now'));
    }
    if (pathname === '/api/agents') {
      requireFields(b, ['agentId', 'role']);
      return ok(p.registerAgent(USER_ID, b));
    }
    if (pathname === '/api/permissions') {
      requireFields(b, ['subject', 'action', 'object', 'decision']);
      return ok(p.setPermissionRule(USER_ID, b));
    }
    if (pathname === '/api/purposes') {
      requireFields(b, ['purposeId', 'dialogueId']);
      return ok(p.createPurpose(USER_ID, b.purposeId, b.dialogueId, b.description ?? ''));
    }
    // /api/agents/:id/manage
    if (seg[1] === 'agents' && seg[3] === 'manage') {
      requireFields(b, ['action']);
      if (!['start', 'stop', 'restart'].includes(b.action)) throw new Error(`非法托管动作: ${b.action}`);
      return ok(p.manageAgent(USER_ID, seg[2], b.action));
    }
    // /api/purposes/:id/confirm | /launch
    if (seg[1] === 'purposes' && seg[3] === 'confirm') {
      requireFields(b, ['confirmedState']);
      return ok(p.confirmPurpose(USER_ID, seg[2], b.confirmedState));
    }
    if (seg[1] === 'purposes' && seg[3] === 'launch') {
      requireFields(b, ['taskId']);
      return ok(p.launchPurpose(USER_ID, seg[2], b.taskId));
    }
    this.json(res, 404, { ok: false, error: 'not found' });
  }

  private async routePut(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const p = this.system.panelApi;
    const b = await this.readJson(req);
    const seg = pathname.split('/').filter(Boolean);
    const ok = (data: unknown) => this.json(res, 200, { ok: true, data });

    // 资产编辑三入口（admin:editAsset；YAML 语法先验失败原样回显错误）
    if (seg[1] === 'assets' && seg[2] === 'workflows' && seg.length === 4) {
      requireFields(b, ['content']);
      p.writeWorkflow(USER_ID, seg[3], b.content);
      return ok(null);
    }
    if (seg[1] === 'assets' && seg[2] === 'procedures' && seg.length === 4) {
      requireFields(b, ['content']);
      p.writeProcedure(USER_ID, seg[3], b.content);
      return ok(null);
    }
    if (pathname === '/api/assets/automations') {
      requireFields(b, ['content']);
      return ok(p.writeAutomations(USER_ID, b.content));
    }
    this.json(res, 404, { ok: false, error: 'not found' });
  }

  private routeDelete(res: ServerResponse, pathname: string): void {
    const p = this.system.panelApi;
    const seg = pathname.split('/').filter(Boolean);
    const ok = (data: unknown) => this.json(res, 200, { ok: true, data });

    if (seg[1] === 'agents' && seg.length === 3) return ok(p.removeAgent(USER_ID, seg[2]));
    if (seg[1] === 'permissions' && seg.length === 3) return ok(p.removePermissionRule(USER_ID, seg[2]));
    this.json(res, 404, { ok: false, error: 'not found' });
  }

  // ---- 事件历史 + SSE ----

  private queryEvents(url: URL): StoredEventEnvelope[] {
    const afterSeq = Math.max(0, Number(url.searchParams.get('afterSeq') ?? '0') || 0);
    const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') ?? '200') || 200), 1000);
    const family = url.searchParams.get('family');
    if (family) {
      return this.system.eventStore.getByFamily(family as StoredEventEnvelope['family'])
        .filter(e => e.seq > afterSeq).slice(0, limit);
    }
    return this.system.eventStore.getRange(afterSeq + 1, afterSeq + limit);
  }

  private handleSse(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n');
    // hello 带当前 maxSeq：客户端据此决定历史回补起点（seq 客户端去重）
    res.write(`event: hello\ndata: ${JSON.stringify({ maxSeq: this.system.eventStore.getMaxSeq() })}\n\n`);
    this.sseClients.add(res);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    res.on('close', () => {
      clearInterval(heartbeat);
      this.sseClients.delete(res);
    });
  }

  private broadcastEvent(env: StoredEventEnvelope): void {
    if (this.sseClients.size === 0) return;
    // 首版推信封摘要（不含 payload/value，防大载荷刷屏）；过滤在 UI 客户端做
    const data = JSON.stringify({
      seq: env.seq, timestamp: env.timestamp, subject: env.subject,
      family: env.family, subtype: env.subtype, handles: env.handles,
    });
    for (const res of this.sseClients) {
      try { res.write(`event: bus\ndata: ${data}\n\n`); } catch { this.sseClients.delete(res); }
    }
  }

  // ---- 基础设施 ----

  private readJson(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) { req.destroy(); reject(new Error('请求体过大')); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          const buf = Buffer.concat(chunks);
          resolve(JSON.parse(decodeBodyText(buf)));
        } catch { reject(new Error('非法 JSON')); }
      });
      req.on('error', reject);
    });
  }

  private async serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const filePath = normalize(join(this.uiDir, rel));
    if (!filePath.startsWith(normalize(this.uiDir))) {
      return this.json(res, 403, { ok: false, error: 'forbidden' });
    }
    try {
      const data = await readFile(filePath);
      const mime = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    } catch {
      this.json(res, 404, { ok: false, error: 'not found' });
    }
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    if (res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
}

function requireFields(body: any, fields: string[]): void {
  if (body == null || typeof body !== 'object') throw new Error('请求体必须为 JSON 对象');
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || body[f] === '') {
      throw new Error(`缺少必填字段: ${f}`);
    }
  }
}

// 请求体解码：UTF-8 为主；检测到 U+FFFD（无效序列被替换）时回退 GBK——
// Windows 控制台客户端（PowerShell/cmd curl）会把中文按本地代码页 GBK 发送，
// 直接按 UTF-8 解码会产生替换符并永久损坏入库文本（e2e 任务乱码的根因）
function decodeBodyText(buf: Buffer): string {
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8 || '{}';
  try {
    const gbk = new TextDecoder('gbk').decode(buf);
    if (!gbk.includes('\uFFFD')) return gbk;
  } catch { /* ICU 无 gbk 时保持 utf8 结果 */ }
  return utf8 || '{}';
}
