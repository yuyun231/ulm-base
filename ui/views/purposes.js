// 目的区（使用板块，设计锚点 7.5）：目的＝git 无关的状态机
// draft → refining → valueConfirmed → pathConfirmed → detailsReady → launched
import { get, post } from '../api.js';
import { el, fmtDateTime, stateBadge, renderTable } from '../util.js';

const NEXT = {
  draft: 'refining',
  refining: 'valueConfirmed',
  valueConfirmed: 'pathConfirmed',
  pathConfirmed: 'detailsReady',
  detailsReady: null, // detailsReady 的下一步是「发起」，需要 taskId
};

export function render(container, ctx) {
  container.innerHTML = '';

  // ---- 创建目的 ----
  const fId = el('input', { name: 'purposeId', required: true, value: `p-${Date.now()}` });
  const fDialogue = el('input', { name: 'dialogueId', required: true, value: `d-${Date.now()}` });
  const fDesc = el('textarea', { name: 'description', rows: 2, required: true, placeholder: '目的描述（要达成什么）' });

  const form = el('form', {
    class: 'grid',
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        await post('/api/purposes', { purposeId: fId.value.trim(), dialogueId: fDialogue.value.trim(), description: fDesc.value });
        ctx.toast(`目的 ${fId.value} 已创建`, 'ok');
        await load();
      } catch (err) { ctx.toast(err.message, 'err'); }
    },
  },
    el('label', {}, '目的 ID', fId),
    el('label', {}, '目的对话 ID', fDialogue),
    el('label', {}, '描述', fDesc),
    el('button', { class: 'primary', type: 'submit' }, '创建目的'));

  const listWrap = el('div');
  const detailCard = el('section', { class: 'card', hidden: true });
  let purposes = [];

  async function load() {
    try {
      purposes = await get('/api/purposes');
      paintList();
      const openId = detailCard.dataset.purposeId;
      if (openId) showDetail(openId);
    } catch (err) { ctx.toast(err.message, 'err'); }
  }

  function paintList() {
    renderTable(listWrap, purposes, [
      { key: 'purposeId', label: '目的 ID', class: 'mono' },
      { key: 'state', label: '状态', render: r => stateBadge(r.state) },
      { key: 'description', label: '描述', class: 'trunc' },
      { key: 'taskId', label: '承载任务', render: r => r.taskId ?? '—' },
      { key: 'updatedAt', label: '更新时间', render: r => fmtDateTime(r.updatedAt) },
    ], { onRowClick: r => showDetail(r.purposeId) });
  }

  async function confirmNext(p) {
    const next = NEXT[p.state];
    if (!next) return;
    try {
      await post(`/api/purposes/${p.purposeId}/confirm`, { confirmedState: next });
      ctx.toast(`${p.purposeId} → ${next}`, 'ok');
      await load();
    } catch (err) { ctx.toast(err.message, 'err'); }
  }

  async function launch(p, taskId) {
    try {
      await post(`/api/purposes/${p.purposeId}/launch`, { taskId });
      ctx.toast(`${p.purposeId} 已发起（任务 ${taskId}）`, 'ok');
      await load();
    } catch (err) { ctx.toast(err.message, 'err'); }
  }

  function showDetail(purposeId) {
    const p = purposes.find(x => x.purposeId === purposeId);
    if (!p) return;
    detailCard.hidden = false;
    detailCard.dataset.purposeId = purposeId;
    detailCard.innerHTML = '';

    const head = el('div', { class: 'cardhead' }, `目的：${p.purposeId} `, stateBadge(p.state),
      el('button', { class: 'small', onclick: () => { detailCard.hidden = true; delete detailCard.dataset.purposeId; } }, '关闭'));

    const body = el('div', {},
      el('div', { class: 'detailgrid' },
        cell('目的对话', p.dialogueId), cell('承载任务', p.taskId ?? '—'),
        cell('创建', fmtDateTime(p.createdAt)), cell('更新', fmtDateTime(p.updatedAt))),
      el('div', {}, el('b', {}, '描述'), el('div', {}, p.description ?? '')));

    detailCard.append(head, body);

    if (NEXT[p.state]) {
      detailCard.append(el('div', { style: 'margin-top:10px;' },
        el('button', { class: 'primary', onclick: () => confirmNext(p) }, `确认 → ${NEXT[p.state]}`)));
    } else if (p.state === 'detailsReady') {
      const taskInput = el('input', { placeholder: '承载任务 ID（如 t-1）', list: 'dl-tasks' });
      get('/api/tasks').then(rows => {
        const dl = el('datalist', { id: 'dl-tasks' }, ...rows.map(t => el('option', { value: t.taskId }, `${t.goal ?? ''}`)));
        detailCard.append(dl);
      }).catch(() => {});
      detailCard.append(el('div', { style: 'margin-top:10px;display:flex;gap:8px;align-items:end;' },
        el('label', { style: 'max-width:320px;' }, '发起：选择/输入承载任务', taskInput),
        el('button', { class: 'primary', onclick: () => taskInput.value.trim() && launch(p, taskInput.value.trim()) }, '发起行动')));
    } else {
      detailCard.append(el('div', { class: 'empty' }, '目的已发起，事件链见反馈区'));
    }
  }

  const cell = (k, v) => el('div', { class: 'cell' }, el('b', {}, k), el('span', { class: 'mono' }, String(v ?? '—')));

  container.append(
    el('h2', {}, '目的区'),
    el('section', { class: 'card' },
      el('details', {}, el('summary', { style: 'cursor:pointer;font-weight:600;' }, '创建目的'), el('div', { style: 'margin-top:10px;' }, form))),
    el('section', { class: 'card' },
      el('div', { class: 'cardhead' }, '目的列表',
        el('button', { class: 'small', onclick: load }, '刷新')),
      listWrap),
    detailCard);

  ctx.onBus(() => load());
  load();
}
