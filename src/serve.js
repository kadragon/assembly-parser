#!/usr/bin/env node
// Read-only web view over the files written by collect.js and summarize.js.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { snapshot } from './snapshot.js';
import { files, meetingDir } from './store.js';

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
      res.end(JSON.stringify(snapshot(dir)));
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
