// Uploaded transcript files, normalized into the line shape the summarizer already reads.
// The contract is documented in docs/jsonl-format.md.
export const FORMAT = 'assembly-parser.transcript';
export const FORMAT_VERSION = 1;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_TEXT = 10_000;
const MAX_LABEL = 100;
const MAX_ERRORS = 20;
const CUE_FIELDS = ['start', 'end', 'text', 'speaker', 'id'];

const isTime = (value) => Number.isSafeInteger(value) && value >= 0;

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
  if (typeof content !== 'string') throw new Error('Transcript file must be text');
  if (Buffer.byteLength(content) > MAX_UPLOAD_BYTES)
    throw new Error(`Transcript file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  const errors = [];
  const fail = (row, message) => {
    if (errors.length < MAX_ERRORS) errors.push(`line ${row}: ${message}`);
  };
  const rows = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  const lines = [];
  const ids = new Set();
  let header = false;
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
  return { lines, duration: Math.max(...lines.map((l) => l.end ?? l.ts)) };
}
