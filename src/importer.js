// Uploaded transcript files, normalized into the line shape the summarizer already reads.
// The contract is documented in docs/jsonl-format.md.
import { parseSrt, parseVtt } from './subtitles.js';

export const FORMAT = 'assembly-parser.transcript';
export const FORMAT_VERSION = 1;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT = 10_000;
const MAX_LABEL = 100;
export const MAX_ERRORS = 20;
const CUE_FIELDS = ['start', 'end', 'text', 'speaker', 'id'];

const isTime = (value) => Number.isSafeInteger(value) && value >= 0;

// the speaker is written into the model input as "[name] text" and must stay one label
export function speakerError(speaker) {
  if (speaker.length > MAX_LABEL) return `speaker must be at most ${MAX_LABEL} characters`;
  if ([...speaker].some((c) => c < ' ' || '[]\x7f'.includes(c)))
    return 'speaker must not contain line breaks, control characters or brackets';
  return null;
}

export function checkContent(content) {
  if (typeof content !== 'string') throw new Error('Transcript file must be text');
  if (Buffer.byteLength(content) > MAX_UPLOAD_BYTES)
    throw new Error(`Transcript file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
}

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

function headerError(record) {
  if (!isObject(record) || record.format !== FORMAT)
    return `first record must be the header {"format":"${FORMAT}","version":1}`;
  if (record.version !== FORMAT_VERSION)
    return `unsupported version ${JSON.stringify(record.version)}`;
  return null;
}

function cueError(record, ids) {
  if (!isObject(record)) return 'expected a JSON object';
  const unknown = Object.keys(record).filter((k) => !CUE_FIELDS.includes(k));
  if (unknown.length) return `unknown field ${unknown.join(', ')}`;
  if (!isTime(record.start)) return 'start must be a non-negative integer of milliseconds';
  if (record.end !== undefined) {
    if (!isTime(record.end)) return 'end must be a non-negative integer of milliseconds';
    if (record.end < record.start) return 'end is before start';
  }
  if (typeof record.text !== 'string' || !record.text.trim())
    return 'text must be a non-empty string';
  if (record.text.length > MAX_TEXT) return `text is longer than ${MAX_TEXT} characters`;
  for (const field of ['speaker', 'id'])
    if (
      record[field] !== undefined &&
      (typeof record[field] !== 'string' || record[field].length > MAX_LABEL)
    )
      return `${field} must be a string of at most ${MAX_LABEL} characters`;
  if (record.speaker !== undefined && speakerError(record.speaker))
    return speakerError(record.speaker);
  if (record.id !== undefined) {
    if (ids.has(record.id)) return `duplicate id ${JSON.stringify(record.id)}`;
    ids.add(record.id);
  }
  return null;
}

function toLine(record, row) {
  const line = {
    // the source id, or the file position, so every summary traces back to its cue
    key: record.id !== undefined ? `id:${record.id}` : `#${row}`,
    ts: record.start,
    text: record.text.trim(),
    source: record.id ?? row,
  };
  if (record.end !== undefined) line.end = record.end;
  const speaker = record.speaker?.trim();
  if (speaker) line.speaker = speaker;
  return line;
}

/**
 * Parse a whole JSONL upload. Returns { lines, duration } where each line is
 * { key, ts, end?, text, speaker?, source } with ts/end in elapsed milliseconds.
 * Throws one error listing every problem by line number; nothing is partially accepted.
 */
export function parseJsonl(content) {
  checkContent(content);
  const errors = [];
  const fail = (row, message) => {
    if (errors.length < MAX_ERRORS) errors.push(`line ${row}: ${message}`);
  };
  const rows = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  const lines = [];
  const ids = new Set();
  let header = false;
  // an SRT cue number such as "1" is valid JSON: name the real format instead of every line
  const first = rows.findIndex((r) => r.trim());
  const subtitle = /^WEBVTT(?:[ \t]|$)/.test(rows[first])
    ? 'a WebVTT file; upload it with a .vtt'
    : rows
        .slice(first, first + 2)
        .some((r) => r.includes('-->') && !r.trimStart().startsWith('{')) &&
      'an SRT file; upload it with a .srt';
  if (first >= 0 && subtitle)
    throw new Error(
      `Invalid transcript file:\nline ${first + 1}: this looks like ${subtitle} extension`,
    );
  for (const [i, raw] of rows.entries()) {
    if (!raw.trim()) continue;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      fail(i + 1, 'not valid JSON');
      continue;
    }
    const cue = header;
    header = true;
    const problem = cue ? cueError(record, ids) : headerError(record);
    if (problem) fail(i + 1, problem);
    else if (cue) lines.push(toLine(record, i + 1));
  }
  if (!header) errors.push('file is empty');
  else if (!lines.length && !errors.length) errors.push('file has no transcript records');
  if (errors.length) throw new Error(`Invalid transcript file:\n${errors.join('\n')}`);
  // a loop, not Math.max(...lines): a large file has more cues than a call may take arguments
  const duration = lines.reduce((max, l) => Math.max(max, l.end ?? l.ts), 0);
  return { lines, duration };
}

const PARSERS = { jsonl: parseJsonl, srt: parseSrt, vtt: parseVtt };

/** Parse an upload in one of the supported formats: jsonl (default), srt or vtt. */
export function parseTranscript(content, format = 'jsonl') {
  if (!Object.hasOwn(PARSERS, format)) throw new Error(`Unsupported file format ${format}`);
  return PARSERS[format](content);
}
