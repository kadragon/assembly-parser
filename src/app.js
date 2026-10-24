#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Sessions, validatePort } from './control.js';
import { acquireLock } from './ownership.js';
import { snapshot } from './snapshot.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const json = (res, status, body) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
};
async function payload(req) {
  if (req.headers['content-type'] !== 'application/json')
    throw new Error('Expected application/json');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new Error('Payload too large');
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

export async function startApp({ root = 'data', port = 3000, ...options } = {}) {
  // Port 0 is reserved for programmatic integration tests, never accepted by the CLI.
  if (port !== 0) validatePort(port);
  const token = randomBytes(32).toString('hex');
  let sessions;
  let release;
  let origin;
  const streams = new Set();
  const server = http.createServer(async (req, res) => {
    if (req.headers.host !== new URL(origin).host)
      return json(res, 403, { error: 'Foreign Host rejected' });
    if (req.headers.origin && req.headers.origin !== origin)
      return json(res, 403, { error: 'Foreign Origin rejected' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      if (!sessions) return json(res, 503, { error: 'Starting' });
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/api/sessions')
        return json(res, 200, { token, sessions: sessions.list(), warnings: sessions.warnings });
      if (req.method === 'POST') {
        if (req.headers.origin !== origin || req.headers['x-session-token'] !== token)
          return json(res, 403, { error: 'Same-origin session token required' });
        const body = await payload(req);
        let result;
        if (url.pathname === '/api/start')
          result = await sessions.serial(() => sessions.start(body));
        else {
          const match =
            /^\/api\/sessions\/([A-Za-z0-9_-]{1,100})\/(stop|resume|retry|finalize)$/.exec(
              url.pathname,
            );
          if (!match || !body || Array.isArray(body) || Object.keys(body).length)
            throw new Error('Invalid action or payload');
          result = await sessions.serial(() => sessions.action(match[1], match[2]));
        }
        return json(res, 200, result);
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
      const match = /^\/sessions\/([A-Za-z0-9_-]{1,100})\/(api\/(state|live))?$/.exec(url.pathname);
      if (match) {
        const entry = sessions.load(match[1]);
        if (match[3] === 'state') return json(res, 200, snapshot(entry.dir));
        if (match[3] === 'live') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write(': connected\n\n');
          streams.add(res);
          let seen = new Map();
          const timer = setInterval(() => {
            try {
              const lines = snapshot(entry.dir).current.lines;
              for (const line of lines)
                if (seen.get(line.key) !== line.text)
                  res.write(`data: ${JSON.stringify(line)}\n\n`);
              seen = new Map(lines.map((line) => [line.key, line.text]));
            } catch {
              res.end();
            }
          }, 1000);
          res.on('close', () => {
            clearInterval(timer);
            streams.delete(res);
          });
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(
          fs
            .readFileSync(path.join(publicDir, 'index.html'), 'utf8')
            .replace(
              '<body>',
              '<body><a href="/" style="display:block;padding:16px">← 세션 관리</a>',
            ),
        );
      }
      const assets = {
        '/': ['home.html', 'text/html'],
        '/home.css': ['home.css', 'text/css'],
        '/home.js': ['home.js', 'text/javascript'],
      };
      const asset = assets[url.pathname];
      if (asset) {
        res.writeHead(200, {
          'Content-Type': `${asset[1]}; charset=utf-8`,
          'Cache-Control': 'no-store',
        });
        return res.end(fs.readFileSync(path.join(publicDir, asset[0])));
      }
      if (url.pathname === '/favicon.ico') return res.writeHead(204).end();
      json(res, 404, { error: 'Not found' });
    } catch (error) {
      json(res, 400, { error: error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  try {
    fs.mkdirSync(root, { recursive: true });
    release = acquireLock(root, 'application');
    sessions = new Sessions(root, options);
    sessions.list();
  } catch (error) {
    await sessions?.close();
    release?.();
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  let closing;
  const close = () =>
    (closing ??= (async () => {
      for (const stream of streams) stream.end();
      const stopped = new Promise((resolve) => server.close(resolve));
      await sessions.close();
      server.closeAllConnections();
      await stopped;
      release();
    })());
  return { server, sessions, origin, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        data: { type: 'string', default: 'data' },
        port: { type: 'string', default: '3000' },
      },
    });
    const app = await startApp({ root: values.data, port: validatePort(values.port) });
    console.log(`Assembly sessions: ${app.origin}`);
    const shutdown = () => {
      app.close().then(
        () => process.exit(0),
        (error) => {
          console.error(error.message);
          process.exit(1);
        },
      );
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
