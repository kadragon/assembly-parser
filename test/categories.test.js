import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startApp } from '../src/app.js';
import { validateConfig } from '../src/control.js';
import { snapshot } from '../src/snapshot.js';
import { writeJson } from '../src/store.js';

const T0 = Date.UTC(2026, 0, 1, 1, 0, 0);
const STALE = 3;
const CATEGORIES = [
  { name: '예산', description: '예산 편성과 집행', keywords: ['예산', '집행률'] },
  { name: '인사', description: '채용·승진', keywords: [] },
  { name: '그외', description: '', keywords: [], fallback: true },
];

// An executable fake Claude: never credentials. It logs each call and routes every item to
// FAKE_CATEGORY, which may be a category the prompt never offered.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const schema = args.includes('--json-schema') ? args[args.indexOf('--json-schema') + 1] : '';
const system = args[args.indexOf('--system-prompt') + 1];
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ system, input, schema }) + '\\n');
  if (schema.includes('topic_id')) {
    const item = { topic_id: 'new', new_title: '합성 주제', new_category: process.env.FAKE_CATEGORY, new_description: '합성', notes: '- 합성 메모' };
    if (schema.includes('speakers')) Object.assign(item, { speakers: [], organizations: [] });
    else Object.assign(item, { members: [], institutions: [] });
    console.log(JSON.stringify({ structured_output: { items: [item] } }));
  } else if (schema.includes('bullets')) {
    console.log(JSON.stringify({ structured_output: { core: '합성 핵심', bullets: [] } }));
  } else console.log('**핵심**: 합성 요약');
});
`;

function fakeClaude(root, category = '예산') {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  const log = path.join(root, 'calls.jsonl');
  return {
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      CALL_LOG: log,
      FAKE_CATEGORY: category,
    },
    calls: () =>
      fs.existsSync(log)
        ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
        : [],
  };
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assembly-categories-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// One Assembly session with two closed windows, summarized by summarize.js --once.
function assembly(t, category) {
  const root = tempRoot(t);
  const dir = path.join(root, 'one');
  fs.mkdirSync(dir);
  writeJson(path.join(dir, 'meeting.json'), { committee: 'Synthetic', subject: 'Fixture' });
  const transcript = path.join(dir, 'transcript.jsonl');
  for (const [key, ts, text] of [
    ['a', T0 + 1_000, '예산 집행률이 낮습니다'],
    ['b', T0 + 6 * 60_000, '다음 안건입니다'],
  ])
    fs.appendFileSync(transcript, `${JSON.stringify({ key, ts, text })}\n`);
  const claude = fakeClaude(root, category);
  const run = async (args) => {
    const child = spawn(
      process.execPath,
      ['src/summarize.js', 'one', '--data', root, '--once', ...args],
      { env: { ...process.env, ...claude.env } },
    );
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    const [code] = await once(child, 'close');
    return { code, stderr };
  };
  const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
  return { root, dir, run, read, claude };
}

const flag = (categories) => ['--categories', JSON.stringify(categories)];

test('category configuration requires unique nonempty names and exactly one fallback', () => {
  const ok = validateConfig({ categories: CATEGORIES });
  assert.deepEqual(
    ok.categories.map((c) => [c.name, c.fallback]),
    [
      ['예산', false],
      ['인사', false],
      ['그외', true],
    ],
  );
  // keyword chips are trimmed and de-duplicated; empty chips are dropped
  assert.deepEqual(
    validateConfig({
      categories: [{ name: ' A ', keywords: [' k ', 'k', ''], fallback: true }],
    }).categories,
    [{ name: 'A', description: '', keywords: ['k'], fallback: true }],
  );
  // no categories keeps the stored shape of focus and overall configurations
  assert.equal('categories' in validateConfig({ focus: '기관' }), false);
  assert.equal('categories' in validateConfig({ categories: [] }), false);
  for (const categories of [
    [{ name: '', fallback: true }],
    [{ name: '두\n줄', fallback: true }],
    [{ name: 'A', fallback: true }, { name: 'A' }],
    [{ name: 'A' }, { name: 'B' }],
    [
      { name: 'A', fallback: true },
      { name: 'B', fallback: true },
    ],
    [{ name: 'A', fallback: 'yes' }],
    [{ name: 'A', fallback: true, keywords: 'k1,k2' }],
    [{ name: 'A', fallback: true, color: 'red' }],
    'A,B',
    Array.from({ length: 13 }, (_, i) => ({ name: `c${i}`, fallback: i === 0 })),
  ])
    assert.throws(() => validateConfig({ categories }), undefined, JSON.stringify(categories));
  // explicit categories never mix with the legacy focus shorthand
  for (const legacy of [{ focus: '기관' }, { focusKeywords: 'k' }, { focusNote: 'n' }])
    assert.throws(() => validateConfig({ ...legacy, categories: CATEGORIES }), /focus/);
});

test('explicit categories reach the router with descriptions, keyword hints and the fallback', async (t) => {
  const f = assembly(t, '없는 범주');
  const result = await f.run(flag(CATEGORIES));
  assert.equal(result.code, 0, result.stderr);
  const state = JSON.parse(f.read('state.json'));
  assert.deepEqual(state.categories, ['예산', '인사', '그외']);
  assert.deepEqual(
    state.settings.categories,
    validateConfig({ categories: CATEGORIES }).categories,
  );
  const route = f.claude.calls().filter((c) => c.schema.includes('topic_id'));
  assert.equal(route.length, 2);
  assert.deepEqual(
    JSON.parse(route[0].schema).properties.items.items.properties.new_category.enum,
    ['예산', '인사', '그외'],
  );
  for (const text of ['"예산": 예산 편성과 집행', '예산, 집행률', '"그외"'])
    assert.ok(route[0].system.includes(text), text);
  // keywords are hints for the window that mentions them, not routing rules
  assert.match(route[0].input, /"예산" 키워드\(예산, 집행률\)/);
  assert.doesNotMatch(route[1].input, /키워드/);
  // a category the prompt never offered lands in the explicit fallback
  const topic = JSON.parse(f.read('topics/t001.json'));
  assert.equal(topic.category, '그외');
  assert.match(f.read('topics/t001.md'), /^그외 · /m);
  // the viewer groups by the saved categories in their order
  assert.deepEqual(snapshot(f.dir).categories, ['예산', '인사', '그외']);
});

test('the fallback can be any category, not only the last one', async (t) => {
  const f = assembly(t, '없는 범주');
  const categories = [
    { name: '기타', fallback: true },
    { name: '예산', description: '예산' },
  ];
  assert.equal((await f.run(flag(categories))).code, 0);
  assert.equal(JSON.parse(f.read('topics/t001.json')).category, '기타');
});

test('CLI precedence: omitted flags keep saved categories; explicit flags override or are rejected', async (t) => {
  const f = assembly(t, '예산');
  assert.equal((await f.run(flag(CATEGORIES))).code, 0);
  const calls = f.claude.calls().length;
  const state = () => {
    const { running, ...rest } = JSON.parse(f.read('state.json'));
    return rest;
  };
  const saved = state();
  // omitted flags reuse the saved categories without model calls
  assert.equal((await f.run([])).code, 0);
  assert.equal(f.claude.calls().length, calls);
  assert.deepEqual(state(), saved);
  const refused = async (args, reason, code = STALE) => {
    const result = await f.run(args);
    assert.equal(result.code, code, result.stderr);
    assert.match(result.stderr, reason);
    assert.deepEqual(state(), saved, 'refused runs must not rewrite output');
    assert.equal(f.claude.calls().length, calls, 'refused runs must not reach the model');
  };
  // every summary-affecting edit needs a rebuild: description, keywords, order, fallback
  const edit = (fn) => fn(structuredClone(CATEGORIES));
  await refused(
    flag(edit((c) => Object.assign(c[0], { description: '다른 설명' }) && c)),
    /categories changed/,
  );
  await refused(flag(edit((c) => Object.assign(c[1], { keywords: ['채용'] }) && c)), /categories/);
  await refused(flag(edit((c) => [c[1], c[0], c[2]])), /categories/);
  await refused(
    flag(
      edit((c) => {
        c[2].fallback = false;
        c[1].fallback = true;
        return c;
      }),
    ),
    /categories/,
  );
  // an explicit legacy focus replaces saved categories
  await refused(['--focus', '기관'], /focus changed/);
  // combining both forms is rejected before anything is processed
  await refused([...flag(CATEGORIES), '--focus', '기관'], /focus/, 1);
  // an explicit empty list falls back to the overall summary
  await refused(['--categories', '[]'], /categories changed/);
});

test('legacy focus flags keep their two-category shorthand without recording categories', async (t) => {
  const f = assembly(t, '기관');
  const result = await f.run(['--focus', '기관', '--focus-keywords', '예산']);
  assert.equal(result.code, 0, result.stderr);
  const state = JSON.parse(f.read('state.json'));
  assert.deepEqual(state.categories, ['기관', '그외']);
  assert.equal('categories' in state.settings, false);
  const route = f.claude.calls().find((c) => c.schema.includes('topic_id'));
  assert.match(route.input, /참고: 이번 구간 자막에 기관\(예산\) 언급이 있습니다/);
  // an explicit empty category list is the same as omitting it
  assert.equal((await f.run(['--categories', '[]'])).code, 0);
  // empty focus keeps the single overall category
  const g = assembly(t, '전체');
  assert.equal((await g.run([])).code, 0);
  assert.deepEqual(JSON.parse(g.read('state.json')).categories, ['전체']);
});

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
  const post = (url, body = {}) =>
    fetch(`${instance.origin}${url}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: instance.origin,
        'X-Session-Token': token,
      },
      body: JSON.stringify(body),
    });
  const session = async (id) =>
    (await (await fetch(`${instance.origin}/api/sessions`)).json()).sessions.find(
      (s) => s.id === id,
    );
  return { ...instance, post, session };
}

async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('condition not reached');
}

const lecture = () =>
  fs.readFileSync(new URL('fixtures/general-lecture.jsonl', import.meta.url), 'utf8');

test('browser settings: uploaded categories persist, edits mark output stale, rebuild applies them', async (t) => {
  const root = tempRoot(t);
  const claude = fakeClaude(root, '예산');
  withEnv(t, claude.env);
  const a = await app(t, root);
  const created = await a.post('/api/upload', {
    id: 'lecture',
    title: '강의',
    config: { windowMinutes: 5, categories: CATEGORIES },
    content: lecture(),
  });
  assert.equal(created.status, 200, await created.clone().text());
  await until(async () => (await a.session('lecture')).summary === 'complete');
  const route = claude.calls().find((c) => c.schema.includes('topic_id'));
  // the general profile gets the same category guide
  assert.match(route.system, /회의·강의 기록을 주제별로/);
  assert.ok(route.system.includes('"예산": 예산 편성과 집행'));
  const dir = path.join(root, 'lecture');
  const topicsBefore = fs.readdirSync(path.join(dir, 'topics'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'topics', 't001.json'))).category, '예산');

  // invalid settings are refused before anything changes
  const sessionFile = fs.readFileSync(path.join(dir, 'session.json'), 'utf8');
  for (const body of [
    { config: { categories: [{ name: 'A' }] } },
    { config: { focus: '기관', categories: CATEGORIES } },
    { config: {}, extra: true },
    [],
  ])
    assert.equal((await a.post('/api/sessions/lecture/config', body)).status, 400);
  assert.equal((await a.post('/api/sessions/missing/config', { config: {} })).status, 400);
  assert.equal(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'), sessionFile);

  // an unchanged save is a no-op
  const same = await a.post('/api/sessions/lecture/config', {
    config: { windowMinutes: 5, categories: CATEGORIES },
  });
  assert.equal((await same.json()).summary, 'complete');

  // a summary-affecting edit explains the rebuild and leaves output untouched
  const edited = structuredClone(CATEGORIES);
  edited[0].name = '재정';
  const calls = claude.calls().length;
  const res = await a.post('/api/sessions/lecture/config', {
    config: { windowMinutes: 5, categories: edited },
  });
  assert.equal(res.status, 200);
  const stale = await res.json();
  assert.equal(stale.summary, 'stale');
  assert.match(stale.staleReasons, /categories changed/);
  assert.equal(claude.calls().length, calls, 'an edit alone never reaches the model');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'topics')), topicsBefore);

  // settings survive a server restart (browser refresh reads the same API)
  await a.close();
  const b = await app(t, root);
  const reopened = await b.session('lecture');
  assert.equal(reopened.config.categories[0].name, '재정');
  assert.equal(reopened.summary, 'stale');

  assert.equal((await b.post('/api/sessions/lecture/rebuild')).status, 200);
  await until(async () => (await b.session('lecture')).summary === 'complete');
  const after = await b.session('lecture');
  assert.match(after.lastArchive, /^archive\//);
  // the old categories stay in the archive; new output uses the edited ones
  const archived = path.join(dir, after.lastArchive, 'state.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(archived)).categories, ['예산', '인사', '그외']);
  assert.deepEqual(snapshot(dir).categories, ['재정', '인사', '그외']);
});

test('reverting an edit clears the stale status without a rebuild', async (t) => {
  const root = tempRoot(t);
  withEnv(t, fakeClaude(root, '예산').env);
  const a = await app(t, root);
  await a.post('/api/upload', {
    id: 'lecture',
    title: '강의',
    config: { windowMinutes: 5, categories: CATEGORIES },
    content: lecture(),
  });
  await until(async () => (await a.session('lecture')).summary === 'complete');
  const edited = structuredClone(CATEGORIES);
  edited[1].keywords = ['채용'];
  await a.post('/api/sessions/lecture/config', {
    config: { windowMinutes: 5, categories: edited },
  });
  assert.equal((await a.session('lecture')).summary, 'stale');
  const res = await a.post('/api/sessions/lecture/config', {
    config: { windowMinutes: 5, categories: CATEGORIES },
  });
  const view = await res.json();
  assert.equal(view.summary, 'complete');
  assert.equal(view.staleReasons, undefined);
});

test('review fixes: null categories, pre-profile output, large settings, restored status, CLI output config', async (t) => {
  const f = assembly(t, '예산');
  const rejected = await f.run(['--categories', 'null']);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /JSON list/);
  assert.equal(fs.existsSync(path.join(f.dir, 'state.json')), false);

  // output summarized before profiles existed is not stale just for lacking one
  assert.equal((await f.run(flag(CATEGORIES))).code, 0);
  const file = path.join(f.dir, 'state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete state.settings.profile;
  writeJson(file, state);
  assert.deepEqual(snapshot(f.dir).rebuild.required, []);
  assert.equal(snapshot(f.dir).fallback, '그외');

  // a CLI-made session offers its recorded settings to the editor
  const a = await app(t, f.root);
  const cli = await a.session('one');
  assert.equal(cli.config, null);
  assert.deepEqual(
    cli.outputConfig.categories.map((c) => c.name),
    ['예산', '인사', '그외'],
  );

  // the largest descriptions the validator accepts fit in the request
  const long = CATEGORIES.map((c) => ({ ...c, description: '가'.repeat(2000) }));
  const big = await a.post('/api/sessions/one/config', {
    config: { windowMinutes: 5, categories: long },
  });
  assert.equal(big.status, 200, await big.clone().text());
  assert.equal((await big.json()).summary, 'stale');

  // reverting restores the status the edit paused, not a guess
  const entry = a.sessions.load('one');
  entry.state.summaryBeforeStale = 'error';
  const reverted = await a.post('/api/sessions/one/config', {
    config: { windowMinutes: 5, categories: CATEGORIES },
  });
  assert.equal((await reverted.json()).summary, 'error');
  // a stale status reported by the worker is not lifted by a settings edit
  entry.state.summary = 'stale';
  entry.state.staleReasons = 'rebuild required:\n- promptVersion changed: 1 → 2';
  await a.post('/api/sessions/one/config', { config: { windowMinutes: 5, categories: long } });
  await a.post('/api/sessions/one/config', {
    config: { windowMinutes: 5, categories: CATEGORIES },
  });
  assert.equal((await a.session('one')).summary, 'stale');
});
