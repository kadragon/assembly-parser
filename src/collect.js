#!/usr/bin/env node
// Long-running subtitle collector. Keep this process alive for the whole meeting;
// summarize.js and serve.js can be restarted freely without losing subtitles.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { collect } from './collector.js';
import { aiSubtitleUrl, fetchMeeting, parsePlayerUrl } from './meeting.js';
import { workerLock } from './ownership.js';
import { files, meetingDir, readJson, writeJson } from './store.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { data: { type: 'string', default: 'data' } },
});
if (!positionals[0]) {
  console.error('usage: node src/collect.js <player.asp URL> [--data data]');
  process.exit(1);
}

const ids = parsePlayerUrl(positionals[0]);
const meeting =
  process.connected && process.env.ASSEMBLY_OWNER_PID === String(process.ppid)
    ? readJson(files(meetingDir(ids.xcgcd, values.data)).meeting)
    : await fetchMeeting(ids);
if (!meeting.live) console.warn('warning: meeting is not live; subtitles may not arrive');
const wsUrl = aiSubtitleUrl(meeting.smiServer);

const dir = meetingDir(meeting.xcgcd, values.data);
fs.mkdirSync(dir, { recursive: true });
const release = workerLock(dir, 'collector');
process.on('exit', release);
const f = files(dir);
writeJson(f.meeting, meeting);

let count = 0;
const stop = collect(wsUrl, {
  onLine(line) {
    fs.appendFileSync(f.transcript, `${JSON.stringify(line)}\n`);
    if (++count % 50 === 0) console.log(`${count} lines collected`);
  },
});
console.log(`${meeting.committee} — ${meeting.subject}`);
console.log(`collecting into ${f.transcript}`);

const shutdown = () => {
  stop();
  release();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('disconnect', shutdown);
