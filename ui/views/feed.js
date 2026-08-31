// 反馈区（设计锚点 7.2）：事件总线的订阅视图，无自有数据。
// 历史（/api/events 尾部回补）+ 实时（SSE），过滤（族/文本）在客户端做。
import { get } from '../api.js';
import { onBus, getLastSeq, onConnChange } from '../sse.js';
import { el, fmtTime, subjectLabel, handlesLabel } from '../util.js';

const FAMILIES = ['organ', 'task', 'schedule', 'comm', 'dialogue', 'admin', 'doc'];
const MAX_ITEMS = 500;
let items = [];          // {seq, timestamp, subject, family, subtype, handles}
let famFilter = '';
let textFilter = '';

export function renderFeedCol() {
  const listEl = document.getElementById('feedlist');
  const filterEl = document.getElementById('feedfilters');

  filterEl.innerHTML = '';
  filterEl.append(
    el('select', { onchange: (e) => { famFilter = e.target.value; paint(listEl); } },
      el('option', { value: '' }, '全部事件族'),
      ...FAMILIES.map(f => el('option', { value: f }, f))),
    el('input', { placeholder: '过滤 agent/task/文本', oninput: (e) => { textFilter = e.target.value.trim(); paint(listEl); } }),
  );

  // 历史回补：从 hello.maxSeq 往前取一段（SSE 已连接，之后实时追加去重）
  const from = Math.max(0, getLastSeq() - 300);
  get(`/api/events?afterSeq=${from}&limit=300`).then(rows => {
    items = rows.map(r => ({ seq: r.seq, timestamp: r.timestamp, subject: r.subject, family: r.family, subtype: r.subtype, handles: r.handles }));
    paint(listEl);
  }).catch(() => {});

  onBus(evt => {
    items.push({ seq: evt.seq, timestamp: evt.timestamp, subject: evt.subject, family: evt.family, subtype: evt.subtype, handles: evt.handles });
    if (items.length > MAX_ITEMS) items = items.slice(-MAX_ITEMS);
    paint(listEl, true);
  });
  onConnChange(on => {
    const conn = document.getElementById('conn');
    conn.textContent = on ? '● 已连接' : '● 连接断开，重试中…';
    conn.className = `conn ${on ? 'on' : 'off'}`;
  });
}

function match(it) {
  if (famFilter && it.family !== famFilter) return false;
  if (textFilter) {
    const hay = `${subjectLabel(it.subject)} ${it.family}:${it.subtype} ${handlesLabel(it.handles)}`.toLowerCase();
    if (!hay.includes(textFilter.toLowerCase())) return false;
  }
  return true;
}

function paint(listEl, appendMode = false) {
  const visible = items.filter(match);
  const frag = document.createDocumentFragment();
  for (const it of visible.slice(-MAX_ITEMS)) frag.append(feedItem(it));
  listEl.innerHTML = '';
  listEl.append(frag);
  if (appendMode) listEl.scrollTop = listEl.scrollHeight;
}

function feedItem(it) {
  const handles = handlesLabel(it.handles);
  return el('div', { class: 'feeditem' },
    el('div', { class: 'row1' },
      el('span', { class: 'seq' }, `#${it.seq}`),
      el('span', { class: `tag f-${it.family}` }, `${it.family}:${it.subtype}`),
      el('time', {}, fmtTime(it.timestamp))),
    el('div', { class: 'dim mono' }, subjectLabel(it.subject)),
    handles ? el('div', { class: 'handles' }, handles) : null);
}
