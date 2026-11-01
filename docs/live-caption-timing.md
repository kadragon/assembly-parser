# Live caption timing

Live summaries close a window 30 seconds after it ends (`graceMs` in `src/summarize.js`).
A caption whose words change, or a first caption that lands in a window after it was
summarized, makes the output stale (`staleReasons` in `src/rebuild.js`), and live summaries
pause until an explicit rebuild. This note records how late finals actually arrive.

## Evidence (2026-10-16 recording)

Measured from one recorded live session: 교육위원회 국정감사, 2026-10-16,
01:17–09:50 UTC, 6,056 final records for 3,029 segments.
No broadcast was live when this was checked (2026-11-01), so no new connection was made.

- The STT server re-sends a final with the same `send-timestamp` as the first one, so a
  record's timestamp says nothing about when a correction arrived. File order does: records
  are appended as they arrive.
- All 162 re-sent finals whose words changed arrived at most 2 records after the first final.
  When each arrived, the newest caption already in the file was at most 1.24 s ahead of
  the corrected segment.
- The largest out-of-order arrival (a timestamp behind one already written) was 1.24 s.
- Replaying the summarizer's close rule over the file produced 0 stale events for
  1- and 5-minute windows at every grace from 0 to 300 s. The same replay reports 1 stale
  event when a single late correction is appended to the file.

The 30 s grace is therefore well above every lateness this recording can bound.

## Residual risk

- Arrival time is not recorded. Two of the 162 corrections were followed by more than 30 s of
  silence, so their arrival is bounded only by the next segment; a correction sent late into a
  pause would still pause summaries.
- One session from one committee channel is the whole sample.

A stale event is recoverable: collection keeps running, and the browser's rebuild archives the
old output before reprocessing. If late corrections show up in practice, record arrival time in
`src/collect.js` before tuning the grace.

## Reproduce

Save the script below as `lateness.mjs` outside the repository and run
`node lateness.mjs data/<session>/transcript.jsonl`.

```js
import fs from 'node:fs';

const recs = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
const words = (t) => t.replace(/^-/gm, '').replace(/\s+/g, '');
const first = new Map();
const last = new Map();
let maxSeen = -Infinity;
let skew = 0;
const refinals = [];
recs.forEach((r, i) => {
  skew = Math.max(skew, maxSeen - r.ts);
  if (!first.has(r.key)) {
    first.set(r.key, { ts: r.ts, i });
  } else if (words(r.text) !== last.get(r.key)) {
    let j = i + 1;
    while (j < recs.length && recs[j].key === r.key) j++;
    refinals.push({
      own: r.ts - first.get(r.key).ts,
      behind: maxSeen - first.get(r.key).ts,
      records: i - first.get(r.key).i,
      next: j < recs.length ? recs[j].ts - first.get(r.key).ts : Infinity,
    });
  }
  last.set(r.key, words(r.text));
  maxSeen = Math.max(maxSeen, r.ts);
});
const max = (k) => Math.max(...refinals.map((x) => x[k]));
console.log(`records ${recs.length}, segments ${first.size}, max out-of-order ${skew} ms`);
console.log(
  `word-changing re-finals ${refinals.length}: own timestamp lag max ${max('own')} ms, ` +
    `newest caption already seen max ${max('behind')} ms ahead, at most ${max('records')} records later, ` +
    `next segment >30 s later for ${refinals.filter((x) => x.next > 30_000).length}`,
);

// Replay the summarizer's rule: a window closes once the newest timestamp passes its end plus
// grace; any later change to a closed window's lines (key + words) is a stale event.
function staleEvents(windowMs, graceMs) {
  const start = (ts) => Math.floor(ts / windowMs) * windowMs;
  const lines = new Map();
  const closed = new Map();
  const print = (s) =>
    [...lines]
      .filter(([, v]) => start(v.ts) === s)
      .map(([k, v]) => `${k}|${v.w}`)
      .sort()
      .join('\n');
  let now = -Infinity;
  let events = 0;
  for (const r of recs) {
    now = Math.max(now, r.ts);
    const ts = lines.get(r.key)?.ts ?? r.ts;
    lines.set(r.key, { ts, w: words(r.text) });
    const s = start(ts);
    if (closed.has(s) && closed.get(s) !== print(s)) {
      events++;
      closed.set(s, print(s));
    }
    for (const v of lines.values())
      if (!closed.has(start(v.ts)) && start(v.ts) + windowMs + graceMs <= now)
        closed.set(start(v.ts), print(start(v.ts)));
  }
  return events;
}
for (const minutes of [1, 5])
  for (const grace of [0, 10, 30, 60, 120, 300])
    console.log(`window ${minutes} min, grace ${grace} s: ${staleEvents(minutes * 60_000, grace * 1000)} stale events`);
```
