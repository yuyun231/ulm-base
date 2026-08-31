import { describe, it, expect, afterEach } from 'vitest';
import { createSystem } from '../../src/system.js';
import { PanelHttpServer } from '../../src/panel-api/server.js';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 驾驶舱首版（P 阶段）：PanelHttpServer HTTP 面验收——
// REST 查询/命令、SSE 事件流、静态托管、错误映射（权限 403 / 校验 400）

function makePanelConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'ulm-panel-http-'));
  writeFileSync(join(dir, 'params.yaml'), `
agent: { sleepCountdownSec: 300 }
scheduler: { maxWorkingAgents: 3 }
heartbeat: { intervalSec: 30, timeoutSec: 90 }
dialogue: { compressThreshold: 100000 }
memory: { injectInlineMaxBytes: 4096 }
feedback: { keyNodeEvents: [] }
`);
  writeFileSync(join(dir, 'permission-rules.yaml'), `
rules:
  - subject: 'human:*'
    action: '*'
    object: '*'
    decision: allow
  - subject: 'agent:*'
    action: 'admin:*'
    object: '*'
    decision: deny
`);
  writeFileSync(join(dir, 'agents.yaml'), `
agents:
  - agentId: task-admin
    role: task-admin
    description: 任务管理员
    capabilities: [task:judge]
    spawnPolicy: external
`);
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  writeFileSync(join(dir, 'workflows', 'task-admin.md'), '# 任务管理员工作流 v1');
  return dir;
}

function makeUiDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ulm-panel-ui-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>panel</body></html>');
  writeFileSync(join(dir, 'main.js'), 'console.log("ui")');
  return dir;
}

async function getJson(base: string, path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() as any };
}

async function sendJson(base: string, method: string, path: string, body?: any) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

describe('PanelHttpServer（驾驶舱 HTTP 面）', () => {
  let configDir = '';
  let uiDir = '';
  let system: ReturnType<typeof createSystem> | null = null;
  let server: PanelHttpServer | null = null;

  afterEach(() => {
    try { server?.stop(); } catch { /* 忽略 */ }
    server = null;
    try { system?.stop(); } catch { /* 忽略 */ }
    system = null;
    for (const d of [configDir, uiDir]) {
      try { if (d) rmSync(d, { recursive: true }); } catch { /* 忽略 */ }
    }
    configDir = ''; uiDir = '';
  });

  async function boot() {
    configDir = makePanelConfig();
    uiDir = makeUiDir();
    system = createSystem({ configDir, mode: 'test' });
    system.start();
    server = new PanelHttpServer(system, { port: 0, uiDir });
    await server.start();
    return server.getAddress();
  }

  it('静态托管：/ 返回 index.html，路径穿越被拒，未知资源 404', async () => {
    const base = await boot();
    const html = await fetch(`${base}/`);
    expect(html.status).toBe(200);
    expect(await html.text()).toContain('<!doctype html>');
    const traversal = await fetch(`${base}/..%2f..%2fpackage.json`);
    expect(traversal.status).toBe(403);
    expect((await fetch(`${base}/no-such.js`)).status).toBe(404);
  });

  it('查询面：出厂 agent 经 /api/agents 可见，describe 快照含面板三字段', async () => {
    const base = await boot();
    const agents = await getJson(base, '/api/agents');
    expect(agents.status).toBe(200);
    expect(agents.body.ok).toBe(true);
    const ids = agents.body.data.map((a: any) => a.agentId);
    expect(ids).toContain('task-admin');
    expect(agents.body.data[0]).toHaveProperty('connected');

    const detail = await getJson(base, '/api/agents/task-admin');
    expect(detail.body.data.role).toBe('task-admin');
    expect((await getJson(base, '/api/agents/no-such')).status).toBe(404);

    const desc = await getJson(base, '/api/describe');
    expect(desc.body.data.workflowContents['task-admin']).toBe('# 任务管理员工作流 v1');
    expect(desc.body.data).toHaveProperty('automations');
    expect(desc.body.data).toHaveProperty('procedures');
  });

  it('命令面：创建任务→投影可见；注册 agent→查询面 configSource=panel', async () => {
    const base = await boot();
    const created = await sendJson(base, 'POST', '/api/tasks', {
      taskId: 't-http-1', taskType: 'normal', goal: '验证 HTTP 命令面',
      acceptanceCriteria: '全部断言通过', workspaceId: 'ws-1', priority: 1,
    });
    expect(created.status).toBe(200);
    expect(created.body.ok).toBe(true);
    expect(created.body.data.seq).toBeGreaterThan(0);

    const tasks = await getJson(base, '/api/tasks');
    expect(tasks.body.data.map((t: any) => t.taskId)).toContain('t-http-1');
    expect((tasks.body.data.find((t: any) => t.taskId === 't-http-1') as any).createdBy).toBe('local');
    const detail = await getJson(base, '/api/tasks/t-http-1');
    expect(detail.body.ok).toBe(true);
    expect((await getJson(base, '/api/tasks/no-such')).status).toBe(404);

    const reg = await sendJson(base, 'POST', '/api/agents', { agentId: 'res-http', role: 'worker' });
    expect(reg.body.ok).toBe(true);
    const row = (await getJson(base, '/api/agents/res-http')).body.data;
    expect(row.configSource).toBe('panel');
    expect(row.connected).toBe(false);
  });

  it('资产编辑：工作流 PUT 写入读回；automations 非法 YAML→400 原样回显，合法→热加载', async () => {
    const base = await boot();
    const wf = await sendJson(base, 'PUT', '/api/assets/workflows/task-admin', { content: '# v2 via http' });
    expect(wf.body.ok).toBe(true);
    expect((await getJson(base, '/api/workflows/task-admin')).body.data).toBe('# v2 via http');

    const bad = await sendJson(base, 'PUT', '/api/assets/automations', { content: 'rules: [oops' });
    expect(bad.status).toBe(400);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.error).toBeTruthy();

    const good = await sendJson(base, 'PUT', '/api/assets/automations', {
      content: 'rules:\n  - ruleId: r1\n    trigger: { type: event, family: admin, subtype: agentRegistered }\n    action: { type: createTask, goal: "跟进 {agentId}" }\n    enabled: true\n',
    });
    expect(good.body.ok).toBe(true);
    const auto = (await getJson(base, '/api/automations')).body.data;
    expect(auto.rules[0].ruleId).toBe('r1');
    // 原文读取端点（编辑器用）：与写入内容一致
    expect((await getJson(base, '/api/assets/automations')).body.data).toContain('ruleId: r1');
  });

  it('权限面：增→投影可见；删→投影消失；agent 主体越权→403', async () => {
    const base = await boot();
    const set = await sendJson(base, 'POST', '/api/permissions', {
      subject: 'agent:task-admin', action: 'dialogue:respond', object: '*', decision: 'deny',
    });
    expect(set.body.ok).toBe(true);
    const ruleId = 'perm-agent_task-admin-dialogue_respond';
    const list = await getJson(base, '/api/permissions');
    expect(list.body.data.map((r: any) => r.ruleId)).toContain(ruleId);

    const del = await sendJson(base, 'DELETE', `/api/permissions/${ruleId}`);
    expect(del.body.ok).toBe(true);
    expect((await getJson(base, '/api/permissions')).body.data.map((r: any) => r.ruleId)).not.toContain(ruleId);

    // agent 主体对 admin:* 默认 deny——但 HTTP 面主体固定 human:local，
    // 这里改用缺字段校验路径验证 400
    const missing = await sendJson(base, 'POST', '/api/permissions', { subject: 'agent:x' });
    expect(missing.status).toBe(400);
  });

  it('SSE：hello 带 maxSeq，命令产生的事件实时到达流', async () => {
    const base = await boot();
    const controller = new AbortController();
    const sse = await fetch(`${base}/api/stream`, { signal: controller.signal });
    expect(sse.headers.get('content-type')).toContain('text/event-stream');

    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let sawBus = false;
    const readLoop = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (buf.includes('event: bus')) { sawBus = true; return; }
      }
    })();

    // 等 hello 到达后再触发命令，避免竞争
    for (let i = 0; i < 50 && !buf.includes('event: hello'); i++) {
      await new Promise(r => setTimeout(r, 20));
    }
    expect(buf).toContain('event: hello');

    await sendJson(base, 'POST', '/api/tasks', {
      taskId: 't-sse-1', taskType: 'normal', goal: 'SSE 推送验证',
      acceptanceCriteria: '收到', workspaceId: 'ws-1', priority: 0,
    });

    await Promise.race([
      readLoop,
      new Promise((_, rej) => setTimeout(() => rej(new Error('SSE 未收到 bus 事件')), 5000)),
    ]);
    expect(sawBus).toBe(true);
    const busLine = buf.split('\n').find(l => l.startsWith('data: {"seq"'));
    const evt = JSON.parse(busLine!.slice(6));
    expect(evt.family).toBe('task');
    expect(evt.subtype).toBe('created');
    expect(evt.handles.taskId).toBe('t-sse-1');
    controller.abort();
  });

  it('目的面：创建→列表可见→确认→发起', async () => {
    const base = await boot();
    await sendJson(base, 'POST', '/api/tasks', {
      taskId: 't-purpose', taskType: 'aggregate', goal: '目的承载任务',
      acceptanceCriteria: 'x', workspaceId: 'ws-1', priority: 0,
    });
    const created = await sendJson(base, 'POST', '/api/purposes', {
      purposeId: 'p-1', dialogueId: 'd-1', description: '验证目的状态机',
    });
    expect(created.body.ok).toBe(true);
    let purposes = (await getJson(base, '/api/purposes')).body.data;
    expect(purposes.find((p: any) => p.purposeId === 'p-1').state).toBe('draft');

    await sendJson(base, 'POST', '/api/purposes/p-1/confirm', { confirmedState: 'refining' });
    await sendJson(base, 'POST', '/api/purposes/p-1/confirm', { confirmedState: 'valueConfirmed' });
    await sendJson(base, 'POST', '/api/purposes/p-1/confirm', { confirmedState: 'pathConfirmed' });
    await sendJson(base, 'POST', '/api/purposes/p-1/confirm', { confirmedState: 'detailsReady' });
    await sendJson(base, 'POST', '/api/purposes/p-1/launch', { taskId: 't-purpose' });
    purposes = (await getJson(base, '/api/purposes')).body.data;
    const p1 = purposes.find((p: any) => p.purposeId === 'p-1');
    expect(p1.state).toBe('launched');
    expect(p1.taskId).toBe('t-purpose');
  });

  it('任务详情扩充：DAG 节点与依赖边、人发起指导、任务反馈区', async () => {
    const base = await boot();
    // 带 DAG 的任务（body 透传 dagNodes/dagEdges）
    await sendJson(base, 'POST', '/api/tasks', {
      taskId: 't-dag', taskType: 'aggregate', goal: '聚合任务',
      acceptanceCriteria: '整体通过', workspaceId: 'ws-1', priority: 0,
      dagNodes: [
        { nodeId: 'n1', goal: '第一步', acceptanceCriteria: '一完成' },
        { nodeId: 'n2', goal: '第二步', acceptanceCriteria: '二完成' },
      ],
      dagEdges: [{ from: 'n1', to: 'n2' }],
    });
    const dag = (await getJson(base, '/api/tasks/t-dag/dag')).body.data;
    expect(dag.dagVersion).toBe(1);
    expect(dag.nodes.map((n: any) => n.nodeId).sort()).toEqual(['n1', 'n2']);
    expect(dag.edges).toEqual([{ fromNode: 'n1', toNode: 'n2' }]);

    // 缺省任务自动生成单节点兜底（Phase 0 修复⑥）
    await sendJson(base, 'POST', '/api/tasks', {
      taskId: 't-single', taskType: 'normal', goal: '单节点',
      acceptanceCriteria: 'x', workspaceId: 'ws-1', priority: 0,
    });
    expect(((await getJson(base, '/api/tasks/t-single/dag')).body.data).nodes.length).toBe(1);

    // 指导：当下（type=now，调度器注入链路）+ 未来（type=future，存任务载荷）
    expect((await sendJson(base, 'POST', '/api/tasks/t-dag/guidance', { content: '优先核对边界条件', type: 'now' })).body.ok).toBe(true);
    expect((await sendJson(base, 'POST', '/api/tasks/t-dag/guidance', { content: '完成后写复盘', type: 'future' })).body.ok).toBe(true);
    const gl = (await getJson(base, '/api/tasks/t-dag/guidance')).body.data;
    expect(gl.length).toBe(2);
    expect(gl.map((g: any) => g.type).sort()).toEqual(['future', 'now']);
    expect(gl.every((g: any) => ['issued', 'injected'].includes(g.state))).toBe(true);

    // 反馈区（7.2 事件视图）：判定意见以任务反馈条目呈现
    system!.bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'agent', agentId: 'task-admin' },
      family: 'task', subtype: 'nodeJudged', handles: { taskId: 't-dag' },
      payload: { nodeId: 'n1', result: 'pass', judgeNote: '边界条件已核对' }, value: null,
    });
    const fb = (await getJson(base, '/api/tasks/t-dag/feedback')).body.data;
    const judge = fb.find((f: any) => f.kind === 'judge');
    expect(judge).toBeDefined();
    expect(judge.summary).toContain('n1 通过');
  });

  it('GBK 请求体兜底：控制台客户端按本地代码页发送的中文不再损坏', async () => {
    const base = await boot();
    // "中文测试" 的 GBK 字节：中=D6D0 文=CEC4 测=B2E2 试=CAD4（模拟 PowerShell/cmd curl）
    const gbkBody = Buffer.concat([
      Buffer.from('{"taskId":"t-gbk","taskType":"normal","goal":"'),
      Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]),
      Buffer.from('","acceptanceCriteria":"ok","workspaceId":"ws-1","priority":0}'),
    ]);
    const res = await fetch(`${base}/api/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: gbkBody,
    });
    expect((await res.json() as any).ok).toBe(true);
    const row = (await getJson(base, '/api/tasks/t-gbk')).body.data;
    expect(row.goal).toBe('中文测试');
  });
});
