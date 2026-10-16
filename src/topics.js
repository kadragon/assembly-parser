import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from './store.js';
import { summaryToText } from './summarizer.js';

/**
 * One file per topic under data/<xcgcd>/topics/:
 *   t001.json  source of truth — entries are only ever added or replaced per window
 *   t001.md    human-readable copy, regenerated on every save
 *
 * topic = { id, category, title, description, created,
 *           entries: [{ start, end, label, notes, members, institutions }],
 *           summary: { core, bullets: [{ tag, member, institution, text }], until } | null,
 *           factcheck?: { until, checks: [{ member, claim, verdict, explanation, sides: [{ who, view, sources }], sources: [{ title, url }] }] } }
 */
export const topicsDir = (dir) => path.join(dir, 'topics');

/** Procedural chatter (opening, oaths, recess notices): no members, no topic summary, no fact checks. */
export const PROCEDURAL = '회의 진행';

// "한국교원대학교" / "경인교대" / "방통대" → one key per institution
const instKey = (name) =>
  name
    .replace(/\s+/g, '')
    .replace(/대학교$/, '대')
    .replace(/교육대/, '교대')
    .replace(/체육대/, '체대')
    .replace(/과학기술대/, '과기대')
    .replace(/방송통신대|방통대/, '방송대');

/** The spelling already in use for this institution, or the name itself if it is new. */
export function canonicalInstitution(name, known) {
  const key = instKey(name);
  return known.find((k) => instKey(k) === key) ?? name;
}

export function loadTopics(dir) {
  const tdir = topicsDir(dir);
  if (!fs.existsSync(tdir)) return [];
  return fs
    .readdirSync(tdir)
    .filter((n) => /^t\d+\.json$/.test(n))
    .map((n) => readJson(path.join(tdir, n)))
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function nextTopicId(topics) {
  const max = topics.reduce((m, t) => Math.max(m, Number(t.id.slice(1))), 0);
  return `t${String(max + 1).padStart(3, '0')}`;
}

/** Add or replace this window's entry, so re-running a window never duplicates it. */
export function upsertEntry(topic, entry) {
  topic.entries = topic.entries.filter((e) => e.start !== entry.start);
  topic.entries.push(entry);
  topic.entries.sort((a, b) => a.start - b.start);
}

/** Entries with members' remarks that came in after the last fact check. Procedural topics are skipped. */
export function pendingFactCheck(topic) {
  if (topic.title === PROCEDURAL) return [];
  const until = topic.factcheck?.until ?? 0;
  return topic.entries.filter((e) => e.end > until && e.members?.length);
}

export function saveTopic(dir, topic, fmtTime) {
  const tdir = topicsDir(dir);
  fs.mkdirSync(tdir, { recursive: true });
  writeJson(path.join(tdir, `${topic.id}.json`), topic);
  fs.writeFileSync(path.join(tdir, `${topic.id}.md`), toMarkdown(topic, fmtTime));
}

function toMarkdown(topic, fmtTime) {
  const out = [`# ${topic.title}`, '', `${topic.category} · 처음 등장 ${fmtTime(topic.created)}`];
  if (topic.description) out.push('', topic.description);
  const people = (e) =>
    [...(e.members ?? []).map((m) => `${m} 위원`), ...(e.institutions ?? [])].join(' · ');
  const all = {
    members: [...new Set(topic.entries.flatMap((e) => e.members ?? []))],
    institutions: [...new Set(topic.entries.flatMap((e) => e.institutions ?? []))],
  };
  if (people(all)) out.push('', people(all));
  if (topic.summary)
    out.push(
      '',
      `## 요약 (${fmtTime(topic.summary.until)}까지)`,
      '',
      topic.summary.bullets ? summaryToText(topic.summary) : topic.summary.text,
    );
  if (topic.factcheck?.checks.length) {
    const links = (sources) => sources.map((s) => `[${s.title}](${s.url})`).join(', ');
    out.push('', '## 팩트체크');
    for (const c of topic.factcheck.checks) {
      out.push(
        '',
        `- **${c.verdict}** ${c.member ? `(${c.member} 위원) ` : ''}${c.claim}`,
        `  - ${c.explanation}`,
      );
      for (const side of c.sides)
        out.push(
          `  - ${side.who}: ${side.view}${side.sources.length ? ` — ${links(side.sources)}` : ''}`,
        );
      if (c.sources.length) out.push(`  - 출처: ${links(c.sources)}`);
    }
  }
  out.push('', '## 구간별 기록');
  for (const e of topic.entries)
    out.push('', `### ${e.label}${people(e) ? ` — ${people(e)}` : ''}`, '', e.notes);
  return `${out.join('\n')}\n`;
}

/** Move existing topics aside instead of deleting them when summaries are rebuilt. */
export function archiveTopics(dir) {
  const tdir = topicsDir(dir);
  if (!fs.existsSync(tdir) || !fs.readdirSync(tdir).length) return null;
  const dest = `${tdir}-archived-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.renameSync(tdir, dest);
  return dest;
}

/**
 * Keep only curation operations that point at live topics and existing entries.
 * op = { type: 'merge' | 'move' | 'rename' | 'recategorize', from, to?, entry? (window label), title?, description?, category?, reason }
 */
export function validateCuration(ops, topics, categories) {
  const live = new Map(topics.filter((t) => !t.mergedInto).map((t) => [t.id, t]));
  return ops.filter((op) => {
    const from = live.get(op.from);
    if (!from) return false;
    switch (op.type) {
      case 'merge':
        return live.has(op.to) && op.to !== op.from;
      case 'move':
        return (
          live.has(op.to) && op.to !== op.from && from.entries.some((e) => e.label === op.entry)
        );
      case 'rename':
        return Boolean(op.title?.trim()) && op.title.trim() !== from.title;
      case 'recategorize':
        return categories.includes(op.category) && op.category !== from.category;
      default:
        return false;
    }
  });
}
