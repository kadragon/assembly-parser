// SRT and WebVTT uploads, normalized into the same lines as the JSONL contract
// (docs/jsonl-format.md). Only cue timing, plain text and explicit WebVTT voice labels are kept.
import { checkContent, MAX_ERRORS, MAX_TEXT, speakerError } from './importer.js';

const SRT_TIME = /^(\d+):([0-5]\d):([0-5]\d)[,.](\d{3})$/;
const VTT_TIME = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/;
const TIMING = /^\s*(\S+?)\s*-->\s*(\S+)/;
const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  lrm: '‎',
  rlm: '‏',
};
const SRT_EXAMPLE = '00:00:01,000 --> 00:00:04,000';
const VTT_EXAMPLE = '00:00:01.000 --> 00:00:04.000';
const isWebvtt = (line) => /^WEBVTT(?:[ \t]|$)/.test(line);

function time(text, pattern) {
  const m = pattern.exec(text);
  if (!m) return null;
  const ms = (Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 + Number(m[4]);
  return Number.isSafeInteger(ms) ? ms : null;
}

// Non-blank runs of lines, each with the 1-based file line where it starts.
function blocks(content) {
  const result = [];
  let block = null;
  const rows = content.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  for (const [i, raw] of rows.entries()) {
    if (!raw.trim()) block = null;
    else if (block) block.rows.push(raw);
    else {
      block = { row: i + 1, rows: [raw] };
      result.push(block);
    }
  }
  return result;
}

function collector() {
  const errors = [];
  return {
    fail(row, message) {
      if (errors.length < MAX_ERRORS) errors.push(`line ${row}: ${message}`);
    },
    finish(lines) {
      if (!lines.length && !errors.length) errors.push('file has no subtitle cues');
      if (errors.length) throw new Error(`Invalid subtitle file:\n${errors.join('\n')}`);
      return { lines, duration: lines.reduce((max, l) => Math.max(max, l.end), 0) };
    },
  };
}

function timing(line, row, pattern, fail) {
  const m = TIMING.exec(line);
  const start = time(m?.[1], pattern);
  const end = time(m?.[2], pattern);
  if (start === null) fail(row, `invalid start time ${JSON.stringify(m?.[1] ?? line)}`);
  else if (end === null) fail(row, `invalid end time ${JSON.stringify(m[2])}`);
  else if (end < start) fail(row, 'end is before start');
  else return { start, end };
  return null;
}

// Trimmed non-empty lines; text that was only markup or whitespace becomes ''.
const tidy = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');

const decode = (text) =>
  text.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi, (match, dec, hex, name) => {
    if (name) return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : match;
    const code = dec ? Number(dec) : Number.parseInt(hex, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });

/**
 * Split a WebVTT cue payload into { speaker?, text } parts by its <v> voice spans. Every other
 * tag (classes, styling, karaoke timestamps) is dropped, so markup never reaches the viewer.
 */
function voices(payload) {
  const parts = [];
  let speaker;
  let text = '';
  const flush = () => {
    const clean = tidy(decode(text));
    const last = parts.at(-1);
    if (clean && last && last.speaker === speaker) last.text += `\n${clean}`;
    else if (clean) parts.push({ speaker, text: clean });
    text = '';
  };
  for (const [token] of payload.matchAll(/<[^<>]*>|[^<]+|</g)) {
    if (token.length < 2 || !token.endsWith('>')) text += token;
    else if (/^<\/?v[\s.>]/.test(token)) {
      flush();
      const label = /^<v(?:\.[^\s>]*)?\s+([^>]*)>$/.exec(token)?.[1];
      speaker = label ? decode(label).trim() || undefined : undefined;
    }
  }
  flush();
  return parts;
}

function push(lines, fail, row, { key, source, start, end, parts }) {
  if (!parts.length) return fail(row, 'cue has no text');
  for (const part of parts) {
    if (part.text.length > MAX_TEXT) return fail(row, `text is longer than ${MAX_TEXT} characters`);
    if (part.speaker !== undefined && speakerError(part.speaker))
      return fail(row, speakerError(part.speaker));
  }
  parts.forEach((part, i) => {
    const line = {
      // a cue split by voice keeps its source key with the part number
      key: parts.length > 1 ? `${key}/${i + 1}` : key,
      ts: start,
      end,
      text: part.text,
      source,
    };
    if (part.speaker) line.speaker = part.speaker;
    lines.push(line);
  });
}

/** Parse a whole SRT upload into { lines, duration }; every problem is reported by line. */
export function parseSrt(content) {
  checkContent(content);
  const { fail, finish } = collector();
  const all = blocks(content);
  const first = all[0];
  if (first && isWebvtt(first.rows[0])) {
    fail(first.row, 'this looks like a WebVTT file; upload it with a .vtt extension');
    return finish([]);
  }
  if (first?.rows[0].trimStart().startsWith('{')) {
    fail(first.row, 'this looks like a JSONL transcript; upload it with a .jsonl extension');
    return finish([]);
  }
  const lines = [];
  const numbers = new Set();
  for (const { row, rows } of all) {
    const at = rows[0].includes('-->') ? 0 : 1;
    const number = at ? rows[0].trim() : undefined;
    if (at && (!/^\d+$/.test(number) || !rows[1]?.includes('-->'))) {
      fail(row, `expected a cue number and a timing line such as ${SRT_EXAMPLE}`);
      continue;
    }
    let valid = true;
    if (number !== undefined) {
      if (numbers.has(number)) {
        fail(row, `duplicate cue number ${number}`);
        valid = false;
      }
      numbers.add(number);
    }
    const times = timing(rows[at], row + at, SRT_TIME, fail);
    // SRT has no voice syntax: text stays unlabeled; drop HTML-like tags and {\an8} overrides
    const text = tidy(
      rows
        .slice(at + 1)
        .join('\n')
        .replace(/<\/?[A-Za-z][^<>]*>/g, '')
        .replace(/\{\\[^{}]*\}/g, ''),
    );
    if (!times || !valid) continue;
    push(lines, fail, row + at, {
      key: number !== undefined ? `id:${number}` : `#${row}`,
      source: number ?? row,
      ...times,
      parts: text ? [{ text }] : [],
    });
  }
  return finish(lines);
}

/** Parse a whole WebVTT upload into { lines, duration }; every problem is reported by line. */
export function parseVtt(content) {
  checkContent(content);
  const { fail, finish } = collector();
  const [header, ...rest] = blocks(content);
  if (header?.row !== 1 || !isWebvtt(header.rows[0])) {
    const srt = header?.rows.some((l) => SRT_TIME.test(TIMING.exec(l)?.[1] ?? ''));
    fail(
      1,
      `WebVTT files must start with "WEBVTT"${srt ? '; this looks like an SRT file, upload it with a .srt extension' : ''}`,
    );
    return finish([]);
  }
  const lines = [];
  const ids = new Set();
  for (const { row, rows } of rest) {
    if (/^(?:NOTE|STYLE|REGION)(?:[ \t]|$)/.test(rows[0])) continue;
    const at = rows[0].includes('-->') ? 0 : 1;
    if (at && !rows[1]?.includes('-->')) {
      fail(row, `expected a timing line such as ${VTT_EXAMPLE}`);
      continue;
    }
    const id = at ? rows[0].trim() : undefined;
    let valid = true;
    if (id !== undefined) {
      if (ids.has(id)) fail(row, `duplicate cue identifier ${JSON.stringify(id)}`);
      else if (id.length > 100) fail(row, 'cue identifier is longer than 100 characters');
      valid = !ids.has(id) && id.length <= 100;
      ids.add(id);
    }
    const times = timing(rows[at], row + at, VTT_TIME, fail);
    const parts = voices(rows.slice(at + 1).join('\n'));
    if (!times) continue;
    if (!valid) {
      // still report label problems in a cue that is already rejected
      for (const p of parts)
        if (p.speaker !== undefined && speakerError(p.speaker))
          fail(row + at, speakerError(p.speaker));
      continue;
    }
    push(lines, fail, row + at, {
      key: id !== undefined ? `id:${id}` : `#${row}`,
      source: id ?? row,
      ...times,
      parts,
    });
  }
  return finish(lines);
}
