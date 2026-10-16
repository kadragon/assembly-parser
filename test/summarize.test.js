import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalInstitution } from '../src/topics.js';
import { closedWindows } from '../src/transcript.js';

test('a window waits for the grace period, since captions are written seconds after their timestamp', () => {
  const ms = 300_000;
  const lines = [{ ts: 1_000 }, { ts: ms - 5_000 }, { ts: ms + 1_000 }];
  assert.deepEqual(closedWindows(lines, ms, ms + 10_000, 30_000), []);
  assert.deepEqual(closedWindows(lines, ms, ms + 30_000, 30_000), [0]);
  assert.deepEqual(closedWindows(lines, ms, 2 * ms + 30_000, 30_000), [0, ms]);
});

test('institution variants map to the spelling already in use', () => {
  const known = ['한국교원대', '경인교육대', '한국체대', '방송대', '서울과기대', '서울대'];
  assert.equal(canonicalInstitution('한국교원대학교', known), '한국교원대');
  assert.equal(canonicalInstitution('경인교대', known), '경인교육대');
  assert.equal(canonicalInstitution('한국체육대학교', known), '한국체대');
  assert.equal(canonicalInstitution('방통대', known), '방송대');
  assert.equal(canonicalInstitution('서울과학기술대', known), '서울과기대');
  assert.equal(canonicalInstitution('서울대병원', known), '서울대병원');
  assert.equal(canonicalInstitution('교육부', known), '교육부');
});

test('curation proposals that reference missing topics or entries are dropped', async () => {
  const { validateCuration } = await import('../src/topics.js');
  const e = (start, label) => ({ start, end: start + 300_000, label, notes: '- 질의' });
  const topics = [
    { id: 't001', category: '그외', title: 'A', entries: [e(0, '10:00–10:05')] },
    { id: 't002', category: '그외', title: 'B', entries: [e(300_000, '10:05–10:10')] },
    {
      id: 't003',
      category: '그외',
      title: 'C',
      entries: [e(0, '10:00–10:05')],
      mergedInto: 't002',
    },
  ];
  const ops = [
    { type: 'merge', from: 't001', to: 't002', reason: 'same' },
    { type: 'merge', from: 't001', to: 't001', reason: 'self' },
    { type: 'merge', from: 't003', to: 't002', reason: 'already merged' },
    { type: 'move', from: 't002', to: 't001', entry: '10:05–10:10', reason: 'misfiled' },
    { type: 'move', from: 't002', to: 't001', entry: '11:00–11:05', reason: 'no such entry' },
    { type: 'recategorize', from: 't001', category: '전체', reason: 'unknown category' },
    { type: 'rename', from: 't009', title: 'X', reason: 'unknown topic' },
  ];
  assert.deepEqual(
    validateCuration(ops, topics, ['기관', '그외']).map((o) => o.reason),
    ['same', 'misfiled'],
  );
});
