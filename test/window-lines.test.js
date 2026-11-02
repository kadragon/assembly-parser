import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fingerprint } from '../src/rebuild.js';
import { windowLines } from '../src/snapshot.js';
import { readTranscript, writeJson } from '../src/store.js';

const T0 = Date.UTC(2026, 0, 1, 1, 0, 0);
const W = 5 * 60_000;

function session(t, meeting, rows) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assembly-window-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'one');
  fs.mkdirSync(dir);
  writeJson(path.join(dir, 'meeting.json'), meeting);
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  return { dir, file };
}

function summarize(dir, file, start) {
  const lines = readTranscript(file).between(start, start + W);
  writeJson(path.join(dir, 'state.json'), {
    windowMinutes: 5,
    windows: {
      [start]: { start, end: start + W, lineCount: lines.length, fingerprint: fingerprint(lines) },
    },
  });
}

const snapshotFiles = (dir) =>
  Object.fromEntries(
    fs.readdirSync(dir).map((n) => {
      const p = path.join(dir, n);
      return [n, [fs.readFileSync(p, 'utf8'), fs.statSync(p).mtimeMs]];
    }),
  );

test('a window lists its own captions in time order, latest final per segment', (t) => {
  const { dir, file } = session(t, { committee: 'Synthetic' }, [
    { key: 'a:0', ts: T0 - 1, text: '이전 구간' },
    { key: 'c:0', ts: T0 + 60_000, text: '둘째' },
    { key: 'b:0', ts: T0, text: '첫째 경계' },
    { key: 'd:0', ts: T0 + W, text: '다음 구간 경계' },
    // a re-sent final keeps the first-seen time and replaces the text
    { key: 'b:0', ts: T0 + 90_000, text: '첫째 경계 수정' },
  ]);
  summarize(dir, file, T0);
  const before = snapshotFiles(dir);

  const result = windowLines(dir, T0);

  assert.equal(result.start, T0);
  assert.equal(result.end, T0 + W);
  assert.equal(result.timeBasis, 'absolute');
  assert.deepEqual(
    result.lines.map((l) => [l.key, l.ts, l.text]),
    [
      ['b:0', T0, '첫째 경계 수정'],
      ['c:0', T0 + 60_000, '둘째'],
    ],
  );
  assert.equal(result.stale, false);
  assert.deepEqual(snapshotFiles(dir), before, 'lookup writes nothing');
});

test('a caption corrected after the summary marks the window stale', (t) => {
  const { dir, file } = session(t, { committee: 'Synthetic' }, [
    { key: 'b:0', ts: T0, text: '원래 발언' },
  ]);
  summarize(dir, file, T0);
  fs.appendFileSync(file, `${JSON.stringify({ key: 'b:0', ts: T0 + 5, text: '다른 발언' })}\n`);

  const result = windowLines(dir, T0);

  assert.equal(result.stale, true);
  assert.deepEqual(
    result.lines.map((l) => l.text),
    ['다른 발언'],
  );
});

test('an uploaded session reports elapsed time', (t) => {
  const { dir, file } = session(t, { profile: 'general', timeBasis: 'elapsed', complete: true }, [
    { key: '1', ts: 61_000, text: '강의 시작' },
  ]);
  summarize(dir, file, 0);
  const result = windowLines(dir, 0);
  assert.equal(result.timeBasis, 'elapsed');
  assert.deepEqual(
    result.lines.map((l) => l.ts),
    [61_000],
  );
});

test('unknown windows and malformed starts are rejected without writes', (t) => {
  const { dir, file } = session(t, { committee: 'Synthetic' }, [
    { key: 'b:0', ts: T0, text: '발언' },
  ]);
  summarize(dir, file, T0);
  const before = snapshotFiles(dir);
  for (const start of [T0 + W, T0 + 1, -1, Number.NaN, 1.5, '1', undefined])
    assert.throws(() => windowLines(dir, start), /window/i, String(start));
  assert.deepEqual(snapshotFiles(dir), before);
});
