import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { MAX_UPLOAD_BYTES, parseJsonl } from '../src/importer.js';
import { formatElapsed } from '../src/profile.js';
import { closedWindows, Transcript, windowStart } from '../src/transcript.js';

const fixture = (name) => fs.readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
const HEADER = '{"format":"assembly-parser.transcript","version":1}';
const file = (...cues) => [HEADER, ...cues.map((c) => JSON.stringify(c))].join('\n');

test('the documented meeting and lecture examples parse with traceable keys', () => {
  const meeting = parseJsonl(fixture('general-meeting.jsonl'));
  assert.equal(meeting.lines.length, 6);
  assert.deepEqual(meeting.lines[1], {
    key: 'id:c2',
    ts: 5000,
    end: 21000,
    text: '지난주 고객 문의는 120건으로 전주보다 15% 늘었습니다.',
    source: 'c2',
    speaker: '김하늘',
  });
  assert.equal(meeting.duration, 625000);
  const lecture = parseJsonl(fixture('general-lecture.jsonl'));
  // no ids: the file line number identifies the cue; no speakers are invented
  assert.equal(lecture.lines[0].key, '#2');
  assert.equal(lecture.lines[0].source, 2);
  assert.ok(lecture.lines.every((l) => !('speaker' in l)));
});

test('BOM, CRLF and blank lines are accepted', () => {
  const parsed = parseJsonl(`﻿${HEADER}\r\n\r\n{"start":0,"text":"가"}\r\n`);
  assert.deepEqual(
    parsed.lines.map((l) => l.text),
    ['가'],
  );
});

test('every problem is reported by line and nothing is accepted', () => {
  const content = [
    HEADER,
    '{"start":-1,"text":"음수"}',
    '{"start":5,"end":4,"text":"역전"}',
    '{"start":1.5,"text":"소수"}',
    '{"start":0,"text":"   "}',
    'not json',
    '{"start":0,"text":"a","when":"x"}',
    '{"start":0,"text":"a","id":"x"}',
    '{"start":0,"text":"b","id":"x"}',
    '[]',
    '{"start":0,"text":"a","speaker":3}',
  ].join('\n');
  assert.throws(
    () => parseJsonl(content),
    (error) => {
      assert.match(error.message, /line 2: start must be a non-negative integer/);
      assert.match(error.message, /line 3: end is before start/);
      assert.match(error.message, /line 4: start must be/);
      assert.match(error.message, /line 5: text must be a non-empty string/);
      assert.match(error.message, /line 6: not valid JSON/);
      assert.match(error.message, /line 7: unknown field when/);
      assert.match(error.message, /line 9: duplicate id "x"/);
      assert.match(error.message, /line 10: expected a JSON object/);
      assert.match(error.message, /line 11: speaker must be a string/);
      return true;
    },
  );
});

test('missing or unsupported headers and empty files are rejected', () => {
  assert.throws(() => parseJsonl(''), /file is empty/);
  assert.throws(() => parseJsonl(HEADER), /no transcript records/);
  assert.throws(() => parseJsonl('{"start":0,"text":"a"}'), /line 1: first record must be/);
  assert.throws(
    () => parseJsonl('{"format":"assembly-parser.transcript","version":2}\n{"start":0,"text":"a"}'),
    /line 1: unsupported version 2/,
  );
});

test('uploads above the size limit are rejected before parsing', () => {
  const big = `${HEADER}\n${'x'.repeat(MAX_UPLOAD_BYTES)}`;
  assert.throws(() => parseJsonl(big), /larger than 5 MB/);
});

test('elapsed time past 24 hours does not wrap', () => {
  const day = 24 * 3600_000;
  assert.equal(formatElapsed(0), '00:00');
  assert.equal(formatElapsed(5 * 60_000 + 59_999), '00:05');
  assert.equal(formatElapsed(day + 35 * 60_000), '24:35');
  assert.equal(formatElapsed(3 * day), '72:00');
  const { lines } = parseJsonl(file({ start: day + 1000, text: '늦은 시간' }));
  assert.equal(windowStart(lines[0].ts, 300_000), day);
});

test('overlapping cues keep file order and a boundary-crossing cue lands only in its start window', () => {
  const { lines } = parseJsonl(fixture('general-lecture.jsonl'));
  const transcript = new Transcript();
  for (const line of lines) transcript.upsert(line);
  assert.deepEqual(
    transcript.between(0, 300_000).map((l) => l.key),
    ['#2', '#3', '#4', '#5'],
  );
  // #5 starts at 4:55 and ends at 5:05: it belongs to the first window only
  assert.deepEqual(
    transcript.between(300_000, 600_000).map((l) => l.key),
    ['#6'],
  );
  // a completed file closes every populated window, including the last partial one
  assert.deepEqual(closedWindows(transcript.lines(), 300_000, Infinity, 30_000), [0, 300_000]);
});

test('cues with equal start times keep their file order', () => {
  const { lines } = parseJsonl(
    file({ start: 10, text: '첫째' }, { start: 10, text: '둘째' }, { start: 0, text: '앞' }),
  );
  const transcript = new Transcript();
  for (const line of lines) transcript.upsert(line);
  assert.deepEqual(
    transcript.lines().map((l) => l.text),
    ['앞', '첫째', '둘째'],
  );
});

test('a large valid file under the size limit is not rejected by its cue count', () => {
  const cue = '{"start":0,"text":"a"}';
  const { lines, duration } = parseJsonl([HEADER, ...Array(150_000).fill(cue)].join('\n'));
  assert.equal(lines.length, 150_000);
  assert.equal(duration, 0);
});

test('speaker labels cannot break the one-label-per-line model input', () => {
  for (const speaker of ['김하늘\n발표자', '[김하늘]', 'a\tb'])
    assert.throws(
      () => parseJsonl(file({ start: 0, speaker, text: '가' })),
      /line 2: speaker must not contain/,
    );
});
