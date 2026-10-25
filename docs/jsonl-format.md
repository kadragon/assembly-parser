# Transcript JSONL format (version 1)

Uploaded meetings and lectures use this file format. Each line is one JSON object
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
