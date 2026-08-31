// SSE 事件流（/api/stream）：hello(maxSeq) + bus(信封摘要，seq 单调去重)
const listeners = new Set();
let lastSeq = 0;
let connected = false;
const connListeners = new Set();

export function onBus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function onConnChange(fn) { connListeners.add(fn); return () => connListeners.delete(fn); }
export function getLastSeq() { return lastSeq; }
export function isConnected() { return connected; }

export function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('hello', (e) => {
    const d = JSON.parse(e.data);
    lastSeq = Math.max(lastSeq, d.maxSeq);
  });
  es.addEventListener('bus', (e) => {
    const evt = JSON.parse(e.data);
    if (evt.seq <= lastSeq) return; // 历史回补与实时流的竞态去重
    lastSeq = evt.seq;
    for (const fn of listeners) { try { fn(evt); } catch { /* 订阅者异常隔离 */ } }
  });
  es.onopen = () => { if (!connected) { connected = true; connListeners.forEach(f => f(true)); } };
  es.onerror = () => { if (connected) { connected = false; connListeners.forEach(f => f(false)); } };
}
