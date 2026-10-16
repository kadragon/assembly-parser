#!/usr/bin/env node
// Read-only web view over the files written by collect.js and summarize.js.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { files, meetingDir, readJson, readTranscript } from './store.js';
import { loadTopics } from './topics.js';
import { windowStart } from './transcript.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const indexHtml = path.join(here, '..', 'public', 'index.html');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: 'string', default: 'data' },
    port: { type: 'string', default: '3000' },
  },
});
if (!positionals[0]) {
  console.error('usage: node src/serve.js <player.asp URL | xcgcd> [--port 3000] [--data data]');
  process.exit(1);
}
const dir = meetingDir(positionals[0], values.data);
const f = files(dir);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function snapshot() {
  const meeting = readJson(f.meeting, {});
  const state = readJson(f.state, { windowMinutes: 5, windows: {} });
  const windowMs = state.windowMinutes * 60_000;
  const current = windowStart(Date.now(), windowMs);
  const windows = Object.values(state.windows);
  const routed = windows.filter((w) => w.routed).map((w) => w.end);
  let lastLineAt = null; // collect.js only appends, so mtime is when the last caption arrived
  try {
    lastLineAt = fs.statSync(f.transcript).mtimeMs;
  } catch {}
  return {
    lastLineAt,
    meeting: {
      committee: meeting.committee ?? '',
      subject: meeting.subject ?? '수집 대기 중',
      date: meeting.date ?? '',
    },
    windowMinutes: state.windowMinutes,
    categories: state.categories ?? [],
    // topics are current through the last window that went through routing
    topicsUntil: routed.length ? Math.max(...routed) : null,
    topics: loadTopics(dir),
    running: state.running?.pid && alive(state.running.pid) ? state.running.jobs : [],
    windows: windows.sort((a, b) => b.start - a.start),
    current: {
      start: current,
      end: current + windowMs,
      lines: readTranscript(f.transcript).between(current, current + windowMs),
    },
  };
}

// Tail transcript.jsonl and push each appended line to connected browsers (SSE).
const liveClients = new Set();
let offset = fs.existsSync(f.transcript) ? fs.statSync(f.transcript).size : 0;
let partial = '';
setInterval(() => {
  let size;
  try {
    size = fs.statSync(f.transcript).size;
  } catch {
    return;
  }
  if (size < offset) offset = 0; // file was replaced
  if (size === offset) return;
  const fd = fs.openSync(f.transcript, 'r');
  const buf = Buffer.alloc(size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  offset = size;
  const rows = (partial + buf.toString('utf8')).split('\n');
  partial = rows.pop(); // keep an incomplete trailing row for the next read
  for (const row of rows) {
    if (row) for (const res of liveClients) res.write(`data: ${row}\n\n`);
  }
}, 300);

http
  .createServer((req, res) => {
    if (req.url === '/api/live') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      liveClients.add(res);
      req.on('close', () => liveClients.delete(res));
      return;
    }
    if (req.url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(snapshot()));
      return;
    }
    if (req.url === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(indexHtml).pipe(res);
      return;
    }
    res.writeHead(404).end();
  })
  .listen(Number(values.port), () => {
    console.log(`serving ${path.dirname(f.state)} at http://localhost:${values.port}`);
  });
