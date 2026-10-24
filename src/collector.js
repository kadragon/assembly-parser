import { toLine } from './transcript.js';

const RECONNECT_MS = 5000;
// the site reconnects if nothing arrives for a while; do the same
const IDLE_MS = 120_000;

/** Connects to the AI subtitle WebSocket and calls onLine for each finalized segment. */
export function collect(url, { onLine, log = console.log }) {
  let ws;
  let idleTimer;
  let reconnectTimer;
  let stopped = false;

  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log('subtitle stream idle, reconnecting');
      ws?.close();
    }, IDLE_MS);
  };

  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(url, 'echo-protocol');
    ws.addEventListener('open', () => {
      if (stopped) return;
      log(`subtitle stream connected: ${url}`);
      resetIdle();
    });
    ws.addEventListener('message', (e) => {
      if (stopped) return;
      if (typeof e.data !== 'string') return;
      resetIdle();
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      const line = toLine(msg);
      if (line) onLine(line);
    });
    ws.addEventListener('error', (e) => log(`subtitle stream error: ${e.message ?? e.type}`));
    ws.addEventListener('close', () => {
      clearTimeout(idleTimer);
      if (stopped) return;
      log(`subtitle stream closed, retrying in ${RECONNECT_MS / 1000}s`);
      reconnectTimer = setTimeout(connect, RECONNECT_MS);
    });
  };

  connect();
  return () => {
    stopped = true;
    clearTimeout(reconnectTimer);
    clearTimeout(idleTimer);
    ws?.close();
  };
}
