import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startApp } from '../src/app.js';
import { acquireLock, alive } from '../src/ownership.js';
import { writeJson } from '../src/store.js';

const player = (id) => `https://assembly.webcast.go.kr/main/player.asp?xcode=58&xcgcd=${id}`;
const metadata = (ids) => ({
  ...ids,
  committee: '테스트 위원회',
  subject: '합성 회의',
  date: '2026-10-24',
  live: true,
  smiServer: 'wss://smiai.webcast.go.kr:8091/aistt/test',
});
async function until(fn) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('condition not reached');
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assembly-api-'));
  const collector = path.join(root, 'collector.cjs');
  const summary = path.join(root, 'summary.cjs');
  fs.writeFileSync(
    collector,
    `const fs=require('node:fs'); const path=require('node:path'); const root=process.argv[process.argv.indexOf('--data')+1]; const id=new URL(process.argv[2]).searchParams.get('xcgcd'); fs.appendFileSync(path.join(root,'workers.jsonl'),JSON.stringify({role:'collector',pid:process.pid,id,args:process.argv})+'\\n'); setInterval(()=>{},1000);`,
  );
  fs.writeFileSync(
    summary,
    `const fs=require('node:fs'); const path=require('node:path'); const root=process.argv[process.argv.indexOf('--data')+1]; fs.appendFileSync(path.join(root,'workers.jsonl'),JSON.stringify({role:'summary',pid:process.pid,id:process.argv[2],args:process.argv})+'\\n'); if(fs.existsSync(path.join(root,'fail'))) { console.error('synthetic model failure'); process.exit(2); } setTimeout(()=>process.exit(0),200);`,
  );
  const app = await startApp({
    root,
    port: 0,
    resolveMeeting: async (ids) => metadata(ids),
    worker: (role) => (role === 'collector' ? collector : summary),
    interval: 60000,
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const token = (await (await fetch(`${app.origin}/api/sessions`)).json()).token;
  const post = (url, body = {}, headers = {}) =>
    fetch(`${app.origin}${url}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: app.origin,
        'X-Session-Token': token,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const workers = () => {
    try {
      return fs
        .readFileSync(path.join(root, 'workers.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse);
    } catch {
      return [];
    }
  };
  return { ...app, root, post, workers };
}

test('HTTP validation rejects requests before creating sessions or workers', async (t) => {
  const app = await fixture(t);
  for (const body of [
    { url: player('../x') },
    { url: 'https://evil.test/main/player.asp?xcode=58&xcgcd=a' },
    { url: player('a'), config: { windowMinutes: 7 } },
    { url: player('a'), config: { focusNote: 'without focus' } },
    { url: player('a'), extra: true },
  ])
    assert.equal((await app.post('/api/start', body)).status, 400);
  assert.equal(
    (await app.post('/api/start', { url: player('a') }, { Origin: 'https://evil.test' })).status,
    403,
  );
  assert.equal(
    (await app.post('/api/start', { url: player('a') }, { 'X-Session-Token': 'wrong' })).status,
    403,
  );
  assert.equal((await app.post('/api/sessions/a/stop', { unexpected: true })).status, 400);
  const foreign = await new Promise((resolve) => {
    const req = http.get(app.origin, { headers: { Host: 'evil.test' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', (error) => {
      throw error;
    });
  });
  assert.equal(foreign, 403);
  assert.equal(app.sessions.list().length, 0);
  assert.equal(app.workers().length, 0);
});

test('concurrent Start is idempotent, literal settings persist, and summaries queue across sessions', async (t) => {
  const app = await fixture(t);
  const config = { focus: '$(touch pwn);`literal`', focusKeywords: 'a,b', focusNote: 'scope' };
  const results = await Promise.all(
    Array.from({ length: 4 }, () => app.post('/api/start', { url: player('one'), config })),
  );
  assert.ok(results.every((res) => res.status === 200));
  assert.equal((await app.post('/api/start', { url: player('two') })).status, 200);
  assert.equal(app.sessions.load('two').state.summary, 'queued');
  await until(() => app.workers().filter((w) => w.role === 'summary').length === 2);
  assert.equal(app.workers().filter((w) => w.role === 'collector' && w.id === 'one').length, 1);
  const first = app.workers().find((w) => w.role === 'summary');
  assert.ok(first.args.includes(config.focus));
  assert.equal(alive(first.pid), false);
  assert.equal(
    (await app.post('/api/start', { url: player('one'), config: { focus: 'changed' } })).status,
    400,
  );
  const html = await (await fetch(`${app.origin}/sessions/one/`)).text();
  assert.match(html, /세션 관리/);
  assert.equal((await fetch(`${app.origin}/sessions/one/api/state`)).status, 200);
  await app.close();
  assert.ok(app.workers().every((worker) => !alive(worker.pid)));
  const restarted = await startApp({ root: app.root, port: 0 });
  t.after(() => restarted.close());
  assert.equal(restarted.sessions.load('one').config.focus, config.focus);
  assert.equal(restarted.sessions.load('one').state.collection, 'stopped');
  assert.equal(restarted.sessions.load('one').collector, null);
});

test('summary failure preserves collection, retry is scoped, stop then finalize passes the final-window flag', async (t) => {
  const app = await fixture(t);
  fs.writeFileSync(path.join(app.root, 'fail'), '');
  await app.post('/api/start', { url: player('one') });
  await until(() => app.sessions.load('one').state.summary === 'error');
  assert.equal(app.sessions.load('one').state.collection, 'running');
  assert.match(app.sessions.load('one').state.summaryError, /synthetic model failure/);
  fs.unlinkSync(path.join(app.root, 'fail'));
  await app.post('/api/sessions/one/retry');
  await until(() => app.sessions.load('one').state.summary === 'idle');
  assert.equal((await app.post('/api/sessions/one/finalize')).status, 400);
  await app.post('/api/sessions/one/stop');
  assert.ok(app.workers().every((worker) => !alive(worker.pid)));
  await app.post('/api/sessions/one/finalize');
  await until(() => app.sessions.load('one').state.summary === 'complete');
  assert.ok(app.workers().at(-1).args.includes('--finalize'));
  await app.post('/api/sessions/one/resume');
  assert.ok(app.sessions.load('one').state.gap.to >= app.sessions.load('one').state.gap.from);
});

test('CLI lock contention does not overwrite metadata or start a worker', async (t) => {
  const app = await fixture(t);
  const dir = path.join(app.root, 'one');
  fs.mkdirSync(dir);
  writeJson(path.join(dir, 'meeting.json'), metadata({ xcode: '58', xcgcd: 'one' }));
  const before = fs.readFileSync(path.join(dir, 'meeting.json'), 'utf8');
  const release = acquireLock(dir, 'collector');
  try {
    assert.equal((await app.post('/api/start', { url: player('one') })).status, 400);
  } finally {
    release();
  }
  assert.equal(fs.readFileSync(path.join(dir, 'meeting.json'), 'utf8'), before);
  assert.equal(app.workers().length, 0);
});

test('CLI rejects invalid ports and a busy port without creating its data directory', async (t) => {
  const app = await fixture(t);
  for (const port of ['0', '70000', String(app.server.address().port)]) {
    const root = path.join(app.root, `unused-${port}`);
    const child = spawn(process.execPath, ['src/app.js', '--data', root, '--port', port]);
    const [code] = await once(child, 'close');
    assert.notEqual(code, 0);
    assert.equal(fs.existsSync(root), false);
  }
});

test('interrupted persisted sessions remain stopped until explicitly resumed', async (t) => {
  const app = await fixture(t);
  const dir = path.join(app.root, 'interrupted');
  fs.mkdirSync(dir);
  writeJson(path.join(dir, 'meeting.json'), metadata({ xcode: '58', xcgcd: 'interrupted' }));
  writeJson(path.join(dir, 'session.json'), {
    config: { windowMinutes: 5, focus: '', focusKeywords: '', focusNote: '' },
    state: { collection: 'running', summary: 'running', startedAt: 123 },
  });
  const entry = app.sessions.load('interrupted');
  assert.equal(entry.state.collection, 'interrupted');
  assert.equal(entry.state.summary, 'interrupted');
  assert.equal(entry.state.missedSince, 123);
  assert.equal(app.workers().length, 0);
});

test('unavailable and mismatched metadata start no session', async (t) => {
  const app = await fixture(t);
  for (const override of [
    { live: false },
    { xcgcd: 'wrong' },
    { smiServer: 'wss://evil.test/socket' },
    { smiServer: 'wss://smi.webcast.go.kr' },
  ]) {
    app.sessions.resolveMeeting = async (ids) => ({ ...metadata(ids), ...override });
    assert.equal((await app.post('/api/start', { url: player('one') })).status, 400);
    assert.equal(fs.existsSync(path.join(app.root, 'one')), false);
  }
  assert.equal(app.workers().length, 0);
});

test('server subprocess shutdown kills owned worker descendants', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assembly-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const worker = path.join(root, 'worker.cjs');
  fs.writeFileSync(
    worker,
    `const fs=require('node:fs'); const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],{stdio:'ignore'}); fs.appendFileSync(${JSON.stringify(path.join(root, 'pids'))},process.pid+' '+child.pid+'\\n'); setInterval(()=>{},1000);`,
  );
  const launcher = path.join(root, 'server.mjs');
  fs.writeFileSync(
    launcher,
    `import {startApp} from ${JSON.stringify(new URL('../src/app.js', import.meta.url).href)}; const app=await startApp({root:${JSON.stringify(root)},port:0,worker:()=>${JSON.stringify(worker)},resolveMeeting:async(ids)=>({...ids,committee:'Synthetic',subject:'Fixture',live:true,smiServer:'wss://smiai.webcast.go.kr:8091/aistt/test'})}); process.send(app.origin); process.on('SIGTERM',async()=>{await app.close();process.exit(0)});`,
  );
  const child = spawn(process.execPath, [launcher], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => child.kill('SIGKILL'));
  const [origin] = await once(child, 'message');
  const token = (await (await fetch(`${origin}/api/sessions`)).json()).token;
  const res = await fetch(`${origin}/api/start`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Session-Token': token },
    body: JSON.stringify({ url: player('one') }),
  });
  assert.equal(res.status, 200);
  const log = path.join(root, 'pids');
  await until(
    () => fs.existsSync(log) && fs.readFileSync(log, 'utf8').trim().split('\n').length === 2,
  );
  const pids = fs.readFileSync(log, 'utf8').trim().split(/\s+/).map(Number);
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  await closed;
  await until(() => pids.every((pid) => !alive(pid)));
  assert.equal(fs.existsSync(path.join(root, '.application.lock')), false);
  assert.equal(fs.existsSync(path.join(root, 'one', '.collector.lock')), false);
});
