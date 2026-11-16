// Minimal PostgREST/Auth stand-in for the store test.
// Keeps rows in memory so the test can assert what actually reached "the
// server" — that is the whole point: a delete that only happened in
// localStorage is not a delete.
import http from 'node:http';

export const state = { spheres: [], tasks: [], settings: null, calls: [] };

const USER_ID = 'user-1';
export { USER_ID };

function send(res, status, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-range': body === undefined ? '*/0' : `0-${Array.isArray(body) ? Math.max(body.length - 1, 0) : 0}/*`,
    'access-control-allow-origin': '*',
  });
  res.end(payload);
}

// PostgREST encodes `.in('name', [...])` as `name=in.(a,b)`; values with
// special characters are quoted and then URL-encoded.
function parseIn(value) {
  const inner = value.replace(/^in\./, '').replace(/^\(/, '').replace(/\)$/, '');
  if (!inner) return [];
  const out = [];
  let cur = '';
  let quoted = false;
  for (const ch of inner) {
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === ',' && !quoted) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((v) => decodeURIComponent(v)).filter(Boolean);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : null); } catch { resolve(null); }
    });
  });
}

export function start(port = 4599) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const params = url.searchParams;
    const prefer = String(req.headers.prefer ?? '');
    state.calls.push(`${req.method} ${url.pathname}${url.search}`);

    if (req.method === 'OPTIONS') { send(res, 204); return; }

    if (url.pathname === '/auth/v1/token') {
      send(res, 200, {
        access_token: 'test-access-token',
        token_type: 'bearer',
        expires_in: 36000,
        refresh_token: 'test-refresh-token',
        user: { id: USER_ID, aud: 'authenticated', email: 'test@example.com', app_metadata: {}, user_metadata: {} },
      });
      return;
    }
    if (url.pathname.startsWith('/auth/v1/user')) {
      send(res, 200, { id: USER_ID, aud: 'authenticated', email: 'test@example.com' });
      return;
    }
    if (url.pathname.startsWith('/auth/v1/logout')) { send(res, 204); return; }

    if (url.pathname === '/rest/v1/spheres') {
      if (req.method === 'GET') {
        const rows = state.spheres
          .filter((r) => (params.get('user_id') ?? '').replace(/^eq\./, '') === '' || r.user_id === (params.get('user_id') ?? '').replace(/^eq\./, ''))
          .slice()
          .sort((a, b) => a.order - b.order);
        send(res, 200, rows);
        return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const rows = Array.isArray(body) ? body : body ? [body] : [];
        for (const row of rows) {
          const idx = state.spheres.findIndex((r) => r.user_id === row.user_id && r.name === row.name);
          if (idx >= 0) state.spheres[idx] = { ...state.spheres[idx], ...row };
          else state.spheres.push({ ...row });
        }
        send(res, 201, prefer.includes('return=representation') ? rows : undefined);
        return;
      }
      if (req.method === 'DELETE') {
        const userEq = (params.get('user_id') ?? '').replace(/^eq\./, '');
        const names = params.get('name')?.startsWith('in.') ? parseIn(params.get('name')) : null;
        const nameEq = params.get('name')?.startsWith('eq.') ? params.get('name').slice(3) : null;
        const removed = [];
        state.spheres = state.spheres.filter((r) => {
          const matchUser = !userEq || r.user_id === userEq;
          const matchName = names ? names.includes(r.name) : nameEq ? r.name === nameEq : true;
          if (matchUser && matchName) { removed.push(r); return false; }
          return true;
        });
        if (prefer.includes('return=representation')) send(res, 200, removed);
        else send(res, 204);
        return;
      }
    }

    if (url.pathname === '/rest/v1/tasks') {
      if (req.method === 'GET') { send(res, 200, state.tasks); return; }
      send(res, 201, []);
      return;
    }
    if (url.pathname === '/rest/v1/user_settings') {
      if (req.method === 'GET') {
        // A row exists after the first push; PostgREST returns an array and the
        // client's maybeSingle() turns it into an object. Serve one row so the
        // client does not retry a read it can never satisfy.
        const row = state.settings ?? { user_id: USER_ID, last_view: 'week' };
        const match = (params.get('user_id') ?? '').replace(/^eq\./, '');
        send(res, 200, !match || row.user_id === match ? [row] : []);
        return;
      }
      const body = await readBody(req);
      const rows = Array.isArray(body) ? body : body ? [body] : [];
      if (rows[0]) state.settings = { ...rows[0] };
      send(res, 201, []);
      return;
    }

    send(res, 200, []);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
