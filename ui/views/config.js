// 配置资产区（培育板块）：automations 编辑（热加载）、工序模板、权限规则增删
import { get, post, put, del } from '../api.js';
import { el, fmtDateTime, renderTable } from '../util.js';

const EFFECT_BADGE = { allow: 'green', deny: 'red', 'require-approval': 'amber' };

export function render(container, ctx) {
  container.innerHTML = '';

  // ---- automations 编辑（保存 → 语法先验 + git 提交 + ruleChanged 热加载）----
  const autoBox = el('textarea', { class: 'editor', placeholder: 'automations.yaml 原文' });
  get('/api/assets/automations').then(raw => {
    autoBox.value = raw ?? '# automations.yaml 尚未创建\nrules: []\n';
  }).catch(() => {});
  const autoSave = el('button', {
    class: 'primary', onclick: async () => {
      try {
        await put('/api/assets/automations', { content: autoBox.value });
        ctx.toast('automations 已保存并热加载（git 版本化）', 'ok');
      } catch (err) { ctx.toast(err.message, 'err'); }
    },
  }, '保存并热加载');

  // ---- 工序模板 ----
  const procList = el('span', {});
  const procName = el('input', { placeholder: '模板名（如 normal）', style: 'max-width:160px;' });
  const procBox = el('textarea', { class: 'editor', placeholder: 'procedures/<name>.yaml 原文' });
  async function loadProcs() {
    try {
      const procs = await get('/api/procedures');
      procList.innerHTML = '';
      if (!procs.length) { procList.append(el('span', { class: 'empty' }, '暂无工序模板')); return; }
      for (const p of procs) {
        procList.append(el('button', {
          class: 'small', onclick: async () => {
            procName.value = p.name;
            const raw = await get(`/api/assets/procedures/${p.name}`);
            procBox.value = raw ?? '';
          },
        }, p.name), ' ');
      }
    } catch (err) { ctx.toast(err.message, 'err'); }
  }
  const procSave = el('button', {
    onclick: async () => {
      const name = procName.value.trim();
      if (!name) { ctx.toast('请填写模板名', 'err'); return; }
      try {
        await put(`/api/assets/procedures/${name}`, { content: procBox.value });
        ctx.toast(`工序模板 ${name} 已保存（git 版本化）`, 'ok');
        await loadProcs();
      } catch (err) { ctx.toast(err.message, 'err'); }
    },
  }, '保存模板');

  // ---- 权限规则 ----
  const permWrap = el('div');
  async function loadPerms() {
    try {
      const rules = await get('/api/permissions');
      renderTable(permWrap, rules, [
        { key: 'ruleId', label: '规则 ID', class: 'mono' },
        { key: 'subject', label: '主体', class: 'mono' },
        { key: 'action', label: '动作', class: 'mono' },
        { key: 'effect', label: '决策', render: r => el('span', { class: `badge ${EFFECT_BADGE[r.effect] ?? ''}` }, r.effect) },
        { key: 'updatedAt', label: '更新时间', render: r => fmtDateTime(r.updatedAt) },
        {
          key: '_del', label: '', render: r => el('button', {
            class: 'small danger', onclick: async (e) => {
              e.stopPropagation();
              if (!confirm(`删除权限规则 ${r.ruleId}？`)) return;
              try {
                await del(`/api/permissions/${r.ruleId}`);
                ctx.toast(`规则 ${r.ruleId} 已删除`, 'ok');
                await loadPerms();
              } catch (err) { ctx.toast(err.message, 'err'); }
            },
          }, '删除'),
        },
      ], { empty: '暂无权限规则' });
    } catch (err) { ctx.toast(err.message, 'err'); }
  }

  const pSubject = el('input', { placeholder: '主体，如 human:* / agent:res-01' });
  const pAction = el('input', { placeholder: '动作，如 doc:read' });
  const pObject = el('input', { placeholder: '对象，如 * 或 task:t-1', value: '*' });
  const pDecision = el('select', {},
    el('option', { value: 'allow' }, 'allow（放行）'),
    el('option', { value: 'deny' }, 'deny（拒绝）'),
    el('option', { value: 'require-approval' }, 'require-approval（需审批）'));
  const permForm = el('form', {
    class: 'grid',
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        await post('/api/permissions', {
          subject: pSubject.value.trim(), action: pAction.value.trim(),
          object: pObject.value.trim(), decision: pDecision.value,
        });
        ctx.toast('权限规则已设置（热改生效 + 落盘）', 'ok');
        pSubject.value = ''; pAction.value = '';
        await loadPerms();
      } catch (err) { ctx.toast(err.message, 'err'); }
    },
  },
    el('label', {}, '主体', pSubject),
    el('label', {}, '动作', pAction),
    el('label', {}, '对象', pObject),
    el('label', {}, '决策', pDecision),
    el('button', { class: 'primary', type: 'submit' }, '设置规则'));

  container.append(
    el('h2', {}, '配置资产区'),
    el('section', { class: 'card' },
      el('div', { class: 'cardhead' }, '自动化规则', el('span', { class: 'sub' }, 'automations.yaml · 保存触发 admin:ruleChanged 热加载')),
      autoBox, el('div', { style: 'margin-top:6px;' }, autoSave)),
    el('section', { class: 'card' },
      el('div', { class: 'cardhead' }, '工序模板', el('span', { class: 'sub' }, 'procedures/*.yaml · 任务拆解 DAG 模板')),
      el('div', { style: 'margin-bottom:8px;' }, procList),
      el('form', { class: 'grid', onsubmit: (e) => e.preventDefault() },
        el('label', {}, '模板名', procName),
        el('button', { type: 'button', onclick: async () => { procBox.value = (await get(`/api/assets/procedures/${procName.value.trim()}`)) ?? ''; } }, '加载 / 新建')),
      procBox, el('div', { style: 'margin-top:6px;' }, procSave)),
    el('section', { class: 'card' },
      el('div', { class: 'cardhead' }, '权限规则', el('span', { class: 'sub' }, '热改门禁 + 落盘 permission-rules.yaml')),
      permForm,
      el('div', { style: 'margin-top:10px;' }, permWrap)));

  ctx.onBus(() => { loadPerms(); loadProcs(); });
  loadProcs();
  loadPerms();
}
