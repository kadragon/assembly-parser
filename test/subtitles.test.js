import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { MAX_UPLOAD_BYTES, parseTranscript } from '../src/importer.js';
import { closedWindows, Transcript } from '../src/transcript.js';

const fixture = (name) => fs.readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
const pick = (lines) =>
  lines.map(({ key, ts, end, speaker, text }) => [key, ts, end, speaker, text]);

test('an SRT meeting with BOM-free CRLF input, multiline cues and markup parses by cue number', () => {
  const { lines, duration } = parseTranscript(fixture('general-meeting.srt'), 'srt');
  assert.deepEqual(pick(lines), [
    ['id:1', 0, 4000, undefined, '주간 운영 회의를 시작하겠습니다.'],
    ['id:2', 5000, 21000, undefined, '지난주 고객 문의는 120건으로\n전주보다 15% 늘었습니다.'],
    ['id:3', 15000, 18000, undefined, '(웃음)'],
    ['id:4', 310000, 330000, undefined, '신규 결제 시스템 전환은 11월 둘째 주로 확정했습니다.'],
    ['id:5', 598000, 604500, undefined, '다음 회의는 목요일입니다. 이상으로 마치겠습니다.'],
  ]);
  assert.equal(lines[0].source, '1');
  assert.equal(duration, 604500);
});

test('a WebVTT lecture keeps voice labels and ignores NOTE, STYLE, REGION and cue settings', () => {
  const { lines, duration } = parseTranscript(fixture('general-lecture.vtt'), 'vtt');
  assert.deepEqual(pick(lines), [
    ['id:intro', 1000, 9000, '강사', '오늘은 열역학 제1법칙을 다룹니다.'],
    // a cue whose text changes voice is split so each part keeps only its own label
    ['#17/1', 9000, 20000, '강사', '에너지는 생성되거나 소멸하지 않고'],
    ['#17/2', 9000, 20000, undefined, '형태만 바뀝니다 & 보존됩니다.'],
    ['id:q1/1', 15000, 18000, '질문자', '열과 일은 같은 단위인가요?'],
    ['id:q1/2', 15000, 18000, '강사', '네, 둘 다 줄입니다.'],
    ['#26', 295000, 305000, undefined, '이 문장은 첫 구간 끝에서 시작해 다음 구간으로 넘어갑니다.'],
    [
      '#29',
      306000,
      320000,
      undefined,
      '닫힌계에서 내부 에너지 변화는 받은 열에서 한 일을 뺀 값입니다.',
    ],
    ['#32', 599000, 602000, '강사', '다음 시간에는 제2법칙을 봅니다.'],
  ]);
  assert.equal(lines[0].source, 'intro');
  assert.equal(lines[1].source, 17);
  assert.equal(duration, 602000);
});

test('overlapping subtitle cues keep file order and the final edge-crossing cue is not repeated', () => {
  const { lines } = parseTranscript(fixture('general-lecture.vtt'), 'vtt');
  const transcript = new Transcript();
  for (const line of lines) transcript.upsert(line);
  assert.deepEqual(
    transcript.between(0, 300_000).map((l) => l.key),
    ['id:intro', '#17/1', '#17/2', 'id:q1/1', 'id:q1/2', '#26'],
  );
  assert.deepEqual(
    transcript.between(300_000, 600_000).map((l) => l.key),
    ['#29', '#32'],
  );
  assert.deepEqual(closedWindows(transcript.lines(), 300_000, Infinity, 30_000), [0, 300_000]);
});

test('caption markup becomes plain text and speakers are never inferred', () => {
  const srt = parseTranscript(
    '1\n00:00:00,000 --> 00:00:01,000\n<font color="red">빨강</font> {\\an8}위 a < b\n\n' +
      '2\n00:00:01,000 --> 00:00:02,000\n김하늘: 안녕하세요\n',
    'srt',
  );
  assert.deepEqual(
    srt.lines.map((l) => [l.text, l.speaker]),
    [
      ['빨강 위 a < b', undefined],
      ['김하늘: 안녕하세요', undefined],
    ],
  );
  const vtt = parseTranscript(
    'WEBVTT\r\n\r\n00:00.000 --> 00:01.000\r\n<script>alert(1)</script> &lt;b&gt; <00:00.500><i>끝</i>\r\n',
    'vtt',
  );
  assert.equal(vtt.lines[0].text, 'alert(1) <b> 끝');
  assert.equal(vtt.lines[0].speaker, undefined);
});

test('WebVTT hours past 24 do not wrap', () => {
  const { lines } = parseTranscript('WEBVTT\n\n25:00:00.000 --> 25:00:01.000\n늦은 시간\n', 'vtt');
  assert.equal(lines[0].ts, 25 * 3600_000);
});

test('malformed SRT cues are reported by line and nothing is accepted', () => {
  const content = [
    '1',
    '00:00:01,000 --> 00:00:0x,000',
    '가',
    '',
    '2',
    '00:00:05,000 --> 00:00:03,000',
    '나',
    '',
    '3',
    '00:00:06,000 --> 00:00:07,000',
    '<i></i>',
    '',
    '4',
    '00:00:61,000 --> 00:01:02,000',
    '라',
    '',
    'x1',
    '00:00:08,000 --> 00:00:09,000',
    '마',
  ].join('\n');
  assert.throws(
    () => parseTranscript(content, 'srt'),
    (error) => {
      assert.match(error.message, /^Invalid subtitle file:/);
      assert.match(error.message, /line 2: invalid end time "00:00:0x,000"/);
      assert.match(error.message, /line 6: end is before start/);
      assert.doesNotMatch(error.message, /line 10/);
      assert.match(error.message, /line 14: invalid start time "00:00:61,000"/);
      assert.match(error.message, /line 17: expected a cue number and a timing line/);
      return true;
    },
  );
  assert.throws(
    () => parseTranscript('stray\n\n1\n00:00:00,000 --> 00:00:01,000\n가\n', 'srt'),
    /line 1: expected a cue number/,
  );
});

test('real-world SRT quirks: empty cues, blank lines in text and restarted numbering', () => {
  const { lines } = parseTranscript(
    [
      '1',
      '00:00:01,000 --> 00:00:03,000',
      '첫 줄',
      '',
      '둘째 줄',
      '',
      '2',
      '00:00:03,000 --> 00:00:03,010',
      ' ',
      '',
      '1',
      '00:00:04,000 --> 00:00:05,000',
      '<i></i>',
      '',
      '1',
      '00:00:06,000 --> 00:00:07,000',
      '이어 붙인 파일',
    ].join('\n'),
    'srt',
  );
  assert.deepEqual(
    lines.map((l) => [l.key, l.text]),
    [
      ['id:1', '첫 줄\n둘째 줄'],
      ['#15', '이어 붙인 파일'],
    ],
  );
  assert.throws(
    () => parseTranscript('1\n00:00:00,000 --> 00:00:01,000\n<b></b>\n', 'srt'),
    /no subtitle cues/,
  );
});

test('WebVTT quirks: a cue right after the header, empty cues, text ending in ">" and split-key collisions', () => {
  const { lines } = parseTranscript(
    'WEBVTT\n00:00.000 --> 00:05.000\n안녕하세요\n\n00:05.000 --> 00:05.010 align:start\n \n\n00:06.000 --> 00:07.000\n방향 >\n',
    'vtt',
  );
  assert.deepEqual(
    lines.map((l) => [l.key, l.text]),
    [
      ['#2', '안녕하세요'],
      ['#8', '방향 >'],
    ],
  );
  assert.throws(
    () =>
      parseTranscript(
        'WEBVTT\n\na\n00:00.000 --> 00:01.000\n<v A>가</v><v B>나</v>\n\na/1\n00:02.000 --> 00:03.000\n다\n',
        'vtt',
      ),
    /line 8: cue key "id:a\/1" is used by another cue/,
  );
});

test('JSONL text containing an arrow is not mistaken for SRT', () => {
  const { lines } = parseTranscript(
    '{"format":"assembly-parser.transcript","version":1}\n{"start":0,"text":"A --> B 순서로 진행"}',
  );
  assert.equal(lines[0].text, 'A --> B 순서로 진행');
});

test('malformed WebVTT cues and voice labels are reported by line', () => {
  const content = [
    'WEBVTT',
    '',
    'a',
    '00:01.000 --> 00:00.500',
    '역전',
    '',
    'a',
    '00:02.000 --> 00:03.000',
    '<v [진행]>중복',
    '',
    '00:03,000 --> 00:04.000',
    '쉼표',
    '',
    'no timing here',
  ].join('\n');
  assert.throws(
    () => parseTranscript(content, 'vtt'),
    (error) => {
      assert.match(error.message, /line 4: end is before start/);
      assert.match(error.message, /line 7: duplicate cue identifier "a"/);
      assert.match(error.message, /line 8: speaker must not contain/);
      assert.match(error.message, /line 11: invalid start time "00:03,000"/);
      assert.match(error.message, /line 14: expected a timing line/);
      return true;
    },
  );
});

test('a file in the wrong format or without cues explains what to upload', () => {
  const vtt = fixture('general-lecture.vtt');
  const srt = fixture('general-meeting.srt');
  assert.throws(() => parseTranscript(vtt, 'srt'), /line 1: this looks like a WebVTT file/);
  assert.throws(() => parseTranscript(srt, 'vtt'), /line 1: WebVTT files must start with "WEBVTT"/);
  assert.throws(
    () => parseTranscript(fixture('general-meeting.jsonl'), 'srt'),
    /line 1: this looks like a JSONL transcript/,
  );
  assert.throws(() => parseTranscript(srt, 'jsonl'), /line 1: this looks like an SRT file/);
  assert.throws(() => parseTranscript(vtt, 'jsonl'), /line 1: this looks like a WebVTT file/);
  assert.throws(() => parseTranscript(srt, 'docx'), /Unsupported file format/);
  assert.throws(() => parseTranscript('', 'srt'), /file has no subtitle cues/);
  assert.throws(() => parseTranscript('\uFEFF\r\n', 'srt'), /file has no subtitle cues/);
  assert.throws(() => parseTranscript('WEBVTT\n\nNOTE only a note\n', 'vtt'), /no subtitle cues/);
  assert.throws(
    () => parseTranscript(`WEBVTT\n\n${'x'.repeat(MAX_UPLOAD_BYTES)}`, 'vtt'),
    /larger than 5 MB/,
  );
});
