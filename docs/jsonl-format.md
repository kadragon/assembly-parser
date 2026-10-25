# Transcript JSONL format (version 1)

Uploaded meetings and lectures use this file format, or [SRT and WebVTT](#srt-and-webvtt),
which are converted to the same cues. Each line is one JSON object
(UTF-8; a BOM, CRLF line endings, and blank lines are accepted).

## Header

The first record names the format and version:

```json
{"format":"assembly-parser.transcript","version":1}
```

Any other first record, or another version, rejects the file.

## Cues

Every following record is one caption cue:

| Field | Required | Meaning |
|---|---|---|
| `start` | yes | Integer milliseconds from the start of the recording, `>= 0` |
| `end` | no | Integer milliseconds, `>= start` |
| `text` | yes | Caption text, non-empty after trimming, at most 10,000 characters; may contain `\n` |
| `speaker` | no | Speaker label exactly as it should appear, at most 100 characters |
| `id` | no | Source cue identifier, unique in the file, at most 100 characters |

Other fields are rejected. Times are elapsed, never calendar dates; durations past
24 hours are fine and display as `25:10`.

## Example

A meeting with explicit speakers ([full file](../test/fixtures/general-meeting.jsonl)):

```json
{"format":"assembly-parser.transcript","version":1}
{"id":"c1","start":0,"end":4000,"speaker":"진행자","text":"주간 운영 회의를 시작하겠습니다."}
{"id":"c2","start":5000,"end":21000,"speaker":"김하늘","text":"지난주 고객 문의는 120건으로 전주보다 15% 늘었습니다."}
```

A lecture without speaker labels ([full file](../test/fixtures/general-lecture.jsonl)):

```json
{"format":"assembly-parser.transcript","version":1}
{"start":1000,"end":9000,"text":"오늘은 열역학 제1법칙을 다룹니다."}
{"start":9000,"end":20000,"text":"에너지는 생성되거나 소멸하지 않고 형태만 바뀝니다."}
```

## How cues are processed

- A cue belongs to the summary window containing its `start`; a cue crossing a window
  edge is not repeated in the next window.
- Overlapping cues and cues with equal start times keep their order in the file.
- A cue is traced back by its `id`, or by its line number when it has none.
- Speakers are passed to the model only when the file labels them; unlabeled text is
  never assigned a speaker.

## Errors

The upload is rejected as a whole, and no session is created, when any record is
invalid. The error lists up to 20 problems by line number, for example:

```
Invalid transcript file:
line 3: end is before start
line 7: text must be a non-empty string
```

Files over 5 MB, files without cues, duplicate `id` values, and session IDs other than
1–100 letters, digits, `-`, or `_` are rejected. An existing session ID is never
overwritten.

## SRT and WebVTT

The browser picks the parser from the file extension (`.srt`, `.vtt`, `.jsonl`); the
content must match it. Both are read as UTF-8 with an optional BOM and CRLF, CR, or LF
line endings, and each cue becomes one transcript cue with elapsed `start`/`end`.

- **SRT**: blocks of a cue number, `00:01:02,500 --> 00:01:05,000`, and one or more text
  lines. A `.` before the milliseconds and hours past 24 are accepted. The cue number is
  the cue's `id`; a block without one, or with a number already used (numbering often
  restarts in joined files), is traced by its line number. A blank line inside cue text
  does not end the cue.
  SRT has no speaker syntax, so its text is never labeled. Formatting tags such as `<i>`
  or `<font>` and `{\an8}` overrides are removed.
- **WebVTT**: the file must start with `WEBVTT`. Timestamps are `mm:ss.ttt` or
  `hh:mm:ss.ttt`; cue settings after the end time (`align:start`, `line:0`, …) are
  ignored, as are `NOTE`, `STYLE`, and `REGION` blocks. An optional cue identifier is
  the cue's `id` and must be unique. A cue may follow the `WEBVTT` line directly. Voice spans `<v Name>` (and `<v.class Name>`) set the
  speaker; a cue whose text changes voice is split into one cue per voice, traced as
  `id/1`, `id/2`, …. Other tags (`<b>`, `<c.class>`, karaoke timestamps) are removed and
  character references such as `&amp;` are decoded.

Cues with no text left after removing markup (spacer cues) are skipped; a file with
no usable cue is rejected. Caption markup is never rendered as HTML, speakers are never inferred from text such as
`김하늘: ...`, and positioning, styling, and regions are not preserved. Errors are reported
by file line as for JSONL: a malformed timestamp or `end` before `start` at the timing
line, a missing timing line, a duplicate WebVTT identifier (or a split `id/n` key that
another cue already uses), or a file in the other format:

```
Invalid subtitle file:
line 6: end is before start
line 14: invalid start time "00:00:61,000"
```

Fixtures: [SRT meeting](../test/fixtures/general-meeting.srt),
[WebVTT lecture](../test/fixtures/general-lecture.vtt).
