import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanSources } from '../src/summarizer.js';
import { pendingFactCheck } from '../src/topics.js';

const entry = (end, members = ['김민전']) => ({
  start: end - 300_000,
  end,
  label: '',
  notes: '- 질의',
  members,
  institutions: [],
});

test('only entries with members after the last check are pending', () => {
  const topic = {
    title: '신입생 충원율 하락',
    entries: [entry(1000), entry(2000, []), entry(3000)],
    factcheck: { until: 1000, checks: [] },
  };
  assert.deepEqual(
    pendingFactCheck(topic).map((e) => e.end),
    [3000],
  );
});

test('unchecked topics start from the first entry; procedural topics are never checked', () => {
  assert.equal(pendingFactCheck({ title: '연구비', entries: [entry(1000)] }).length, 1);
  assert.equal(pendingFactCheck({ title: '회의 진행', entries: [entry(1000)] }).length, 0);
});

test('sources keep http(s) links only and fall back to the hostname as title', () => {
  assert.deepEqual(
    cleanSources([
      { title: '', url: 'https://www.moe.go.kr/x' },
      { title: 'bad', url: 'javascript:alert(1)' },
      { title: 'broken', url: 'http://' },
    ]),
    [{ title: 'www.moe.go.kr', url: 'https://www.moe.go.kr/x' }],
  );
});
