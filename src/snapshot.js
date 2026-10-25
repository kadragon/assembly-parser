import fs from 'node:fs';
import { alive } from './ownership.js';
import { rebuildPending, staleReasons } from './rebuild.js';
import { files, readJson, readTranscript } from './store.js';
import { loadTopics } from './topics.js';
import { windowStart } from './transcript.js';

export function snapshot(dir) {
  const f = files(dir);
  const meeting = readJson(f.meeting, {});
  const saved = readJson(f.state);
  const state = saved ?? { windowMinutes: 5, windows: {} };
  const windowMs = state.windowMinutes * 60_000;
  const current = windowStart(Date.now(), windowMs);
  const windows = Object.values(state.windows);
  const routed = windows.filter((w) => w.routed).map((w) => w.end);
  const transcript = readTranscript(f.transcript);
  let lastLineAt = null; // collect.js only appends, so mtime is when the last caption arrived
  try {
    lastLineAt = fs.statSync(f.transcript).mtimeMs;
  } catch {}
  return {
    lastLineAt,
    meeting: {
      committee: meeting.committee ?? '',
      subject: meeting.subject ?? '수집 대기 중',
      date: meeting.date ?? '',
    },
    windowMinutes: state.windowMinutes,
    categories: state.categories ?? [],
    // topics are current through the last window that went through routing
    topicsUntil: routed.length ? Math.max(...routed) : null,
    topics: loadTopics(dir),
    running: state.running?.pid && alive(state.running.pid) ? state.running.jobs : [],
    windows: windows.sort((a, b) => b.start - a.start),
    // read-only check against the output's own settings; requested-setting changes are the
    // control server's to report
    rebuild: {
      pending: rebuildPending(dir) || Boolean(state.rebuilding),
      required: staleReasons(dir, saved, state.settings, transcript),
      rebuiltFrom: state.rebuiltFrom ?? null,
    },
    current: {
      start: current,
      end: current + windowMs,
      lines: transcript.between(current, current + windowMs),
    },
  };
}
