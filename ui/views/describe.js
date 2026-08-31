// 自我认知区（培育板块，设计锚点 7.6）：describe() 快照渲染。
// 事实层全部来自基座确定性输出：模块清单/事件族schema/参数/工作流/投影表。
import { get } from '../api.js';
import { el, fmtDateTime, renderTable } from '../util.js';

export function render(container, ctx) {
  container.innerHTML = '';
  const root = el('div', {});
  container.append(el('h2', {}, '自我认知区'), root);

  async function load() {
    let d;
    try { d = await get('/api/describe'); } catch (err) { ctx.toast(err.message, 'err'); return; }
    root.innerHTML = '';

    // ---- 元信息 ----
    root.append(el('section', { class: 'card' },
      el('div', { class: 'cardhead' }, '系统快照',
        el('button', { class: 'small', onclick: load }, '刷新')),
      el('div', { class: 'detailgrid' },
        cell('事件序号 maxSeq', d.meta.maxEventSeq),
        cell('快照生成时间', fmtDateTime(d.meta.generatedAt)),
        cell('工作流文档', Object.keys(d.workflowContents ?? {}).length + ' 份'),
        cell('工序模板', (d.procedures ?? []).length + ' 份'))));

    // ---- 模块清单（确定性，永远与实现一致）----
    root.append(el('section', { class: 'card' },
      el('div', { class: 'cardhead' }, '模块清单', el('span', { class: 'sub' }, `${d.modules.length} 个模块`)),
      el('div', { class: 'modulegrid' },
        ...d.modules.map(m => el('div', { class: 'm' },
          el('b', {}, m.name), el('div', { class: 'sub' }, m.path),
          el('div', { style: 'margin-top:4px;' }, m.responsibility))))));

    // ---- 事件族 schema ----
    root.append(el('section', { class: 'card' },
      el('div', { class: 'cardhead' }, '事件族 schema', el('span', { class: 'sub' }, '七族（9.3 定稿）')),
      ...d.eventSchemas.map(fam => el('div', { style: 'margin-bottom:6px;' },
        el('b', { class: 'mono' }, fam.family),
        el('div', {}, ...fam.subtypes.map(s => el('span', { class: 'chip' }, s)))))));

    // ---- 参数当前值 ----
    root.append(el('section', { class: 'card' },
      el('div', { class: 'cardhead' }, '参数当前值', el('span', { class: 'sub' }, 'params.yaml')),
      el('pre', { class: 'mono', style: 'margin:0;white-space:pre-wrap;' }, JSON.stringify(d.params, null, 2) || '（无）')));

    // ---- 工作流 / automations / 工序 ----
    const wfDetails = Object.entries(d.workflowContents ?? {}).map(([name, content]) =>
      el('details', {}, el('summary', { class: 'mono', style: 'cursor:pointer;' }, `workflows/${name}.md`),
        el('pre', { class: 'mono', style: 'white-space:pre-wrap;margin:6px 0 0;' }, content)));
    root.append(el('section', { class: 'card' },
      el('div', { class: 'cardhead' }, '工作流文档（git 资产）'),
      wfDetails.length ? wfDetails : el('div', { class: 'empty' }, '无工作流文档')));
    root.append(el('section', { class: 'card' },
      el('div', { class: 'cardhead' }, 'automations.yaml（解析视图）'),
      el('pre', { class: 'mono', style: 'margin:0;white-space:pre-wrap;' },
        d.automations ? JSON.stringify(d.automations, null, 2) : '（未配置或解析失败）')));
    root.append(el('section', { class: 'card' },
      el('div', { class: 'cardhead' }, '工序模板'),
      (d.procedures ?? []).length
        ? el('div', {}, ...d.procedures.map(p => el('details', {},
            el('summary', { class: 'mono', style: 'cursor:pointer;' }, p.file),
            el('pre', { class: 'mono', style: 'white-space:pre-wrap;margin:6px 0 0;' },
              p.template ? JSON.stringify(p.template, null, 2) : '（解析失败）'))))
        : el('div', { class: 'empty' }, '无工序模板')));

    // ---- 投影全表（14 张）----
    const tables = ['tasks', 'taskNodes', 'agents', 'workspaces', 'loadQueue', 'dialogues',
      'guidances', 'consults', 'purposes', 'replayByPurpose', 'valueCompare', 'registry',
      'agentRegistry', 'permissionRules'];
    root.append(el('section', { class: 'card' },
      el('div', { class: 'cardhead' }, '投影全表', el('span', { class: 'sub' }, '14 张 · 事件溯源物化视图')),
      ...tables.map(name => {
        const rows = d[name] ?? [];
        const wrap = el('div');
        const details = el('details', {},
          el('summary', { style: 'cursor:pointer;font-weight:600;' }, `${name}（${rows.length} 行）`),
          el('div', { style: 'margin-top:8px;max-height:320px;overflow:auto;' }, wrap));
        if (rows.length) {
          const cols = Object.keys(rows[0]).map(k => ({ key: k, label: k, class: 'mono' }));
          renderTable(wrap, rows.slice(0, 50), cols, { empty: '空表' });
          if (rows.length > 50) wrap.append(el('div', { class: 'empty' }, `…共 ${rows.length} 行，仅展示前 50 行`));
        } else {
          renderTable(wrap, [], [], { empty: '空表' });
        }
        return details;
      })));
  }

  const cell = (k, v) => el('div', { class: 'cell' }, el('b', {}, k), el('span', { class: 'mono' }, String(v ?? '—')));

  load();
}
