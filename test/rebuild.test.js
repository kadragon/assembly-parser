import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireLock } from '../src/ownership.js';
import { snapshot } from '../src/snapshot.js';
import { writeJson } from '../src/store.js';

// Window-aligned, long closed: every window is due on the first run.
const T0 = Date.UTC(2026, 0, 1, 1, 0, 0);
const STALE = 3;

// An executable fake Claude: never credentials, one log line per call.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.CALL_LOG, 'call\\n');
const schema = process.argv[process.argv.indexOf('--json-schema') + 1] ?? '';
process.stdin.resume();
process.stdin.on('end', () => {
  if (schema.includes('topic_id')) {
    const category = JSON.parse(schema).properties.items.items.properties.new_category.enum[0];
    const item = { topic_id: 'new', new_title: '합성 주제', new_category: category, new_description: '합성', notes: '- 합성 메모', members: [], institutions: [] };
    console.log(JSON.stringify({ structured_output: { items: [item] } }));
  } else if (schema.includes('bullets')) {
    console.log(JSON.stringify({ structured_output: { core: '합성 핵심', bullets: [] } }));
  } else console.log('**핵심**: 합성 요약');
});
`;

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assembly-rebuild-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'one');
  fs.mkdirSync(dir);
  writeJson(path.join(dir, 'meeting.json'), { committee: 'Synthetic', subject: 'Fixture' });
  const transcript = path.join(dir, 'transcript.jsonl');
  const caption = (key, ts, text) =>
    fs.appendFileSync(transcript, `${JSON.stringify({ key, ts, text })}\n`);
  caption('a', T0 + 1_000, '첫 발언');
  caption('b', T0 + 6 * 60_000, '둘째 발언');
  fs.writeFileSync(path.join(root, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  const log = path.join(root, 'calls');
  const env = {
    ...process.env,
    PATH: `${root}${path.delimiter}${process.env.PATH}`,
    CALL_LOG: log,
  };
  const run = async (args) => {
    const child = spawn(
      process.execPath,
      ['src/summarize.js', 'one', '--data', root, '--once', ...args],
      { env },
    );
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    const [code] = await once(child, 'close');
    return { code, stderr };
  };
  const calls = () =>
    fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0;
  const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
  return { root, dir, run, calls, read, caption };
}

async function ok(fixture, args) {
  const result = await fixture.run(args);
  assert.equal(result.code, 0, result.stderr);
}

async function refused(fixture, args, reason) {
  const state = fixture.read('state.json');
  const before = fixture.calls();
  const result = await fixture.run(args);
  assert.equal(result.code, STALE, result.stderr);
  assert.match(result.stderr, reason);
  assert.equal(fixture.read('state.json'), state, 'stale output must not be rewritten');
  assert.equal(fixture.calls(), before, 'stale output must not reach the model');
}

test('changed focus note or keywords require a rebuild instead of silently reusing summaries', async (t) => {
  const f = setup(t);
  const focus = ['--focus', '기관', '--focus-keywords', 'k1', '--focus-note', '사업 A'];
  await ok(f, focus);
  await refused(
    f,
    ['--focus', '기관', '--focus-keywords', 'k1', '--focus-note', '사업 B'],
    /focusNote/,
  );
  await refused(
    f,
    ['--focus', '기관', '--focus-keywords', 'k2', '--focus-note', '사업 A'],
    /focusKeywords/,
  );
});

test('a caption corrected after its window was summarized marks the output stale', async (t) => {
  const f = setup(t);
  await ok(f, []);
  f.caption('a', T0 + 1_000, '첫 발언 정정');
  await refused(f, [], /changed after it was summarized/);
  // a late caption landing in an earlier, never-summarized window is also a source change
  const g = setup(t);
  await ok(g, []);
  g.caption('late', T0 + 11 * 60_000, '늦은 자막');
  await ok(g, []);
  g.caption('early', T0 - 4 * 60_000, '앞 구간에 늦게 도착');
  await refused(g, [], /changed after it was summarized/);
});

test('unchanged input resumes without model calls or duplicate entries; presentation flags do not invalidate', async (t) => {
  const f = setup(t);
  await ok(f, ['--focus', '기관', '--focus-keywords', 'k1, k2']);
  const calls = f.calls();
  // `running` records the worker pid on every start; everything derived must stay identical
  const derived = () => {
    const { running, ...rest } = JSON.parse(f.read('state.json'));
    return rest;
  };
  const state = derived();
  const topic = f.read('topics/t001.json');
  await ok(f, ['--focus', ' 기관 ', '--focus-keywords', 'k1,k2', '--factcheck']);
  await ok(f, []); // omitted flags reuse the saved effective settings
  assert.equal(f.calls(), calls);
  assert.deepEqual(derived(), state);
  assert.equal(f.read('topics/t001.json'), topic);
  assert.equal(JSON.parse(topic).entries.length, 2);
  // an explicit flag still overrides the saved value
  await refused(f, ['--window', '10'], /windowMinutes/);
  await refused(f, ['--focus', ''], /focus/);
});

test('explicit rebuild archives state, topics and proposals together and reprocesses in order', async (t) => {
  const f = setup(t);
  await ok(f, ['--window', '10']);
  fs.writeFileSync(path.join(f.dir, 'curation.jsonl'), '{"ops":[]}\n');
  const state = f.read('state.json');
  const topic = f.read('topics/t001.json');
  const transcript = f.read('transcript.jsonl');
  f.caption('a', T0 + 1_000, '첫 발언 정정');
  await refused(f, [], /changed after it was summarized/);
  const before = f.calls();
  await ok(f, ['--rebuild']);
  assert.ok(f.calls() > before);
  const archives = fs.readdirSync(path.join(f.dir, 'archive'));
  assert.equal(archives.length, 1);
  const archived = path.join(f.dir, 'archive', archives[0]);
  assert.equal(fs.readFileSync(path.join(archived, 'state.json'), 'utf8'), state);
  assert.equal(fs.readFileSync(path.join(archived, 'topics', 't001.json'), 'utf8'), topic);
  assert.ok(fs.existsSync(path.join(archived, 'curation.jsonl')));
  assert.equal(fs.existsSync(path.join(f.dir, 'curation.jsonl')), false);
  assert.equal(
    f.read('transcript.jsonl'),
    `${transcript}${JSON.stringify({ key: 'a', ts: T0 + 1_000, text: '첫 발언 정정' })}\n`,
  );
  const rebuilt = JSON.parse(f.read('state.json'));
  assert.equal(rebuilt.settings.windowMinutes, 10, 'omitted --window keeps the saved setting');
  assert.equal(rebuilt.rebuiltFrom, path.join('archive', archives[0]));
  assert.deepEqual(Object.keys(rebuilt.windows).map(Number), [T0]);
  await ok(f, []);
});

test('an interrupted rebuild resumes from its published archive without mixing old and new output', async (t) => {
  const f = setup(t);
  await ok(f, ['--window', '10', '--focus', '기관']);
  // simulate a crash after the archive was published and the old topics were removed
  const archived = path.join(f.dir, 'archive', 'interrupted');
  fs.mkdirSync(archived, { recursive: true });
  fs.copyFileSync(path.join(f.dir, 'state.json'), path.join(archived, 'state.json'));
  fs.cpSync(path.join(f.dir, 'topics'), path.join(archived, 'topics'), { recursive: true });
  const { settings } = JSON.parse(f.read('state.json'));
  writeJson(path.join(f.dir, '.rebuild.json'), {
    archive: path.join('archive', 'interrupted'),
    settings,
  });
  // the crash also removed the live state, so only the marker remembers the requested settings
  fs.rmSync(path.join(f.dir, 'topics'), { recursive: true });
  fs.renameSync(path.join(f.dir, 'state.json'), path.join(f.root, 'old-state.json'));
  const old = fs.readFileSync(path.join(f.root, 'old-state.json'), 'utf8');
  await ok(f, []);
  assert.equal(fs.existsSync(path.join(f.dir, '.rebuild.json')), false);
  const state = JSON.parse(f.read('state.json'));
  assert.notEqual(f.read('state.json'), old);
  assert.equal(state.rebuiltFrom, path.join('archive', 'interrupted'));
  assert.deepEqual(state.settings, settings);
  assert.equal(state.rebuilding, undefined, 'a completed pass clears the rebuilding flag');
  assert.deepEqual(
    fs.readdirSync(path.join(f.dir, 'topics')).filter((n) => n.endsWith('.json')),
    ['t001.json'],
  );
  assert.equal(fs.readFileSync(path.join(archived, 'state.json'), 'utf8'), old);
});

test('a held summarizer lock prevents rebuild writes', async (t) => {
  const f = setup(t);
  await ok(f, []);
  const state = f.read('state.json');
  const release = acquireLock(f.dir, 'summarizer');
  try {
    const result = await f.run(['--rebuild']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /already owned/);
  } finally {
    release();
  }
  assert.equal(f.read('state.json'), state);
  assert.equal(fs.existsSync(path.join(f.dir, 'archive')), false);
});

test('legacy output without recorded settings stays viewable and unmodified until rebuilt', async (t) => {
  const f = setup(t);
  const legacy = {
    windowMinutes: 5,
    categories: ['기관', '그외'],
    windows: {
      [T0]: {
        start: T0,
        end: T0 + 300_000,
        lineCount: 1,
        summary: '옛 요약',
        routed: true,
        topics: [],
      },
    },
  };
  writeJson(path.join(f.dir, 'state.json'), legacy);
  const view = snapshot(f.dir);
  assert.equal(view.windows[0].summary, '옛 요약');
  assert.match(view.rebuild.required.join(' '), /no recorded settings/);
  await refused(f, ['--focus', '기관'], /no recorded settings/);
  await ok(f, ['--rebuild']);
  const state = JSON.parse(f.read('state.json'));
  assert.equal(state.settings.focus, '기관', 'rebuild derives omitted settings from legacy output');
  assert.deepEqual(snapshot(f.dir).rebuild.required, []);
});

test('speaker-split finals and bulleted notes do not break unchanged output', async (t) => {
  const f = setup(t);
  await ok(f, ['--focus=기관', '--focus-note=- 부설 학교\n- 기숙사']);
  // the STT server re-sends a final with turns split onto "-" lines; the words are unchanged
  f.caption('b', T0 + 6 * 60_000, '둘째\n- 발언');
  await ok(f, []);
  assert.equal(JSON.parse(f.read('state.json')).settings.focusNote, '- 부설 학교\n- 기숙사');
});

test('output written by another state version requires a rebuild', async (t) => {
  const f = setup(t);
  await ok(f, []);
  const state = JSON.parse(f.read('state.json'));
  writeJson(path.join(f.dir, 'state.json'), { ...state, version: 1 });
  await refused(f, [], /state version changed/);
});
