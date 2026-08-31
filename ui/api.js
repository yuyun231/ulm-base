// REST 封装：后端统一响应 {ok,data}/{ok,error}
async function call(path, method, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('网络错误：无法连接基座');
  }
  const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json.data;
}

export const get = (p) => call(p, 'GET');
export const post = (p, b) => call(p, 'POST', b ?? {});
export const put = (p, b) => call(p, 'PUT', b ?? {});
export const del = (p) => call(p, 'DELETE');
