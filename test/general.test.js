import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startApp } from '../src/app.js';
import { parseJsonl } from '../src/importer.js';
import { snapshot } from '../src/snapshot.js';
import { writeJson } from '../src/store.js';

const fixture = (name) => fs.readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
const HEADER = '{"format":"assembly-parser.transcript","version":1}';

// An executable fake Claude: never credentials. It logs every call and echoes the first
// explicit [speaker] label it was given, so tests can follow speakers through the pipeline.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const schema = args.includes('--json-schema') ? args[args.indexOf('--json-schema') + 1] : '';
const system = args[args.indexOf('--system-prompt') + 1];
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ system, input, schema }) + '\\n');
  const mode = process.env.FAKE_MODE ?? 'ok';
  if (mode === 'fail' && !schema) {
    console.error('synthetic window failure');
    process.exit(1);
  }
  if (mode === 'auth') {
    console.error('Invalid API key · Please run /login');
    process.exit(1);
  }
  const speaker =
    /^\\[([^\\]]+)\\]/m.exec(input.slice(input.indexOf('<자막>')))?.[1] ??
    /화자: ([^,)]+)/.exec(input)?.[1];
  if (schema.includes('topic_id')) {
    if (mode === 'bad') return console.log(JSON.stringify({ structured_output: { items: [{ topic_id: 'new' }] } }));
    const category = JSON.parse(schema).properties.items.items.properties.new_category.enum[0];
    const item = { topic_id: 'new', new_title: '합성 주제', new_category: category, new_description: '합성', notes: '- 합성 메모' };
    if (schema.includes('speakers')) Object.assign(item, { speakers: speaker ? [speaker] : [], organizations: [] });
    else Object.assign(item, { members: [], institutions: [] });
    console.log(JSON.stringify({ structured_output: { items: [item] } }));
  } else if (schema.includes('bullets')) {
    const bullet = schema.includes('organization')
      ? { tag: '설명', speaker: speaker ?? '', organization: '', text: '합성 불릿' }
      : { tag: '질의', member: '', institution: '', text: '합성 불릿' };
    console.log(JSON.stringify({ structured_output: { core: '합성 핵심', bullets: [bullet] } }));
  } else console.log('**핵심**: 합성 요약');
});
`;

function fakeClaude(root, mode = 'ok') {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  const log = path.join(root, 'calls.jsonl');
  return {
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      CALL_LOG: log,
      FAKE_MODE: mode,
    },
    calls: () =>
      fs.existsSync(log)
        ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
        : [],
  };
}

async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('condition not reached');
}

// The application passes its own environment to workers; point it at the fake for one test.
function withEnv(t, env) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });
}

async function app(t, root) {
  const instance = await startApp({ root, port: 0, interval: 60000 });
  t.after(() => instance.close());
  const token = (await (await fetch(`${instance.origin}/api/sessions`)).json()).token;
  const post = (url, body = {}, headers = {}) =>
    fetch(`${instance.origin}${url}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: instance.origin,
        'X-Session-Token': token,
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const sessions = async () =>
    (await (await fetch(`${instance.origin}/api/sessions`)).json()).sessions;
  const state = async (id) => (await fetch(`${instance.origin}/sessions/${id}/api/state`)).json();
  return { ...instance, post, sessions, state };
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assembly-general-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const upload = (id, content = fixture('general-meeting.jsonl'), extra = {}) => ({
  id,
  title: '주간 운영 회의',
  config: { windowMinutes: 5 },
  content,
  ...extra,
});

test('an uploaded meeting is summarized, viewable and reopened without terminal arguments', async (t) => {
  const root = tempRoot(t);
  const claude = fakeClaude(root);
  withEnv(t, claude.env);
  const first = await app(t, root);
  const res = await first.post('/api/upload', upload('weekly'));
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await res.json()).collection, 'imported');
  await until(async () => (await first.sessions())[0]?.summary === 'complete');

  const s = await first.state('weekly');
  assert.equal(s.profile, 'general');
  assert.equal(s.timeBasis, 'elapsed');
  assert.equal(s.complete, true);
  assert.deepEqual(s.current.lines, [], 'a completed file has no live window');
  // every populated window, including the last partial one (10:00–10:25 of a 5-minute grid)
  assert.deepEqual(
    s.windows.map((w) => [w.start, w.lineCount, Boolean(w.summary), w.routed]),
    [
      [600_000, 1, true, true],
      [300_000, 2, true, true],
      [0, 3, true, true],
    ],
  );
  const [topic] = s.topics;
  assert.deepEqual(
    topic.entries.map((e) => [e.label, e.speakers]),
    [
      ['00:00–00:05', ['진행자']],
      ['00:05–00:10', ['김하늘']],
      ['00:10–00:15', ['진행자']],
    ],
  );
  assert.equal(topic.summary.bullets[0].speaker, '진행자');

  // model input: explicit speakers kept as labels; general prompts carry no parliamentary roles
  const calls = claude.calls();
  assert.ok(calls.some((c) => c.input.includes('[김하늘] 지난주 고객 문의는')));
  for (const call of calls) {
    assert.doesNotMatch(call.system, /국회/);
    assert.doesNotMatch(call.schema, /members|institutions/);
  }

  // Markdown export uses elapsed labels and plain speaker names
  const markdown = fs.readFileSync(path.join(root, 'weekly', 'topics', `${topic.id}.md`), 'utf8');
  assert.match(markdown, /### 00:05–00:10 — 김하늘/);
  assert.doesNotMatch(markdown, /위원/);

  await first.close();
  const second = await app(t, root);
  const [reopened] = await second.sessions();
  assert.equal(reopened.id, 'weekly');
  assert.equal(reopened.collection, 'imported');
  assert.equal((await second.state('weekly')).topics.length, 1);
  // there is no broadcast to resume
  const resume = await second.post('/api/sessions/weekly/resume');
  assert.equal(resume.status, 400);
  assert.match((await resume.json()).error, /no live collection/);
});

test('rejected uploads expose no session, leave no staging files and start no workers', async (t) => {
  const root = tempRoot(t);
  const claude = fakeClaude(root);
  withEnv(t, claude.env);
  const a = await app(t, root);
  const listing = () => fs.readdirSync(root).filter((n) => !['bin', 'calls.jsonl'].includes(n));
  const before = listing();
  const cases = [
    [upload('../escape'), /Invalid session identifier/],
    [upload('a/b'), /Invalid session identifier/],
    [upload(''), /Invalid session identifier/],
    [upload('ok', undefined, { title: '' }), /Title/],
    [upload('ok', undefined, { title: '줄\n바꿈' }), /Title/],
    [upload('ok', undefined, { config: { factcheck: true } }), /Unknown setting/],
    [upload('ok', undefined, { extra: 1 }), /Invalid upload payload/],
    [upload('ok', `${HEADER}\n{"start":10,"end":5,"text":"역전"}`), /line 2: end is before start/],
    [upload('ok', `${HEADER}\n{"start":-1,"text":"음수"}`), /line 2: start must be/],
    [upload('ok', `${HEADER}\n{"start":0,"text":""}`), /line 2: text must be a non-empty/],
    [upload('ok', HEADER), /no transcript records/],
    [upload('ok', `${HEADER}\n${'x'.repeat(5 * 1024 * 1024)}`), /larger than 5 MB/],
  ];
  for (const [body, error] of cases) {
    const res = await a.post('/api/upload', body);
    assert.equal(res.status, 400, JSON.stringify(body.id));
    assert.match((await res.json()).error, error);
  }
  const tooLarge = await a.post('/api/upload', upload('ok', 'x'.repeat(11 * 1024 * 1024)));
  assert.equal(tooLarge.status, 400);
  const foreign = await a.post('/api/upload', upload('ok'), { 'X-Session-Token': 'wrong' });
  assert.equal(foreign.status, 403);
  assert.deepEqual(listing(), before);
  assert.deepEqual(await a.sessions(), []);
  assert.equal(claude.calls().length, 0);

  // an existing destination is refused, never overwritten
  assert.equal((await a.post('/api/upload', upload('dup'))).status, 200);
  await until(async () => (await a.sessions())[0]?.summary === 'complete');
  const transcript = fs.readFileSync(path.join(root, 'dup', 'transcript.jsonl'), 'utf8');
  const again = await a.post('/api/upload', upload('dup', fixture('general-lecture.jsonl')));
  assert.equal(again.status, 400);
  assert.match((await again.json()).error, /already exists/);
  assert.equal(fs.readFileSync(path.join(root, 'dup', 'transcript.jsonl'), 'utf8'), transcript);
  assert.ok(!fs.readdirSync(root).some((n) => n.startsWith('.upload-')));
  // an Assembly start cannot take over an uploaded session's directory
  const start = await a.post('/api/start', {
    url: 'https://assembly.webcast.go.kr/main/player.asp?xcode=58&xcgcd=dup',
  });
  assert.equal(start.status, 400);
});

// Lays out an uploaded session on disk, as the application does, for direct CLI runs.
function session(root, id, content) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const { lines, duration } = parseJsonl(content);
  writeJson(path.join(dir, 'meeting.json'), {
    version: 1,
    profile: 'general',
    timeBasis: 'elapsed',
    complete: true,
    title: '합성 강의',
    committee: '',
    subject: '합성 강의',
    date: '',
    duration,
  });
  fs.writeFileSync(
    path.join(dir, 'transcript.jsonl'),
    lines.map((l) => `${JSON.stringify(l)}\n`).join(''),
  );
  return dir;
}

async function summarize(id, root, env, args = []) {
  const child = spawn(
    process.execPath,
    ['src/summarize.js', id, '--data', root, '--once', ...args],
    { env: { ...process.env, ...env } },
  );
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  const [code] = await once(child, 'close');
  return { code, stderr };
}

test('general sessions refuse Assembly-only fact checks and curation before writing', async (t) => {
  const root = tempRoot(t);
  const claude = fakeClaude(root);
  const dir = session(root, 'lecture', fixture('general-lecture.jsonl'));
  for (const flag of ['--factcheck', '--curate']) {
    const result = await summarize('lecture', root, claude.env, [flag]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /only available for Assembly sessions/);
  }
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
  assert.equal(claude.calls().length, 0);
});

test('windows past 24 hours keep counting and a completed file needs no --finalize', async (t) => {
  const root = tempRoot(t);
  const claude = fakeClaude(root);
  const day = 24 * 3600_000;
  session(
    root,
    'long',
    [HEADER, JSON.stringify({ start: day + 60_000, end: day + 400_000, text: '긴 강의 끝' })].join(
      '\n',
    ),
  );
  const result = await summarize('long', root, claude.env);
  assert.equal(result.code, 0, result.stderr);
  const s = snapshot(path.join(root, 'long'));
  assert.deepEqual(
    s.windows.map((w) => w.start),
    [day],
  );
  assert.equal(s.topics[0].entries[0].label, '24:00–24:05');
});

test('model setup failures are actionable and invalid structured output is never persisted', async (t) => {
  const root = tempRoot(t);
  const dir = session(root, 'one', fixture('general-lecture.jsonl'));
  const state = () => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  const emptyBin = path.join(root, 'empty-bin');
  fs.mkdirSync(emptyBin);
  await summarize('one', root, { PATH: emptyBin });
  const missing = state().windows[0];
  assert.match(missing.error, /Claude Code CLI not found/);
  assert.match(missing.routeError, /Claude Code CLI not found/);

  await summarize('one', root, fakeClaude(root, 'auth').env);
  assert.match(state().windows[0].error, /not signed in: run `claude` once and sign in/);

  await summarize('one', root, fakeClaude(root, 'bad').env);
  const bad = state().windows[0];
  assert.equal(bad.summary, '**핵심**: 합성 요약');
  assert.match(bad.routeError, /bad structured output: output\.items\[0\]\.notes is missing/);
  assert.notEqual(bad.routed, true);
  assert.equal(fs.existsSync(path.join(dir, 'topics')), false);
});

test('legacy Assembly topics are read through the neutral adapter without being rewritten', (t) => {
  const root = tempRoot(t);
  const dir = path.join(root, 'legacy');
  fs.mkdirSync(path.join(dir, 'topics'), { recursive: true });
  writeJson(path.join(dir, 'meeting.json'), { committee: '교육위원회', subject: '합성', date: '' });
  writeJson(path.join(dir, 'state.json'), { windowMinutes: 5, windows: {} });
  const legacy = {
    id: 't001',
    category: '전체',
    title: '충원율',
    description: '',
    created: 0,
    entries: [
      { start: 0, end: 300000, label: '10:00–10:05', notes: '- 질의', members: ['김민전'] },
    ],
    summary: {
      core: '핵심',
      bullets: [{ tag: '질의', member: '김민전', institution: '교원대', text: '질의' }],
      until: 300000,
    },
  };
  const file = path.join(dir, 'topics', 't001.json');
  fs.writeFileSync(file, JSON.stringify(legacy));
  const bytes = fs.readFileSync(file);
  const s = snapshot(dir);
  assert.equal(s.profile, 'assembly');
  assert.equal(s.timeBasis, 'absolute');
  assert.deepEqual(s.topics[0].entries[0].speakers, ['김민전']);
  assert.deepEqual(s.topics[0].entries[0].organizations, []);
  assert.equal(s.topics[0].summary.bullets[0].speaker, '김민전');
  assert.equal(s.topics[0].summary.bullets[0].organization, '교원대');
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('every line of a multi-line cue keeps its explicit speaker in the model input', async (t) => {
  const root = tempRoot(t);
  const claude = fakeClaude(root);
  session(
    root,
    'multi',
    [HEADER, JSON.stringify({ start: 0, speaker: '김하늘', text: '첫 줄\n둘째 줄' })].join('\n'),
  );
  const result = await summarize('multi', root, claude.env);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(claude.calls().some((c) => c.input.includes('[김하늘] 첫 줄\n[김하늘] 둘째 줄')));
});

test('an uploaded window that keeps failing is skipped across one-shot runs', async (t) => {
  const root = tempRoot(t);
  const claude = fakeClaude(root, 'fail');
  const dir = session(root, 'flaky', fixture('general-lecture.jsonl'));
  const windows = () => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).windows;
  await summarize('flaky', root, claude.env);
  await summarize('flaky', root, claude.env);
  assert.equal(windows()[0].attempts, 2);
  assert.notEqual(windows()[0].skipped, true);
  await summarize('flaky', root, claude.env);
  assert.equal(windows()[0].skipped, true);
  // the next window is no longer blocked by the first
  assert.equal(windows()[300000].attempts, 1);
});

test('stale reasons for an uploaded file name the elapsed window, past 24 hours', async (t) => {
  const root = tempRoot(t);
  const claude = fakeClaude(root);
  const day = 24 * 3600_000;
  const dir = session(
    root,
    'late',
    [HEADER, JSON.stringify({ id: 'a', start: day + 600_000, text: '원문' })].join('\n'),
  );
  assert.equal((await summarize('late', root, claude.env)).code, 0);
  fs.appendFileSync(
    path.join(dir, 'transcript.jsonl'),
    `${JSON.stringify({ key: 'id:a', ts: day + 600_000, text: '정정' })}\n`,
  );
  const result = await summarize('late', root, claude.env);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /captions for 24:10 elapsed window changed/);
});
