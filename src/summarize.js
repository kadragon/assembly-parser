#!/usr/bin/env node
// Reads the collected transcript and keeps window summaries (state.json) and
// per-topic records (topics/*.json) up to date. Safe to stop and restart at any time.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { validateConfig } from './control.js';
import { workerLock } from './ownership.js';
import { files, meetingDir, readJson, readTranscript, writeJson } from './store.js';
import {
  curateTopics,
  factCheckTopic,
  routeWindow,
  runningJobs,
  stopModelChildren,
  summarizeTopic,
  summarizeWindow,
  watchJobs,
} from './summarizer.js';
import {
  archiveTopics,
  canonicalInstitution,
  loadTopics,
  nextTopicId,
  PROCEDURAL,
  pendingFactCheck,
  saveTopic,
  upsertEntry,
  validateCuration,
} from './topics.js';
import { closedWindows, mentions } from './transcript.js';

// timestamp every log line so pipeline timing can be read from the log
for (const level of ['log', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) =>
    orig(new Date().toLocaleTimeString('ko-KR', { hour12: false }), ...args);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: 'string', default: 'data' },
    window: { type: 'string', default: '5' }, // minutes
    focus: { type: 'string' }, // e.g. 한국교원대학교 — becomes the first topic category
    'focus-keywords': { type: 'string' }, // comma-separated, e.g. 교원대 — hints the router
    'focus-note': { type: 'string' }, // projects of the focus institution, e.g. 부설 장애인 체육 특수학교 설립
    rebuild: { type: 'boolean', default: false }, // discard summaries (topics are archived, not deleted)
    finalize: { type: 'boolean', default: false },
    once: { type: 'boolean', default: false }, // process closed windows, then exit
    factcheck: { type: 'boolean', default: false }, // web-check members' factual claims (slow, uses web search)
    curate: { type: 'boolean', default: false }, // review the whole topic list and log proposed fixes (not applied yet)
  },
});
if (!positionals[0]) {
  console.error(
    'usage: node src/summarize.js <player.asp URL | xcgcd> [--window 5] [--focus 기관명 --focus-keywords k1,k2 --focus-note 소관사업] [--rebuild] [--once] [--factcheck] [--curate] [--data data]',
  );
  process.exit(1);
}

const dir = meetingDir(positionals[0], values.data);
const f = files(dir);
const meeting = readJson(f.meeting);
if (!meeting) {
  console.error(`${f.meeting} not found; start collect.js first`);
  process.exit(1);
}

const windowMinutes = validateConfig({ windowMinutes: Number(values.window) }).windowMinutes;
if (values.finalize && !values.once) throw new Error('--finalize requires --once');
const release = workerLock(dir, 'summarizer');
process.on('exit', release);
const shutdown = () => {
  stopModelChildren();
  release();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('disconnect', shutdown);
const windowMs = windowMinutes * 60_000;
// tail of the previous window passed to the window summary, so a statement cut at the boundary has context
const overlapMs = 60_000;
// captions land in the file a few seconds after their timestamp; wait before closing a window
const graceMs = 30_000;
// a window that keeps failing is skipped after this many tries so later windows are not blocked
const MAX_ATTEMPTS = 3;
// topic curation looks at the whole meeting, so it runs rarely
const CURATE_EVERY_MS = 30 * 60_000;
const focus = values.focus?.trim() || null;
const focusKeywords = focus
  ? (values['focus-keywords'] ?? focus)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : [];
const focusNote = (focus && values['focus-note']?.trim()) || null;
const categories = focus ? [focus, '그외'] : ['전체'];

/** windows[start] = { start, end, lineCount, summary?, error?, routed?, routeError?, topics?: [topicId], skipped? } */
const fresh = () => ({ windowMinutes, categories, windows: {} });
let state = values.rebuild ? null : readJson(f.state);
if (state && !state.categories && state.windowMinutes === windowMinutes) {
  // pre-topic state: keep window summaries, drop the old single rolling summaries
  state.categories = categories;
  delete state.focus;
  delete state.overall;
  delete state.focusSummary;
  for (const w of Object.values(state.windows)) {
    delete w.focusChecked;
    delete w.focusNotes;
  }
}
if (
  !state ||
  state.windowMinutes !== windowMinutes ||
  String(state.categories) !== String(categories)
) {
  if (state) console.log('window size or categories changed; rebuilding');
  const archived = archiveTopics(dir);
  if (archived) console.log(`previous topics moved to ${archived}`);
  state = fresh();
}
const save = () => writeJson(f.state, state);
// pid lets serve ignore a list left behind by a process that was killed mid-call
watchJobs(() => {
  state.running = { pid: process.pid, jobs: runningJobs() };
  save();
});
state.running = { pid: process.pid, jobs: [] };
save();

const fmt = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const fmtTime = (t) => fmt.format(t);
const label = (start) => `${fmtTime(start)}–${fmtTime(start + windowMs)}`;

const topics = new Map(loadTopics(dir).map((t) => [t.id, t]));
const persist = (topic) => saveTopic(dir, topic, fmtTime);
// names seen so far, so members and institutions keep one spelling each
const seen = (field) => [
  ...new Set([...topics.values()].flatMap((t) => t.entries.flatMap((e) => e[field] ?? []))),
];

// Run tasks concurrently; keep whatever succeeded, then surface the first failure.
async function settle(tasks) {
  const results = await Promise.allSettled(tasks);
  save();
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
}

/** Record routed items into topic files, creating topics the router asked for. */
function applyRouting(w, items) {
  const touched = new Map();
  const knownInstitutions = seen('institutions');
  for (const item of items) {
    let topic = topics.get(item.topic_id);
    if (!topic) {
      if (!item.new_title) {
        console.warn(`router referenced unknown topic ${item.topic_id}; skipped`);
        continue;
      }
      // the router may propose the same new title twice in one window
      topic = [...topics.values()].find(
        (t) => t.title === item.new_title && t.category === item.new_category,
      );
      topic ??= {
        id: nextTopicId([...topics.values()]),
        category: categories.includes(item.new_category) ? item.new_category : categories.at(-1),
        title: item.new_title,
        description: item.new_description ?? '',
        created: w.start,
        entries: [],
        summary: null,
      };
      if (!topics.has(topic.id)) {
        topics.set(topic.id, topic);
        console.log(`new topic ${topic.id} [${topic.category}] ${topic.title}`);
      }
    }
    // several items for one topic in the same window become one entry
    const acc = touched.get(topic.id) ?? { notes: [], members: new Set(), institutions: new Set() };
    acc.notes.push(item.notes);
    // the chair calling the next speaker is not that member's remark
    if (topic.title !== PROCEDURAL) for (const m of item.members) acc.members.add(m);
    for (const name of item.institutions) {
      const inst = canonicalInstitution(name, knownInstitutions);
      if (!knownInstitutions.includes(inst)) knownInstitutions.push(inst);
      acc.institutions.add(inst);
    }
    touched.set(topic.id, acc);
  }
  for (const [id, acc] of touched) {
    const topic = topics.get(id);
    upsertEntry(topic, {
      start: w.start,
      end: w.end,
      label: label(w.start),
      notes: acc.notes.join('\n'),
      members: [...acc.members],
      institutions: [...acc.institutions],
    });
    persist(topic);
  }
  w.topics = [...touched.keys()];
  w.routed = true;
}

async function processWindow(transcript, start) {
  const lines = transcript.between(start, start + windowMs);
  state.windows[start] ??= { start, end: start + windowMs };
  const w = state.windows[start];
  w.lineCount = lines.length;
  const prev = state.windows[start - windowMs];
  const tasks = [];

  if (!w.summary) {
    console.log(`summarizing ${label(start)} (${lines.length} lines)`);
    tasks.push(
      summarizeWindow({
        meeting,
        label: label(start),
        lines,
        previous: prev?.summary,
        before: transcript.between(start - overlapMs, start),
      }).then(
        (summary) => {
          w.summary = summary;
          delete w.error;
        },
        (err) => {
          w.error = err.message;
          throw err;
        },
      ),
    );
  }
  if (!w.routed) {
    console.log(`routing ${label(start)} into topics`);
    const previousItems = (prev?.topics ?? []).map((id) => {
      const t = topics.get(id);
      return {
        id,
        title: t.title,
        notes: t.entries.find((e) => e.start === prev.start)?.notes ?? '',
      };
    });
    const hint =
      focus && mentions(lines, focusKeywords)
        ? `참고: 이번 구간 자막에 ${focus}(${focusKeywords.join(', ')}) 언급이 있습니다.`
        : null;
    const catalog = [...topics.values()].map(({ id, category, title, description }) => ({
      id,
      category,
      title,
      description,
    }));
    tasks.push(
      routeWindow({
        meeting,
        categories,
        catalog,
        label: label(start),
        lines,
        previousItems,
        hint,
        focusNote,
        knownMembers: seen('members'),
        knownInstitutions: seen('institutions'),
      }).then(
        (items) => {
          applyRouting(w, items);
          delete w.routeError;
        },
        (err) => {
          w.routeError = err.message;
          throw err;
        },
      ),
    );
  }
  await settle(tasks);
}

// Bounded parallelism so a backlog doesn't spawn dozens of CLI processes at once.
async function pool(items, limit, fn) {
  const queue = [...items];
  const errors = [];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift()).catch((e) => errors.push(e));
  });
  await Promise.all(workers);
  if (errors.length) throw errors[0];
}

/** Fold each topic's new entries into its rolling summary. */
async function updateTopics() {
  const stale = [...topics.values()].filter(
    (t) => t.title !== PROCEDURAL && t.entries.some((e) => e.end > (t.summary?.until ?? 0)),
  );
  await pool(stale, 4, async (topic) => {
    const entries = topic.entries.filter((e) => e.end > (topic.summary?.until ?? 0));
    console.log(`updating topic ${topic.id} ${topic.title} (+${entries.length})`);
    // summaries from before the structured format carry only `text`; start those fresh
    const previous = topic.summary?.bullets ? topic.summary : null;
    const summary = await summarizeTopic({
      meeting,
      topic,
      previous,
      entries: previous ? entries : topic.entries,
    });
    const known = seen('institutions');
    for (const b of summary.bullets)
      if (b.institution) b.institution = canonicalInstitution(b.institution, known);
    topic.summary = { ...summary, until: topic.entries.at(-1).end };
    persist(topic);
  });
}

/** Web-check members' claims in entries added since each topic's last check. */
async function factCheck() {
  const stale = [...topics.values()].filter((t) => pendingFactCheck(t).length);
  await pool(stale, 2, async (topic) => {
    const entries = pendingFactCheck(topic);
    const until = topic.entries.at(-1).end; // taken before the call: entries may grow meanwhile
    console.log(`fact-checking topic ${topic.id} ${topic.title} (+${entries.length})`);
    const previous = topic.factcheck?.checks ?? [];
    const checks = await factCheckTopic({ meeting, topic, entries, previous });
    topic.factcheck = { until, checks: [...previous, ...checks] };
    persist(topic);
  });
}

/**
 * Ask for merges, moves, renames and category fixes across all topics.
 * Proposal mode: valid ops are only appended to curation.jsonl for review, topics are untouched.
 */
async function curate({ force = false } = {}) {
  const live = [...topics.values()].filter((t) => !t.mergedInto && t.entries.length);
  const until = Math.max(0, ...live.flatMap((t) => t.entries.map((e) => e.end)));
  const last = state.curation;
  if (!force && last && (until <= last.until || Date.now() - last.at < CURATE_EVERY_MS)) return;
  console.log(`curating ${live.length} topics (proposal only)`);
  const raw = await curateTopics({ meeting, categories, focusNote, topics: live });
  const ops = validateCuration(raw, live, categories);
  const rejected = raw.filter((o) => !ops.includes(o));
  fs.appendFileSync(
    path.join(dir, 'curation.jsonl'),
    `${JSON.stringify({ at: Date.now(), until, mode: 'proposal', ops, rejected })}\n`,
  );
  state.curation = { at: Date.now(), until };
  save();
  console.log(
    `curation: ${ops.length} proposals${rejected.length ? `, ${rejected.length} invalid` : ''}`,
  );
}

// failed tries per window; kept in memory so restarting summarize retries skipped windows
const attempts = new Map();

async function tick() {
  const transcript = readTranscript(f.transcript);
  const starts = closedWindows(
    transcript.lines(),
    windowMs,
    values.finalize ? Infinity : Date.now(),
    graceMs,
  )
    .filter((s) => !state.windows[s]?.summary || !state.windows[s].routed)
    .filter((s) => (attempts.get(s) ?? 0) < MAX_ATTEMPTS);
  // windows go in order: each uses the previous window as context and the topic list so far;
  // within a window the summary and topic routing run in parallel
  for (const start of starts) {
    try {
      await processWindow(transcript, start);
      delete state.windows[start].skipped;
    } catch (err) {
      const n = (attempts.get(start) ?? 0) + 1;
      attempts.set(start, n);
      if (n < MAX_ATTEMPTS) throw err; // retry next tick, before any later window
      console.error(`${label(start)} failed ${n} times, skipping: ${err.message}`);
      state.windows[start].skipped = true;
      save();
    }
  }
  await updateTopics();
  // after the windows, so a review never delays a summary that is due; it never edits topics yet
  if (values.curate) await curate({ force: values.once });
}

console.log(`${meeting.committee} — ${meeting.subject}`);
console.log(`categories: ${categories.join(' / ')}; topics in ${path.join(dir, 'topics')}`);
if (focusNote) console.log(`focus note: ${focusNote}`);

if (values.once) {
  await tick();
  if (values.finalize) {
    state.finalizedThrough = Math.max(
      state.finalizedThrough ?? 0,
      ...Object.values(state.windows)
        .filter((w) => w.summary && w.routed)
        .map((w) => w.end),
    );
    save();
  }
  if (values.factcheck) await factCheck();
  // The parent's IPC channel must not keep a completed one-shot worker alive.
  if (process.connected) {
    process.removeListener('disconnect', shutdown);
    process.disconnect();
  }
} else {
  // fact checks run on their own loop so slow web searches never hold up window summaries
  const every = (step, name) => {
    let busy = false;
    const loop = async () => {
      if (busy) return;
      busy = true;
      try {
        await step();
      } catch (err) {
        console.error(`${name} step failed, retrying next tick: ${err.message}`);
      } finally {
        busy = false;
      }
    };
    setInterval(loop, 30_000);
    loop();
  };
  every(tick, 'summary');
  if (values.factcheck) every(factCheck, 'fact-check');
}
