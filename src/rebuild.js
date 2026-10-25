import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateConfig } from './control.js';
import { formatElapsed, isElapsed } from './profile.js';
import { readJson, writeJson } from './store.js';
import { topicsDir } from './topics.js';
import { windowStart } from './transcript.js';

/**
 * Derived output (state.json, topics/, curation.jsonl) depends on the settings and source text
 * it was made from. Both are recorded, and a mismatch stops summarizing until an explicit
 * rebuild archives the old output. There is no partial replay: routing and rolling summaries
 * depend on every earlier window.
 */
export const STATE_VERSION = 2;
// summarize.js exits with this code when output needs an explicit rebuild
export const STALE_EXIT = 3;
const DERIVED = ['state.json', 'topics', 'curation.jsonl'];
const marker = (dir) => path.join(dir, '.rebuild.json');

export const keywordList = (focus, keywords) =>
  focus
    ? (keywords || focus)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

/** Settings saved with output; legacy output only implies its window size and focus. */
export function savedSettings(state) {
  if (state?.settings) return state.settings;
  if (!state) return null;
  const focus = state.categories?.length > 1 ? state.categories[0] : '';
  return { windowMinutes: state.windowMinutes ?? 5, focus, focusKeywords: [], focusNote: '' };
}

/** Summary settings for a validated configuration; categories are recorded only when set. */
export function settingsOf(config) {
  return {
    windowMinutes: config.windowMinutes,
    focus: config.focus,
    focusKeywords: keywordList(config.focus, config.focusKeywords),
    focusNote: config.focusNote,
    ...(config.categories && { categories: config.categories }),
  };
}

const NO_FOCUS = { focus: '', focusKeywords: [], focusNote: '' };

/**
 * Explicit CLI values override saved settings; omitted ones keep them. Keywords and notes
 * belong to a focus, so a different explicit focus drops the saved ones. Explicit categories
 * replace a saved focus and an explicit focus replaces saved categories; giving both is an error.
 */
export function effectiveSettings(saved, flags, identity) {
  const base = saved ?? { windowMinutes: 5, ...NO_FOCUS };
  let explicit;
  if (flags.categories !== undefined) {
    try {
      explicit = JSON.parse(flags.categories);
    } catch {}
    if (!Array.isArray(explicit)) throw new Error('--categories must be a JSON list');
  }
  const categories = explicit ?? (flags.focus === undefined ? (base.categories ?? []) : []);
  const legacy = explicit?.length ? NO_FOCUS : base;
  const focus = flags.focus ?? legacy.focus;
  const keep = focus.trim() === legacy.focus;
  const config = validateConfig({
    windowMinutes: flags.window === undefined ? base.windowMinutes : Number(flags.window),
    focus,
    focusKeywords: flags['focus-keywords'] ?? (keep ? legacy.focusKeywords.join(',') : ''),
    focusNote: flags['focus-note'] ?? (keep ? legacy.focusNote : ''),
    categories,
  });
  return { ...settingsOf(config), ...identity };
}

// The STT server re-sends a final with speaker turns split onto "-" lines; only a change in
// the words themselves counts as a correction.
const words = (text) => text.replace(/^-/gm, '').replace(/\s+/g, '');
export const fingerprint = (lines) =>
  createHash('sha256')
    .update(JSON.stringify(lines.map((l) => [l.key, words(l.text)])))
    .digest('hex')
    .slice(0, 16);

const minute = (t) => new Date(t).toISOString().slice(11, 16);
// uploaded files carry elapsed time, which must not be shown as a clock time
const windowName = (dir, start) =>
  isElapsed(readJson(path.join(dir, 'meeting.json')))
    ? `${formatElapsed(start)} elapsed`
    : `${minute(start)} UTC`;

// Category lists are long: name them, mark the fallback (*), and say when only details changed.
const categoryNames = (list) =>
  list ? list.map((c) => `${c.name}${c.fallback ? '*' : ''}`).join(', ') : '(none)';
const change = (key, from, to) => {
  if (key !== 'categories')
    return `${key} changed: ${JSON.stringify(from)} → ${JSON.stringify(to)}`;
  const [before, after] = [categoryNames(from), categoryNames(to)];
  return before === after
    ? `categories changed: descriptions or keywords of ${after}`
    : `categories changed: ${before} → ${after}`;
};

/** Why existing output no longer matches the requested settings or the transcript; [] if it does. */
export function staleReasons(dir, state, settings, transcript) {
  if (!state) return fs.existsSync(topicsDir(dir)) ? ['topics exist without summary state'] : [];
  if (!state.settings) return ['existing output has no recorded settings (legacy format)'];
  const reasons = [];
  if (state.version !== STATE_VERSION)
    reasons.push(`state version changed: ${state.version} → ${STATE_VERSION}`);
  // output saved before profiles existed is Assembly output
  const saved = { profile: 'assembly', ...state.settings };
  const next = { profile: 'assembly', ...settings };
  // both sides' keys: categories are recorded only while set
  for (const reason of [...new Set([...Object.keys(next), ...Object.keys(saved)])]
    .filter((k) => JSON.stringify(saved[k]) !== JSON.stringify(next[k]))
    .map((k) => change(k, saved[k], next[k])))
    reasons.push(reason);
  // one pass over the transcript: the snapshot API runs this every second
  const windowMs = state.settings.windowMinutes * 60_000;
  const byWindow = new Map();
  for (const line of transcript.lines()) {
    const start = windowStart(line.ts, windowMs);
    if (!byWindow.has(start)) byWindow.set(start, []);
    byWindow.get(start).push(line);
  }
  const done = Object.values(state.windows).filter((w) => w.summary || w.routed);
  const changed = done.filter((w) => w.fingerprint !== fingerprint(byWindow.get(w.start) ?? []));
  // a window that gains its first captions after later windows were summarized
  const last = Math.max(-Infinity, ...done.map((w) => w.start));
  const late = [...byWindow.keys()].filter((s) => s < last && !state.windows[s]);
  for (const start of [...changed.map((w) => w.start), ...late].sort((a, b) => a - b))
    reasons.push(`captions for ${windowName(dir, start)} window changed after it was summarized`);
  return reasons;
}

/**
 * Completes a rebuild that stopped after its archive was published.
 * Returns { archive, settings } so the rebuild continues with the settings it was asked for.
 */
export function finishRebuild(dir) {
  const pending = readJson(marker(dir));
  if (!pending) return null;
  for (const name of DERIVED) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  fs.rmSync(marker(dir));
  return pending;
}

/**
 * Copy all derived output into archive/<time>/ and publish it with one rename before anything
 * live is removed, so an interruption at any point leaves a complete copy somewhere.
 * Returns the archive path relative to the session, or null when there was nothing to keep.
 */
export function archiveOutput(dir, settings) {
  const present = DERIVED.filter((name) => fs.existsSync(path.join(dir, name)));
  if (!present.length) return null;
  const name = new Date().toISOString().replace(/[:.]/g, '-');
  const staging = path.join(dir, 'archive', `.${name}.tmp`);
  fs.mkdirSync(staging, { recursive: true });
  for (const item of present)
    fs.cpSync(path.join(dir, item), path.join(staging, item), { recursive: true });
  const archive = path.join('archive', name);
  fs.renameSync(staging, path.join(dir, archive));
  writeJson(marker(dir), { archive, settings });
  finishRebuild(dir);
  return archive;
}

export const rebuildPending = (dir) => fs.existsSync(marker(dir));
