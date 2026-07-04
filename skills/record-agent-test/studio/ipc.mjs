// Socket client library for session.mjs (SPEC §2.2).
// Imports ONLY node:net — this module must never import playwright; the
// 285 ms playwright import per turn is exactly what the daemon deletes.
import net from 'node:net';

let nextId = 1;

// Send one request over a fresh unix-socket connection; resolve with the
// response object. Intermediate `{ evt: ... }` lines (progress during finish)
// are forwarded to `onEvent` and do not resolve the promise.
//
// Rejects with err.code:
//   'ETIMEOUT'  — no response within timeoutMs
//   'ENOENT' / 'ECONNREFUSED' — no live daemon on the socket
export function request(socketPath, verb, args = {}, { timeoutMs = 30000, onEvent } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const sock = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      const e = new Error(`no response from daemon after ${timeoutMs} ms`);
      e.code = 'ETIMEOUT';
      done(reject, e);
    }, timeoutMs);
    timer.unref?.();

    sock.on('error', (err) => { clearTimeout(timer); done(reject, err); });
    sock.on('connect', () => {
      sock.write(JSON.stringify({ id: nextId++, verb, args }) + '\n');
    });

    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!raw.trim()) continue;
        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }
        if (msg.evt !== undefined) { onEvent?.(msg); continue; }
        clearTimeout(timer);
        sock.end();
        done(resolve, msg);
      }
    });
    sock.on('close', () => {
      clearTimeout(timer);
      done(reject, new Error('daemon closed the connection without responding'));
    });
  });
}

// True if something is accepting connections on the socket path.
export function ping(socketPath, timeoutMs = 1000) {
  return request(socketPath, 'ping', {}, { timeoutMs }).then((r) => !!r.ok, () => false);
}
