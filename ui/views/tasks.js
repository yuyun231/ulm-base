// 任务区（使用板块）：创建 + 列表 + 详情（DAG 节点图 / 指导区 / 反馈区 / 子任务）
import { get, post } from '../api.js';
import { el, fmtTime, fmtDateTime, stateBadge, renderTable, subjectLabel } from '../util.js';

// 指导生命周期（7.10/7.11）：issued → injected → acked → closed
const GUID_STATE = { issued: ['待注入', ''], injected: ['已注入', 'blue'], acked: ['已回执', 'green'], closed: ['已闭环', 'green'] };
// 反馈条目类型（P.5 feedbackZone kind）
const FB_KIND = { issue: ['问题上报', 'red'], judge: ['判定意见', 'amber'], 'guidance-ack': ['指导回执', 'blue'], ack: ['指令回执', ''], verdict: ['价值裁决', 'green'] };

export function render(container, ctx) {
  container.innerHTML = '';

  // ---- 创建任务 ----
  const fTaskId = el('input', { name: 'taskId', required: true, value: `t-${Date.now()}` });
  const fType = el('select', { name: 'taskType' },
    el('option', { value: 'normal' }, 'normal（普通任务）'),
    el('option', { value: 'aggregate' }, 'aggregate（聚合任务）'));
  const fGoal = el('textarea', { name: 'goal', rows: 2, required: true, placeholder: '任务目标' });
  const fCriteria = el('textarea', { name: 'acceptanceCriteria', rows: 2, required: true, placeholder: '验收标准（task-admin 判定基线）' });
  const fWs = el('input', { name: 'workspaceId', required: true, value: 'ws-1' });
  const fPriority = el('input', { name: 'priority', type: 'number', value: '0' });

  const form = el('form', {
    class: 'grid',
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        await post('/api/tasks', {
          taskId: fTaskId.value.trim(), taskType: fType.value, goal: fGoal.value,
          acceptanceCriteria: fCriteria.value, workspaceId: fWs.value.trim(),
          priority: Number(fPriority.value) || 0,
        });
        ctx.toast(`任务 ${fTaskId.value} 已创建`, 'ok');
        await load();
      } catch (err) { ctx.toast(err.message, 'err'); }
    },
  },
    el('label', {}, '任务 ID', fTaskId),
    el('label', {}, '类型', fType),
    el('label', { style: 'grid-column: span 2;' }, '目标', fGoal),
    el('label', { style: 'grid-column: span 2;' }, '验收标准', fCriteria),
    el('label', {}, '工作区', fWs),
    el('label', {}, '优先级', fPriority),
    el('button', { class: 'primary', type: 'submit' }, '创建任务'));

  const listWrap = el('div');
  const detailCard = el('section', { class: 'card', hidden: true });
  let allTasks = [];
  let guidanceDraft = ''; // 详情卡实时刷新时保留正在输入的指导草稿
  let tickerEl = null;    // 当前打开任务的实时活动行（organ 事件轻刷新）

  async function load() {
    try {
      allTasks = await get('/api/tasks');
      paintList();
      const openId = detailCard.dataset.taskId;
      if (openId) showDetail(openId);
    } catch (err) { ctx.toast(err.message, 'err'); }
  }

  function paintList() {
    renderTable(listWrap, allTasks, [
      { key: 'taskId', label: '任务 ID', class: 'mono' },
      { key: 'taskType', label: '类型' },
      { key: 'state', label: '状态', render: r => stateBadge(r.state) },
      { key: 'goal', label: '目标', class: 'trunc' },
      { key: 'assignedAgent', label: '执行 agent', class: 'mono' },
      { key: 'priority', label: '优先级' },
      { key: 'createdAt', label: '创建时间', render: r => fmtDateTime(r.createdAt) },
    ], { onRowClick: r => showDetail(r.taskId) });
  }

  // ---- 详情卡 ----

  const cell = (k, v) => el('div', { class: 'cell' }, el('b', {}, k), el('span', { class: 'mono' }, String(v ?? '—')));

  // DAG 主枝渲染：按最长路径分层横向排列，列间箭头；当前执行节点高亮
  function paintDag(wrap, dag, taskState) {
    wrap.innerHTML = '';
    if (!dag.nodes.length) {
      wrap.append(el('div', { class: 'empty' }, '无 DAG 节点'));
      return;
    }
    const depth = new Map(dag.nodes.map(n => [n.nodeId, 0]));
    for (let i = 0; i < dag.nodes.length; i++) {
      for (const e of dag.edges) {
        if (depth.has(e.fromNode) && depth.has(e.toNode)) {
          depth.set(e.toNode, Math.max(depth.get(e.toNode), depth.get(e.fromNode) + 1));
        }
      }
    }
    const ordered = [...dag.nodes].sort((a, b) =>
      (depth.get(a.nodeId) - depth.get(b.nodeId)) || a.nodeId.localeCompare(b.nodeId));
    const doneCount = dag.nodes.filter(n => n.nodeState === 'done').length;
    // 「跑到哪一步」：任务进行中时，拓扑序第一个未完成节点即当前执行节点
    const currentNode = taskState === 'inProgress' ? ordered.find(n => n.nodeState !== 'done') : null;
    wrap.append(el('div', { class: 'dim', style: 'margin-bottom:6px;font-size:12px;' },
      `进度 ${doneCount}/${dag.nodes.length}`,
      currentNode ? el('span', { class: 'badge blue', style: 'margin-left:8px;' }, `▶ 当前：${currentNode.nodeId}`) : null));
    const maxDepth = Math.max(...depth.values());
    const row = el('div', { class: 'dagrow' });
    for (let d = 0; d <= maxDepth; d++) {
      if (d > 0) row.append(el('div', { class: 'dagarrow' }, '→'));
      const col = el('div', { class: 'dagcol' });
      for (const n of dag.nodes.filter(n => depth.get(n.nodeId) === d)) {
        const isCurrent = n === currentNode;
        col.append(el('div', { class: `dagnode${isCurrent ? ' current' : ''}` },
          el('div', {},
            el('span', { class: 'nid' }, n.nodeId),
            isCurrent ? el('span', { class: 'badge blue', style: 'margin-left:4px;' }, '▶ 执行中') : null,
            ' ', stateBadge(n.nodeState)),
          n.executor ? el('div', { class: 'dim' }, `executor: ${n.executor}`) : null,
          n.goal ? el('div', { class: 'trunc', style: 'max-width:200px;', title: n.goal }, n.goal) : null));
      }
      row.append(col);
    }
    wrap.append(row);
    if (dag.edges.length) {
      wrap.append(el('div', { class: 'dim mono', style: 'margin-top:6px;font-size:11px;' },
        `依赖：${dag.edges.map(e => `${e.fromNode}→${e.toNode}`).join('  ')}（dagVersion=${dag.dagVersion}）`));
    }
  }

  // 指导区：发起（now=立即注入 / future=随 wake 载荷）+ 生命周期列表
  function paintGuidance(wrap, rows) {
    wrap.innerHTML = '';
    if (!rows.length) { wrap.append(el('div', { class: 'empty' }, '暂无指导')); return; }
    for (const g of rows) {
      const [gLabel, gCls] = GUID_STATE[g.state] ?? [g.state, ''];
      wrap.append(el('div', { class: 'fbitem' },
        el('div', {},
          el('span', { class: 'mono' }, g.guidanceId),
          ' ', el('span', { class: `badge ${g.type === 'now' ? 'blue' : 'amber'}` }, g.type === 'now' ? '当下' : '未来'),
          ' ', el('span', { class: `badge ${gCls}` }, gLabel),
          el('time', { style: 'float:right;color:var(--fg2);font-size:11px;' }, fmtDateTime(g.createdAt))),
        el('div', {}, g.content ?? ''),
        g.ackNote ? el('div', { class: 'dim' }, `回执：${g.ackNote}`) : null,
        el('div', { class: 'dim mono', style: 'font-size:11px;' }, `by ${g.issuedBy ?? '—'}`)));
    }
  }

  // 反馈区（7.2 事件视图）：问题上报 / 判定意见 / 指导回执 / 指令回执 / 价值裁决
  function paintFeedback(wrap, items) {
    wrap.innerHTML = '';
    if (!items.length) { wrap.append(el('div', { class: 'empty' }, '暂无反馈条目')); return; }
    for (const it of items.slice().reverse()) {
      const [kLabel, kCls] = FB_KIND[it.kind] ?? [it.kind, ''];
      wrap.append(el('div', { class: 'fbitem' },
        el('div', {},
          el('span', { class: `badge ${kCls}` }, kLabel),
          it.seq != null ? el('span', { class: 'seq dim mono', style: 'margin-left:6px;font-size:11px;' }, `#${it.seq}`) : null,
          el('time', { style: 'float:right;color:var(--fg2);font-size:11px;' }, fmtDateTime(it.timestamp))),
        el('div', {}, it.summary ?? ''),
        el('div', { class: 'dim mono', style: 'font-size:11px;' }, `source: ${it.source ?? '—'}`)));
    }
  }

  function showDetail(taskId) {
    const t = allTasks.find(x => x.taskId === taskId);
    if (!t) return;
    detailCard.hidden = false;
    detailCard.dataset.taskId = taskId;
    detailCard.innerHTML = '';
    const children = allTasks.filter(x => x.parentTaskId === taskId);

    detailCard.append(
      el('div', { class: 'cardhead' }, `任务详情：${t.taskId} `, stateBadge(t.state),
        el('button', { class: 'small', onclick: () => { detailCard.hidden = true; delete detailCard.dataset.taskId; } }, '关闭')),
      el('div', { class: 'detailgrid' },
        cell('类型', t.taskType), cell('优先级', t.priority),
        cell('执行 agent', t.assignedAgent ?? '（未分配）'), cell('工作区', t.workspaceId),
        cell('DAG 版本', t.dagVersion), cell('父任务', t.parentTaskId ?? '—'),
        cell('对话', t.dialogueId ?? '—'), cell('创建时间', fmtDateTime(t.createdAt))),
      el('div', {}, el('b', {}, '目标'), el('div', {}, t.goal ?? '')),
      el('div', { style: 'margin-top:8px;' }, el('b', {}, '验收标准'), el('div', {}, t.acceptanceCriteria ?? '')),
      el('div', { style: 'margin-top:8px;' },
        el('b', {}, `子任务（${children.length}）`),
        children.length
          ? el('ul', {}, ...children.map(c => el('li', {}, el('span', { class: 'mono' }, c.taskId), ' ', stateBadge(c.state), ` ${c.goal ?? ''}`)))
          : el('div', { class: 'empty' }, '无子任务')));

    // ---- DAG 节点图 + 实时活动 ----
    const dagWrap = el('div');
    const loadDag = async () => {
      try { paintDag(dagWrap, await get(`/api/tasks/${taskId}/dag`), t.state); } catch (err) { ctx.toast(err.message, 'err'); }
    };
    tickerEl = el('div', { class: 'dim mono', style: 'font-size:11px;margin-top:6px;' }, '最近活动：—');
    detailCard.append(el('div', { style: 'margin-top:12px;' },
      el('b', {}, '执行 DAG', el('span', { class: 'sub' }, '模型实时执行进度')),
      dagWrap, tickerEl));

    // ---- 指导区 ----
    const guidWrap = el('div');
    const gContent = el('textarea', {
      rows: 2, placeholder: '指导内容（agent 行为层面的最高遵循优先级，不能解除基座硬控制）',
      oninput: (e) => { guidanceDraft = e.target.value; },
    });
    gContent.value = guidanceDraft;
    const gType = el('select', {},
      el('option', { value: 'now' }, '当下指导（立即经接缝注入当前执行）'),
      el('option', { value: 'future' }, '未来指导（存任务指导区，随唤醒载荷下发）'));
    const loadGuidance = async () => {
      try { paintGuidance(guidWrap, await get(`/api/tasks/${taskId}/guidance`)); } catch (err) { ctx.toast(err.message, 'err'); }
    };
    detailCard.append(el('div', { style: 'margin-top:12px;' },
      el('b', {}, '指导区'),
      el('form', {
        class: 'grid', style: 'margin:6px 0 10px;',
        onsubmit: async (e) => {
          e.preventDefault();
          if (!gContent.value.trim()) return;
          try {
            await post(`/api/tasks/${taskId}/guidance`, { content: gContent.value, type: gType.value });
            ctx.toast('指导已下发', 'ok');
            gContent.value = ''; guidanceDraft = '';
            await loadGuidance();
          } catch (err) { ctx.toast(err.message, 'err'); }
        },
      },
        el('label', { style: 'grid-column: span 2;' }, '内容', gContent),
        el('label', {}, '投递方式', gType),
        el('button', { class: 'primary', type: 'submit' }, '下发指导')),
      guidWrap));

    // ---- 反馈区 ----
    const fbWrap = el('div', { style: 'max-height:280px;overflow:auto;' });
    const loadFeedback = async () => {
      try { paintFeedback(fbWrap, await get(`/api/tasks/${taskId}/feedback`)); } catch (err) { ctx.toast(err.message, 'err'); }
    };
    detailCard.append(el('div', { style: 'margin-top:12px;' }, el('b', {}, '反馈区', el('span', { class: 'sub' }, '问题 / 判定 / 指导回执 / 指令回执')), fbWrap));

    loadDag(); loadGuidance(); loadFeedback();
  }

  // 相关族事件到达 → 若详情卡开着且事件指向该任务：
  // task 族（状态/节点推进）整卡刷新；organ 族（agent 动作/思考）只轻刷活动行——
  // 这就是「模型实时跑到哪一步」的心跳
  ctx.onBus((evt) => {
    const openId = detailCard.dataset.taskId;
    if (!openId || evt.handles?.taskId !== openId) return;
    if (evt.family === 'task') { showDetail(openId); return; }
    if (tickerEl && evt.family === 'organ') {
      tickerEl.textContent = `最近活动：${evt.family}:${evt.subtype} · ${subjectLabel(evt.subject)} · ${fmtTime(evt.timestamp)}`;
    }
  });

  container.append(
    el('h2', {}, '任务区'),
    el('section', { class: 'card' },
      el('details', {}, el('summary', { style: 'cursor:pointer;font-weight:600;' }, '创建任务'), el('div', { style: 'margin-top:10px;' }, form))),
    el('section', { class: 'card' },
      el('div', { class: 'cardhead' }, '任务列表',
        el('button', { class: 'small', onclick: load }, '刷新')),
      listWrap),
    detailCard);

  load();
}
