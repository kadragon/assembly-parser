import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiSubtitleUrl, parsePlayerUrl } from '../src/meeting.js';
import { mentions, Transcript, toLine, windowStart } from '../src/transcript.js';

const msg = (over) => ({
  transcript: '국정감사를 시작하겠습니다',
  transcripts: [[-1, '국정감사를 시작하겠습니다']],
  'send-timestamp': '2026-10-16T10:09:21.552474+09:00',
  'segment-offset': 415840,
  segment: 188,
  scd: false,
  final: true,
  ...over,
});

test('interim results are ignored', () => {
  assert.equal(toLine(msg({ final: false })), null);
});

test('speaker-split final replaces the earlier final and keeps its window', () => {
  const t = new Transcript();
  t.upsert(toLine(msg()));
  t.upsert(
    toLine(
      msg({
        scd: true,
        'send-timestamp': '2026-10-16T10:10:05+09:00',
        transcripts: [
          [0, '국정감사를'],
          [1, '- 시작하겠습니다'],
        ],
      }),
    ),
  );
  const lines = t.lines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, '국정감사를\n- 시작하겠습니다');
  assert.equal(lines[0].ts, Date.parse('2026-10-16T10:09:21.552474+09:00'));
});

test('same segment number after an STT restart is a different line', () => {
  const t = new Transcript();
  t.upsert(toLine(msg()));
  t.upsert(toLine(msg({ 'segment-offset': 1200, transcripts: [[-1, '다른 발언']] })));
  assert.equal(t.lines().length, 2);
});

test('windows align to KST wall-clock 10-minute boundaries', () => {
  const tenMin = 600_000;
  assert.equal(
    windowStart(Date.parse('2026-10-16T10:09:59+09:00'), tenMin),
    Date.parse('2026-10-16T10:00:00+09:00'),
  );
  assert.equal(
    windowStart(Date.parse('2026-10-16T10:10:00+09:00'), tenMin),
    Date.parse('2026-10-16T10:10:00+09:00'),
  );
});

test('player URL and subtitle endpoint resolution', () => {
  assert.deepEqual(
    parsePlayerUrl(
      'https://assembly.webcast.go.kr/main/player.asp?xcode=58&xcgcd=DCM00005822439A401&',
    ),
    { xcode: '58', xcgcd: 'DCM00005822439A401' },
  );
  assert.equal(
    aiSubtitleUrl('wss://smiai.webcast.go.kr:8091/aistt/gyoyuk'),
    'wss://smiai.webcast.go.kr:8091/aistt/gyoyuk/hls',
  );
  assert.throws(() => aiSubtitleUrl('https://smi.webcast.go.kr/x'), /stenographer/);
});

test('keyword match ignores STT spacing', () => {
  const lines = [{ text: '한국 교원 대학교 총장님께 묻겠습니다' }];
  assert.equal(mentions(lines, ['교원대학교']), true);
  assert.equal(mentions(lines, ['서울대']), false);
});

test('model output cleanup drops headings, <br> and code fences', async () => {
  const { clean } = await import('../src/summarizer.js');
  assert.equal(clean('<br>\n\n## 제목\n**한 줄 요약**: 내용\n```'), '**한 줄 요약**: 내용');
});

test('topic entries are replaced per window, never duplicated', async () => {
  const { nextTopicId, upsertEntry } = await import('../src/topics.js');
  const topic = { id: 't002', entries: [{ start: 2, notes: 'b' }] };
  upsertEntry(topic, { start: 1, notes: 'a' });
  upsertEntry(topic, { start: 2, notes: 'b2' });
  assert.deepEqual(
    topic.entries.map((e) => e.notes),
    ['a', 'b2'],
  );
  assert.equal(nextTopicId([{ id: 't002' }, { id: 't010' }]), 't011');
  assert.equal(nextTopicId([]), 't001');
});

test('preamble before the summary line is dropped', async () => {
  const { fromSummaryStart } = await import('../src/summarizer.js');
  assert.equal(
    fromSummaryStart('기존 요약이 없으므로…\n\n**핵심**: 충원율 하락'),
    '**핵심**: 충원율 하락',
  );
  assert.equal(fromSummaryStart('**한 줄 요약**: 핵심'), '**한 줄 요약**: 핵심');
});

test('member names drop titles; structured summary renders with who/where', async () => {
  const { memberName, summaryToText } = await import('../src/summarizer.js');
  assert.equal(memberName('김민전 위원님'), '김민전');
  assert.equal(memberName('정을호 의원'), '정을호');
  assert.equal(memberName('고민정'), '고민정');
  assert.equal(
    summaryToText({
      core: '충원율 하락',
      bullets: [
        { tag: '질의', member: '김민전', institution: '한국교원대', text: '하락 원인 질의' },
        { tag: '약속', member: '', institution: '', text: '대책 마련' },
      ],
    }),
    '**핵심**: 충원율 하락\n- [질의] (김민전 위원 · 한국교원대) 하락 원인 질의\n- [약속] 대책 마련',
  );
});
