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
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assembly-api-'));
  const collector = path.join(root, 'collector.cjs');
  const summary = path.join(root, 'summary.cjs');
  fs.writeFileSync(
    collector,
    `const fs=require('node:fs'); const path=require('node:path'); const root=process.argv[process.argv.indexOf('--data')+1]; const id=new URL(process.argv[2]).searchParams.get('xcgcd'); fs.appendFileSync(path.join(root,'workers.jsonl'),JSON.stringify({role:'collector',pid:process.pid,id,args:process.argv})+'\\n'); setInterval(()=>{},1000);`,
  );
  fs.writeFileSync(
    summary,
    `const fs=require('node:fs'); const path=require('node:path'); const root=process.argv[process.argv.indexOf('--data')+1]; fs.appendFileSync(path.join(root,'workers.jsonl'),JSON.stringify({role:'summary',pid:process.pid,id:process.argv[2],args:process.argv})+'\\n'); if(fs.existsSync(path.join(root,'fail'))) { console.error('synthetic model failure'); process.exit(2); } if(process.argv.includes('--rebuild')) fs.writeFileSync(path.join(root,process.argv[2],'state.json'),JSON.stringify({windows:{},rebuiltFrom:'archive/synthetic'})); else if(fs.existsSync(path.join(root,'stale'))) { console.log('progress log'); console.error('rebuild required:\\n- focus changed'); process.exit(3); } setTimeout(()=>process.exit(0),200);`,
  );
  const app = await startApp({
    root,
    port: 0,
    resolveMeeting: async (ids) => metadata(ids),
    worker: (role) => (role === 'collector' ? collector : summary),
    interval: 60000,
    ...options,
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
  assert.ok(first.args.includes(`--focus=${config.focus}`));
  assert.equal(alive(first.pid), false);
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

test('catalog API distinguishes empty and failed lookups while direct URL Start keeps working', async (t) => {
  const calls = [];
  let result = { checkedAt: 'now', broadcasts: [] };
  const app = await fixture(t, {
    listBroadcasts: async (refresh) => {
      calls.push(refresh);
      if (result instanceof Error) throw result;
      return result;
    },
  });
  const catalog = (query = '') => fetch(`${app.origin}/api/catalog${query}`);
  let res = await catalog();
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).broadcasts, []);
  result = {
    checkedAt: 'now',
    broadcasts: [
      { committee: '교육위', subject: '합성', status: '개의', live: true, url: player('one') },
    ],
  };
  res = await catalog('?refresh=1');
  assert.equal((await res.json()).broadcasts[0].committee, '교육위');
  assert.deepEqual(calls, [false, true]);
  result = new Error('upstream timeout');
  res = await catalog();
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /upstream timeout/);
  assert.equal((await app.post('/api/start', { url: player('one') })).status, 200);
  await until(() => app.workers().some((worker) => worker.role === 'collector'));
});

test('Start revalidates a listed meeting and explains ineligible captions without writes', async (t) => {
  const app = await fixture(t, {
    listBroadcasts: async () => ({
      checkedAt: 'now',
      broadcasts: [
        { committee: '교육위', subject: '합성', status: '개의', live: true, url: player('one') },
      ],
    }),
  });
  const listed = (await (await fetch(`${app.origin}/api/catalog`)).json()).broadcasts[0];
  for (const [override, reason] of [
    [{ live: false }, /not live/],
    [{ smiServer: '' }, /no subtitle server/],
    [{ smiServer: 'wss://smi.webcast.go.kr' }, /stenographer/],
  ]) {
    app.sessions.resolveMeeting = async (ids) => ({ ...metadata(ids), ...override });
    const res = await app.post('/api/start', { url: listed.url });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, reason);
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

test('unexpected collector exit releases idle summary ownership for resume', async (t) => {
  const app = await fixture(t);
  await app.post('/api/start', { url: player('one') });
  await until(() => app.sessions.load('one').state.summary === 'idle');
  app.sessions.load('one').collector.kill('SIGKILL');
  await until(() => app.sessions.load('one').state.collection === 'error');
  const response = await app.post('/api/sessions/one/resume');
  assert.equal(response.status, 200, await response.text());
  assert.equal(app.sessions.load('one').state.collection, 'running');
});

test('real once summary workers exit with IPC and allow the next session to run', async (t) => {
  const app = await fixture(t);
  const fake = app.sessions.worker;
  app.sessions.worker = (role) =>
    role === 'summarizer' ? path.resolve('src/summarize.js') : fake(role);
  await app.post('/api/start', { url: player('one') });
  await app.post('/api/start', { url: player('two') });
  await until(
    () =>
      app.sessions.load('one').state.summary === 'idle' &&
      app.sessions.load('two').state.summary === 'idle',
  );
  assert.equal(app.sessions.summary, null);
  assert.equal(app.sessions.load('one').summarizer, null);
  assert.equal(app.sessions.load('two').summarizer, null);
});

test('resuming a finalized current window is refused until it closes', async (t) => {
  const app = await fixture(t);
  await app.post('/api/start', { url: player('one') });
  await app.post('/api/sessions/one/stop');
  const file = path.join(app.root, 'one', 'state.json');
  writeJson(file, { windows: {}, finalizedThrough: Date.now() + 60000 });
  const before = app.workers().length;
  const refused = await app.post('/api/sessions/one/resume');
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /finalized/);
  assert.equal(app.workers().length, before);
  writeJson(file, { windows: {}, finalizedThrough: Date.now() - 1 });
  assert.equal((await app.post('/api/sessions/one/resume')).status, 200);
});

test('Korean settings survive a UTF-8 character split between request chunks', async (t) => {
  const app = await fixture(t);
  const token = (await (await fetch(`${app.origin}/api/sessions`)).json()).token;
  const body = Buffer.from(
    JSON.stringify({ url: player('one'), config: { focus: '한국교원대학교' } }),
  );
  const split = body.indexOf(Buffer.from('한')) + 1;
  const result = await new Promise((resolve, reject) => {
    const req = http.request(
      `${app.origin}/api/start`,
      {
        method: 'POST',
        headers: {
          Origin: app.origin,
          'Content-Type': 'application/json',
          'X-Session-Token': token,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks)) }),
        );
      },
    );
    req.on('error', reject);
    req.write(body.subarray(0, split));
    setTimeout(() => req.end(body.subarray(split)), 30);
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.config.focus, '한국교원대학교');
});

test('unreadable saved entries do not prevent startup or hide valid sessions', async (t) => {
  const app = await fixture(t);
  await app.post('/api/start', { url: player('one') });
  await app.close();
  for (const id of ['backup.2024', 'broken']) {
    const dir = path.join(app.root, id);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'meeting.json'), id === 'broken' ? '{broken' : '{}');
  }
  const restarted = await startApp({ root: app.root, port: 0 });
  t.after(() => restarted.close());
  const result = await (await fetch(`${restarted.origin}/api/sessions`)).json();
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].id, 'one');
  assert.equal(result.warnings.length, 2);
  assert.equal(fs.readFileSync(path.join(app.root, 'broken', 'meeting.json'), 'utf8'), '{broken');
});

test('stop excludes timer-driven enqueue while waiting for a stubborn collector', async (t) => {
  const app = await fixture(t);
  fs.appendFileSync(path.join(app.root, 'collector.cjs'), "process.on('SIGTERM',()=>{});");
  await app.post('/api/start', { url: player('one') });
  await until(() => app.sessions.load('one').state.summary === 'idle');
  const entry = app.sessions.load('one');
  const stopping = app.sessions.action('one', 'stop');
  app.sessions.enqueue(entry);
  await stopping;
  assert.equal(app.sessions.pending.includes(entry), false);
  assert.equal(entry.summarizer, null);
  assert.equal(entry.state.summary, 'stopped');
  assert.equal(app.workers().filter((worker) => worker.role === 'summary').length, 1);
});

test('resume cancels queued finalization before restarting collection', async (t) => {
  const app = await fixture(t);
  await app.post('/api/start', { url: player('one') });
  await app.post('/api/sessions/one/stop');
  fs.writeFileSync(path.join(app.root, 'summary.cjs'), 'setInterval(()=>{},1000);');
  await app.post('/api/start', { url: player('two') });
  await app.post('/api/sessions/one/finalize');
  assert.equal(app.sessions.load('one').finalizing, true);
  assert.equal((await app.post('/api/sessions/one/resume')).status, 200);
  assert.equal(app.sessions.load('one').finalizing, false);
  assert.equal(app.sessions.pending.filter((entry) => entry.id === 'one').length, 1);
});

test('resume reuses ownership while a normal summary retry is running', async (t) => {
  const app = await fixture(t);
  await app.post('/api/start', { url: player('one') });
  await app.post('/api/sessions/one/stop');
  fs.writeFileSync(path.join(app.root, 'summary.cjs'), 'setInterval(()=>{},1000);');
  await app.post('/api/sessions/one/retry');
  const summary = app.sessions.load('one').summarizer;
  assert.equal((await app.post('/api/sessions/one/resume')).status, 200);
  assert.equal(app.sessions.load('one').summarizer, summary);
  assert.equal(app.sessions.load('one').state.summary, 'running');
});

test('failed Stop does not permanently block future summary actions', async (t) => {
  const app = await fixture(t);
  await app.post('/api/start', { url: player('one') });
  const original = app.sessions.kill;
  app.sessions.kill = async () => {
    throw new Error('synthetic signal failure');
  };
  assert.equal((await app.post('/api/sessions/one/stop')).status, 400);
  app.sessions.kill = original;
  assert.equal(app.sessions.load('one').stopping, false);
  assert.equal((await app.post('/api/sessions/one/stop')).status, 200);
});

test('synchronous worker launch failure is persisted as error and releases acquired locks', async (t) => {
  const app = await fixture(t);
  app.sessions.launch = () => {
    throw new Error('synthetic launch failure');
  };
  assert.equal((await app.post('/api/start', { url: player('one') })).status, 400);
  assert.equal(app.sessions.load('one').state.collection, 'error');
  assert.match(app.sessions.load('one').state.collectionError, /synthetic launch/);
  assert.equal(fs.existsSync(path.join(app.root, 'one', '.collector.lock')), false);
  assert.equal(fs.existsSync(path.join(app.root, 'one', '.summarizer.lock')), false);
});

test('changed settings pause summaries as stale while collecting; rebuild passes explicit settings', async (t) => {
  const app = await fixture(t);
  await app.post('/api/start', {
    url: player('one'),
    config: { focus: '기관', focusNote: '사업' },
  });
  await until(() => app.sessions.load('one').state.summary === 'idle');
  fs.writeFileSync(path.join(app.root, 'stale'), '');
  const changed = await app.post('/api/start', {
    url: player('one'),
    config: { focus: '다른 기관' },
  });
  assert.equal(changed.status, 200);
  await until(() => app.sessions.load('one').state.summary === 'stale');
  const entry = app.sessions.load('one');
  assert.equal(entry.state.collection, 'running');
  assert.match(entry.state.staleReasons, /focus changed/);
  const args = app.workers().at(-1).args;
  for (const arg of ['--focus=다른 기관', '--focus-keywords=', '--focus-note='])
    assert.ok(args.includes(arg), arg);
  assert.equal(entry.state.staleReasons, 'rebuild required:\n- focus changed');
  const sessions = (await (await fetch(`${app.origin}/api/sessions`)).json()).sessions;
  assert.equal(sessions[0].summary, 'stale');
  assert.equal((await app.post('/api/sessions/one/rebuild')).status, 200);
  await until(() => app.sessions.load('one').state.summary === 'idle');
  assert.ok(app.workers().at(-1).args.includes('--rebuild'));
  assert.equal(entry.state.lastArchive, 'archive/synthetic');
  assert.equal(entry.state.staleReasons, undefined);
  assert.equal(entry.state.collection, 'running');
});

test('legacy sessions without saved settings rebuild with their recorded window and focus', async (t) => {
  const app = await fixture(t);
  const dir = path.join(app.root, 'legacy');
  fs.mkdirSync(dir);
  writeJson(path.join(dir, 'meeting.json'), metadata({ xcode: '58', xcgcd: 'legacy' }));
  writeJson(path.join(dir, 'state.json'), {
    windowMinutes: 10,
    categories: ['기관', '그외'],
    windows: {},
    finalizedThrough: 1,
  });
  assert.equal((await app.post('/api/sessions/legacy/retry')).status, 400);
  assert.equal((await app.post('/api/sessions/legacy/rebuild')).status, 200);
  await until(() => app.sessions.load('legacy').state.summary === 'complete');
  const args = app.workers().at(-1).args;
  for (const arg of ['--window=10', '--focus=기관']) assert.ok(args.includes(arg), arg);
  assert.ok(args.includes('--rebuild') && args.includes('--finalize'));
  assert.equal(app.sessions.load('legacy').config.windowMinutes, 10);
});
