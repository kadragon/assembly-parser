import fs from 'node:fs';
import path from 'node:path';
import { parsePlayerUrl } from './meeting.js';
import { Transcript } from './transcript.js';

/**
 * On-disk layout shared by the three processes (data/<xcgcd>/):
 *   meeting.json      written by collect
 *   transcript.jsonl  appended by collect (raw finals; readers de-duplicate)
 *   state.json        written by summarize, read by serve
 */
export function meetingDir(arg, root = 'data') {
  const xcgcd = /^https?:/.test(arg) ? parsePlayerUrl(arg).xcgcd : arg;
  if (typeof xcgcd !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(xcgcd))
    throw new Error('Invalid session identifier');
  const dir = path.resolve(root, xcgcd);
  if (fs.existsSync(dir) && (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory()))
    throw new Error('Session must be a real directory');
  return dir;
}

export const files = (dir) => ({
  meeting: path.join(dir, 'meeting.json'),
  transcript: path.join(dir, 'transcript.jsonl'),
  state: path.join(dir, 'state.json'),
});

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// write-then-rename so a concurrent reader never sees a half-written file
export function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function readTranscript(file) {
  const t = new Transcript();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return t;
    throw err;
  }
  for (const row of text.split('\n')) {
    if (!row) continue;
    try {
      t.upsert(JSON.parse(row));
    } catch {
      // the collector may be mid-append on the last row
    }
  }
  return t;
}
