import fs from 'node:fs';
import { alive } from './ownership.js';
import { isElapsed, neutralTopic, profileOf } from './profile.js';
import { fingerprint, rebuildPending, staleReasons } from './rebuild.js';
import { files, readJson, readTranscript } from './store.js';
import { loadTopics } from './topics.js';
import { windowStart } from './transcript.js';

export function snapshot(dir) {
  const f = files(dir);
  const meeting = readJson(f.meeting, {});
  const saved = readJson(f.state);
  const state = saved ?? { windowMinutes: 5, windows: {} };
  const windowMs = state.windowMinutes * 60_000;
  // an uploaded file has no live window: its times are elapsed, not wall-clock
  const complete = meeting.complete === true;
  const current = complete ? 0 : windowStart(Date.now(), windowMs);
  const windows = Object.values(state.windows);
  const routed = windows.filter((w) => w.routed).map((w) => w.end);
  const transcript = readTranscript(f.transcript);
  let lastLineAt = null; // collect.js only appends, so mtime is when the last caption arrived
  try {
    lastLineAt = fs.statSync(f.transcript).mtimeMs;
  } catch {}
  return {
    lastLineAt,
    profile: profileOf(meeting),
    timeBasis: isElapsed(meeting) ? 'elapsed' : 'absolute',
    complete,
    duration: meeting.duration ?? null,
    meeting: {
      committee: meeting.committee ?? '',
      subject: meeting.subject ?? '수집 대기 중',
      date: meeting.date ?? '',
    },
    windowMinutes: state.windowMinutes,
    categories: state.categories ?? [],
    // explicit categories name their fallback; the focus shorthand's is its last one
    fallback:
      state.settings?.categories?.find((c) => c.fallback)?.name ?? state.categories?.at(-1) ?? null,
    // topics are current through the last window that went through routing
    topicsUntil: routed.length ? Math.max(...routed) : null,
    // legacy Assembly fields are adapted on read; files on disk are never rewritten
    topics: loadTopics(dir).map(neutralTopic),
    running: state.running?.pid && alive(state.running.pid) ? state.running.jobs : [],
    windows: windows.sort((a, b) => b.start - a.start),
    // read-only check against the output's own settings; requested-setting changes are the
    // control server's to report
    rebuild: {
      pending: rebuildPending(dir) || Boolean(state.rebuilding),
      required: staleReasons(dir, saved, state.settings, transcript),
      rebuiltFrom: state.rebuiltFrom ?? null,
    },
    current: complete
      ? { start: 0, end: 0, lines: [] }
      : {
          start: current,
          end: current + windowMs,
          lines: transcript.between(current, current + windowMs),
        },
  };
}

/**
 * Source captions behind one summarized window, read-only: one line per segment with its latest
 * final, in time order. `stale` means the captions changed after the window was summarized.
 * Live sessions carry wall-clock time and uploads carry elapsed time; neither is a seek position.
 */
export function windowLines(dir, start) {
  const f = files(dir);
  const w = Number.isSafeInteger(start) ? readJson(f.state)?.windows?.[start] : undefined;
  if (!w || w.start !== start) throw new Error('Unknown summary window');
  const lines = readTranscript(f.transcript).between(w.start, w.end);
  return {
    start: w.start,
    end: w.end,
    timeBasis: isElapsed(readJson(f.meeting, {})) ? 'elapsed' : 'absolute',
    stale: Boolean(w.fingerprint) && w.fingerprint !== fingerprint(lines),
    lines,
  };
}
