// 驾驶舱首版入口：导航（培育/使用二分，设计锚点 7.1）+ hash 路由 + SSE 接线
import { connect } from './sse.js';
import { renderFeedCol } from './views/feed.js';
import * as tasks from './views/tasks.js';
import * as purposes from './views/purposes.js';
import * as agents from './views/agents.js';
import * as config from './views/config.js';
import * as describe from './views/describe.js';
import { el } from './util.js';

const VIEWS = {
  tasks: { title: '任务区', mod: tasks, busFamilies: ['task', 'organ'] },
  purposes: { title: '目的区', mod: purposes, busFamilies: ['task'] },
  agents: { title: 'Agent 区', mod: agents, busFamilies: ['admin', 'agent'] },
  config: { title: '配置资产区', mod: config, busFamilies: ['admin'] },
  describe: { title: '自我认知区', mod: describe, busFamilies: [] },
};
const NAV = [
  { group: '使用板块', items: ['tasks', 'purposes'] },
  { group: '培育板块', items: ['agents', 'config', 'describe'] },
];

// ---- Toast ----
export function toast(msg, type = '') {
  const box = document.getElementById('toasts');
  const t = el('div', { class: `toast ${type}` }, msg);
  box.append(t);
  setTimeout(() => t.remove(), 4000);
}

// ---- 视图上下文：SSE 相关族事件到达时提示当前视图刷新 ----
let current = null;
const busListeners = new Set();
function onBus(fn) { busListeners.add(fn); return () => busListeners.delete(fn); }

function route() {
  const hash = (location.hash || '#/tasks').replace(/^#\//, '');
  const key = VIEWS[hash] ? hash : 'tasks';
  const v = VIEWS[key];
  document.querySelectorAll('.navitem').forEach(n => n.classList.toggle('active', n.dataset.key === key));
  const main = document.getElementById('main');
  main.innerHTML = '';
  busListeners.clear(); // 只保留当前视图的 bus 监听，防跨视图累积
  current = { key, families: v.busFamilies };
  try {
    v.mod.render(main, { toast, onBus });
  } catch (err) {
    toast(`视图渲染失败：${err.message}`, 'err');
  }
}

function buildNav() {
  const nav = document.getElementById('nav');
  for (const g of NAV) {
    nav.append(el('div', { class: 'navgroup' }, g.group));
    for (const key of g.items) {
      nav.append(el('a', { class: 'navitem', 'data-key': key, href: `#/${key}` }, VIEWS[key].title));
    }
  }
}

function start() {
  buildNav();
  renderFeedCol();
  connect();
  window.addEventListener('hashchange', route);
  route();
  onBus(evt => {
    // 相关族事件 → 轻提示当前视图自刷新（视图内自行决定拉不拉数据）
    if (current && current.families.includes(evt.family)) {
      for (const fn of busListeners) { try { fn(evt); } catch { /* 隔离 */ } }
    }
  });
}

start();
