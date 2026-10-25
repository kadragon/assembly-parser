#!/usr/bin/env node
// Reads the collected transcript and keeps window summaries (state.json) and
// per-topic records (topics/*.json) up to date. Safe to stop and restart at any time.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { workerLock } from './ownership.js';
import { formatElapsed, isElapsed, profileOf } from './profile.js';
import {
  archiveOutput,
  effectiveSettings,
  fingerprint,
  finishRebuild,
  STALE_EXIT,
  STATE_VERSION,
  savedSettings,
  staleReasons,
} from './rebuild.js';
import { files, meetingDir, readJson, readTranscript, writeJson } from './store.js';
import {
  curateTopics,
  factCheckTopic,
  MODEL,
  PROMPT_VERSION,
  routeWindow,
  runningJobs,
  stopModelChildren,
  summarizeTopic,
  summarizeWindow,
  watchJobs,
} from './summarizer.js';
import {
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
    // omitted settings keep the values saved with existing output
    window: { type: 'string' }, // minutes, default 5
    focus: { type: 'string' }, // e.g. 한국교원대학교 — becomes the first topic category
    'focus-keywords': { type: 'string' }, // comma-separated, e.g. 교원대 — hints the router
    'focus-note': { type: 'string' }, // projects of the focus institution, e.g. 부설 장애인 체육 특수학교 설립
    rebuild: { type: 'boolean', default: false }, // archive all derived output, then summarize from scratch
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

if (values.finalize && !values.once) throw new Error('--finalize requires --once');
const profile = profileOf(meeting);
// fact checks search the public web and curation is tuned to Assembly topics
if (profile !== 'assembly' && (values.factcheck || values.curate)) {
  console.error('--factcheck and --curate are only available for Assembly sessions');
  process.exit(1);
}
// an uploaded file is complete: every populated window is due, independent of the clock
const complete = meeting.complete === true;
// general output names speakers and organizations; Assembly keeps its legacy field names
const fields =
  profile === 'assembly'
    ? { people: 'members', organizations: 'institutions' }
    : { people: 'speakers', organizations: 'organizations' };
const release = workerLock(dir, 'summarizer');
process.on('exit', release);
// everything below runs as the session's only summary writer
const resumed = finishRebuild(dir);
if (resumed) console.log(`completed interrupted rebuild; previous output in ${resumed.archive}`);
const settings = effectiveSettings(resumed?.settings ?? savedSettings(readJson(f.state)), values, {
  model: MODEL,
  promptVersion: PROMPT_VERSION,
  profile,
});
const { windowMinutes, focus, focusKeywords, focusNote: savedNote } = settings;
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
const focusNote = savedNote || null;
const categories = focus ? [focus, '그외'] : ['전체'];

// Output is never silently reused or replaced: a mismatch exits until --rebuild is requested.
class StaleError extends Error {}
function exitIfStale(reasons) {
  if (!reasons.length) return;
  stopModelChildren();
  process.stderr.write(`rebuild required:\n${reasons.map((r) => `- ${r}`).join('\n')}\n`);
  process.exit(STALE_EXIT);
}

/**
 * windows[start] = { start, end, lineCount, fingerprint, summary?, error?, routed?, routeError?,
 *                    topics?: [topicId], skipped? }
 */
const fresh = (rebuiltFrom) => ({
  version: STATE_VERSION,
  settings,
  windowMinutes,
  categories,
  // `rebuilding` lasts until the first complete pass, so viewers know output is refilling
  ...(rebuiltFrom && { rebuiltFrom, rebuilding: true }),
  windows: {},
});
let state = readJson(f.state);
if (values.rebuild) {
  const archived = archiveOutput(dir, settings);
  if (archived) console.log(`previous output archived to ${archived}`);
  state = fresh(archived ?? resumed?.archive);
} else {
  exitIfStale(staleReasons(dir, state, settings, readTranscript(f.transcript)));
  state ??= fresh(resumed?.archive);
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
const fmtTime = (t) => (isElapsed(meeting) ? formatElapsed(t) : fmt.format(t));
const label = (start) => `${fmtTime(start)}–${fmtTime(start + windowMs)}`;

const topics = new Map(loadTopics(dir).map((t) => [t.id, t]));
const persist = (topic) => saveTopic(dir, topic, fmtTime, profile);
// names seen so far, so speakers and organizations keep one spelling each
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
  const knownOrganizations = seen(fields.organizations);
  // Assembly institution names have known variants ("교원대학교" / "교원대"); others are kept as given
  const canonical = (name) =>
    profile === 'assembly' ? canonicalInstitution(name, knownOrganizations) : name;
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
    const acc = touched.get(topic.id) ?? { notes: [], people: new Set(), organizations: new Set() };
    acc.notes.push(item.notes);
    // the chair calling the next speaker is not that member's remark
    if (topic.title !== PROCEDURAL) for (const m of item[fields.people]) acc.people.add(m);
    for (const name of item[fields.organizations]) {
      const org = canonical(name);
      if (!knownOrganizations.includes(org)) knownOrganizations.push(org);
      acc.organizations.add(org);
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
      [fields.people]: [...acc.people],
      [fields.organizations]: [...acc.organizations],
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
  // checked against the transcript before every tick; a later correction makes output stale
  w.fingerprint = fingerprint(lines);
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
        knownPeople: seen(fields.people),
        knownOrganizations: seen(fields.organizations),
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
    const known = seen(fields.organizations);
    if (profile === 'assembly')
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

// Failed tries per window. Live sessions keep them in memory so restarting summarize retries
// skipped windows; an uploaded file is summarized by one-shot runs, so its count is saved with
// the window and a window that keeps failing is eventually skipped instead of blocking the rest.
const memory = new Map();
const attempts = {
  get: (start) => (complete ? state.windows[start]?.attempts : memory.get(start)),
  set(start, n) {
    if (complete) state.windows[start].attempts = n;
    else memory.set(start, n);
  },
};

async function tick() {
  const transcript = readTranscript(f.transcript);
  const reasons = staleReasons(dir, state, settings, transcript);
  if (reasons.length) throw Object.assign(new StaleError('rebuild required'), { reasons });
  const starts = closedWindows(
    transcript.lines(),
    windowMs,
    values.finalize || complete ? Infinity : Date.now(),
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
      delete state.windows[start].attempts;
    } catch (err) {
      const n = (attempts.get(start) ?? 0) + 1;
      attempts.set(start, n);
      if (n < MAX_ATTEMPTS) {
        save();
        throw err; // retry next tick, before any later window
      }
      console.error(`${label(start)} failed ${n} times, skipping: ${err.message}`);
      state.windows[start].skipped = true;
      save();
    }
  }
  await updateTopics();
  if (state.rebuilding) {
    delete state.rebuilding;
    save();
  }
  // after the windows, so a review never delays a summary that is due; it never edits topics yet
  if (values.curate) await curate({ force: values.once });
}

console.log(`${meeting.committee} — ${meeting.subject}`);
console.log(`categories: ${categories.join(' / ')}; topics in ${path.join(dir, 'topics')}`);
if (focusNote) console.log(`focus note: ${focusNote}`);

if (values.once) {
  try {
    await tick();
  } catch (err) {
    if (err instanceof StaleError) exitIfStale(err.reasons);
    throw err;
  }
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
        // collection goes on; summaries wait for an explicit rebuild
        if (err instanceof StaleError) exitIfStale(err.reasons);
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
