// Agent 区（培育板块）：注册/移除、运行态一视图、托管动作、工作流编辑（GitAsset 版本化）
import { get, post, put, del } from '../api.js';
import { el, fmtDateTime, stateBadge, connDot, renderTable } from '../util.js';

export function render(container, ctx) {
  container.innerHTML = '';

  // ---- 注册 agent ----
  const fId = el('input', { name: 'agentId', required: true, placeholder: '如 res-01' });
  const fRole = el('input', { name: 'role', required: true, placeholder: '如 worker' });
  const fDesc = el('input', { name: 'description', placeholder: '一句话描述（可选）' });
  const fCaps = el('input', { name: 'capabilities', placeholder: '逗号分隔，如 doc:read, task:judge（可选）' });
  const fSpawn = el('select', { name: 'spawnPolicy' },
    el('option', { value: 'external' }, 'external（外部拉起）'),
    el('option', { value: 'spawn' }, 'spawn（基座托管拉起）'));

  const form = el('form', {
    class: 'grid',
    onsubmit: async (e) => {
      e.preventDefault();
      const caps = fCaps.value.split(',').map(s => s.trim()).filter(Boolean);
      try {
        await post('/api/agents', {
          agentId: fId.value.trim(), role: fRole.value.trim(), description: fDesc.value.trim() || null,
          capabilities: caps, spawnPolicy: fSpawn.value, enabled: true,
        });
        ctx.toast(`agent ${fId.value} 已注册`, 'ok');
        form.reset();
        await load();
      } catch (err) { ctx.toast(err.message, 'err'); }
    },
  },
    el('label', {}, 'Agent ID', fId),
    el('label', {}, '角色', fRole),
    el('label', {}, '描述', fDesc),
    el('label', {}, '能力声明', fCaps),
    el('label', {}, '托管档位', fSpawn),
    el('button', { class: 'primary', type: 'submit' }, '注册 / 更新'));

  const listWrap = el('div');
  const detailCard = el('section', { class: 'card', hidden: true });
  let agents = [];

  async function load() {
    try {
      agents = await get('/api/agents');
      paintList();
      const openId = detailCard.dataset.agentId;
      if (openId) showDetail(openId);
    } catch (err) { ctx.toast(err.message, 'err'); }
  }

  function paintList() {
    renderTable(listWrap, agents, [
      { key: 'agentId', label: 'Agent', class: 'mono' },
      { key: 'role', label: '角色' },
      { key: 'spawnPolicy', label: '档位' },
      { key: 'configSource', label: '来源' },
      { key: 'enabled', label: '启用', render: r => r.enabled ? el('span', { class: 'badge green' }, 'enabled') : el('span', { class: 'badge' }, 'disabled') },
      { key: 'connected', label: '连接', render: r => el('span', {}, connDot(r.connected, r.lost), r.connected ? '在线' : (r.lost ? '失联' : '离线')) },
      { key: 'wakeState', label: '唤醒态', render: r => stateBadge(r.wakeState ?? '-') },
      { key: 'workState', label: '工作态', render: r => stateBadge(r.workState ?? '-') },
    ], { onRowClick: r => showDetail(r.agentId) });
  }

  async function manage(a, action) {
    try {
      await post(`/api/agents/${a.agentId}/manage`, { action });
      ctx.toast(`${a.agentId} ${action} 指令已下发`, 'ok');
      await load();
    } catch (err) { ctx.toast(err.message, 'err'); }
  }

  async function removeAgent(a) {
    if (!confirm(`确定移除 agent ${a.agentId}？注册表条目将被删除。`)) return;
    try {
      await del(`/api/agents/${a.agentId}`);
      ctx.toast(`agent ${a.agentId} 已移除`, 'ok');
      await load();
    } catch (err) { ctx.toast(err.message, 'err'); }
  }

  function showDetail(agentId) {
    const a = agents.find(x => x.agentId === agentId);
    if (!a) return;
    detailCard.hidden = false;
    detailCard.dataset.agentId = agentId;
    detailCard.innerHTML = '';

    const caps = (a.capabilities ?? []);
    detailCard.append(
      el('div', { class: 'cardhead' }, `Agent：${a.agentId}`,
        el('span', {},
          el('button', { class: 'small', onclick: () => manage(a, 'start') }, 'start'),
          ' ',
          el('button', { class: 'small', onclick: () => manage(a, 'stop') }, 'stop'),
          ' ',
          el('button', { class: 'small', onclick: () => manage(a, 'restart') }, 'restart'),
          ' ',
          el('button', { class: 'small danger', onclick: () => removeAgent(a) }, '移除'))),
      el('div', { class: 'detailgrid' },
        cell('角色', a.role), cell('档位', a.spawnPolicy), cell('来源', a.configSource),
        cell('连接', a.connected ? `在线（${a.connId ?? ''}）` : (a.lost ? '失联' : '离线')),
        cell('唤醒态', a.wakeState ?? '—'), cell('工作态', a.workState ?? '—'),
        cell('最近活动', fmtDateTime(a.lastActivityAt)), cell('注册时间', fmtDateTime(a.createdAt))),
      el('div', {}, el('b', {}, '描述'), el('div', {}, a.description ?? '—')),
      el('div', { style: 'margin-top:6px;' }, el('b', {}, '能力'),
        caps.length ? el('span', {}, ...caps.map(c => el('span', { class: 'chip' }, c))) : el('span', { class: 'empty' }, '无')));

    // 工作流编辑（GitAsset 版本化：每次保存产生 panel edit 提交）
    const wfBox = el('textarea', { class: 'editor', placeholder: '该 agent 的工作流文档（Markdown/YAML）' });
    get(`/api/workflows/${a.agentId}`).then(raw => { wfBox.value = raw ?? ''; }).catch(() => {});
    detailCard.append(
      el('div', { style: 'margin-top:10px;' },
        el('b', {}, '工作流文档', el('span', { class: 'sub' }, 'git 资产 · 保存即提交版本')),
        wfBox,
        el('div', { style: 'margin-top:6px;' },
          el('button', {
            class: 'primary', onclick: async () => {
              try {
                await put(`/api/assets/workflows/${a.agentId}`, { content: wfBox.value });
                ctx.toast(`工作流 ${a.agentId} 已保存（git 版本化）`, 'ok');
              } catch (err) { ctx.toast(err.message, 'err'); }
            },
          }, '保存工作流'))));
  }

  const cell = (k, v) => el('div', { class: 'cell' }, el('b', {}, k), el('span', { class: 'mono' }, String(v ?? '—')));

  container.append(
    el('h2', {}, 'Agent 区'),
    el('section', { class: 'card' },
      el('details', {}, el('summary', { style: 'cursor:pointer;font-weight:600;' }, '注册 / 更新 agent'), el('div', { style: 'margin-top:10px;' }, form))),
    el('section', { class: 'card' },
      el('div', { class: 'cardhead' }, 'Agent 注册表（身份 × 运行态一视图）',
        el('button', { class: 'small', onclick: load }, '刷新')),
      listWrap),
    detailCard);

  ctx.onBus(() => load());
  load();
}
