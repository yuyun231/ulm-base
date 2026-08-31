// 共享工具：DOM 构建 / 格式化 / 通用表格

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'onclick') node.addEventListener('click', v);
    else if (k === 'onsubmit') node.addEventListener('submit', v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'checked') node.checked = !!v;
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

export function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

export function fmtDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.toLocaleDateString('zh-CN')} ${d.toLocaleTimeString('zh-CN', { hour12: false })}`;
}

export function subjectLabel(subject) {
  if (!subject) return '';
  if (subject.kind === 'agent') return `agent:${subject.agentId}`;
  if (subject.kind === 'human') return `human:${subject.userId}`;
  return `module:${subject.module}`;
}

export function handlesLabel(handles) {
  const entries = Object.entries(handles ?? {});
  if (!entries.length) return '';
  return entries.map(([k, v]) => `${k}=${v}`).join('  ');
}

const STATE_BADGE = {
  pending: '', inProgress: 'blue', completed: 'green', failed: 'red', paused: 'amber',
  draft: '', refining: 'blue', valueConfirmed: 'blue', pathConfirmed: 'blue', detailsReady: 'amber', launched: 'green',
};

export function stateBadge(state) {
  return el('span', { class: `badge ${STATE_BADGE[state] ?? ''}` }, state ?? '-');
}

export function connDot(on, lost) {
  return el('span', { class: `dot ${lost ? 'lost' : on ? 'on' : 'off'}` });
}

// 通用对象表格：columns = [{key,label,render?,class?}]
export function renderTable(container, rows, columns, { empty = '暂无数据', onRowClick } = {}) {
  container.innerHTML = '';
  if (!rows || !rows.length) {
    container.append(el('div', { class: 'empty' }, empty));
    return;
  }
  const thead = el('thead', {}, el('tr', {}, ...columns.map(c => el('th', {}, c.label))));
  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr', { class: onRowClick ? 'click' : '' },
      ...columns.map(c => {
        const td = el('td', { class: c.class ?? '' });
        const v = c.render ? c.render(row) : row[c.key];
        if (v instanceof Node) td.append(v);
        else td.textContent = v ?? '';
        return td;
      }));
    if (onRowClick) tr.addEventListener('click', () => onRowClick(row));
    tbody.append(tr);
  }
  container.append(el('table', {}, thead, tbody));
}
