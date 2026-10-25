import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEMO_SESSIONS, startDemo } from '../src/demo.js';
import { parseJsonl } from '../src/importer.js';

const demoDir = fileURLToPath(new URL('../demo/', import.meta.url));
const tree = (dir) =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => {
      const file = path.join(d.parentPath, d.name);
      return [path.relative(dir, file), fs.readFileSync(file, 'utf8')];
    })
    .sort(([a], [b]) => a.localeCompare(b));

test('the demo serves a precomputed general session from a copy, offline', async (t) => {
  const before = tree(DEMO_SESSIONS);
  const app = await startDemo({
    port: 0,
    listBroadcasts: async () => {
      throw new Error('offline');
    },
  });
  t.after(() => app.close());
  assert.notEqual(path.resolve(app.root), path.resolve(DEMO_SESSIONS));

  const { sessions } = await (await fetch(`${app.origin}/api/sessions`)).json();
  assert.deepEqual(
    sessions.map((s) => [s.id, s.meeting.profile, s.collection, s.summary]),
    [['library-committee', 'general', 'imported', 'complete']],
  );
  const state = await (await fetch(`${app.origin}/sessions/library-committee/api/state`)).json();
  assert.equal(state.timeBasis, 'elapsed');
  assert.deepEqual(state.categories, ['시설·공사', '예산', '그외']);
  assert.equal(state.windows.length, 4);
  assert.ok(state.windows.every((w) => w.summary && w.routed));
  assert.ok(state.topics.length > 0);
  assert.ok(state.topics.every((t) => state.categories.includes(t.category)));
  assert.deepEqual(state.rebuild, { pending: false, required: [], rebuiltFrom: null });
  assert.deepEqual(state.running, []);

  // a write in the demo copy never reaches the committed demo
  const { token } = await (await fetch(`${app.origin}/api/sessions`)).json();
  const res = await fetch(`${app.origin}/api/sessions/library-committee/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: app.origin, 'x-session-token': token },
    body: JSON.stringify({ config: { windowMinutes: 10 } }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(tree(DEMO_SESSIONS), before);
});

test('committed demo content is synthetic and free of runtime artifacts', () => {
  const files = tree(demoDir);
  const names = files.map(([name]) => name);
  assert.ok(names.includes(path.join('source', 'library-committee.jsonl')));
  for (const [name, content] of files) {
    assert.doesNotMatch(name, /(^|\/)(\.|archive\/)|\.(log|lock)$/, name);
    assert.doesNotMatch(content, /\/Users\/|\/home\/|\/private\/|\/tmp\/|[A-Z]:\\/, name);
    assert.doesNotMatch(content, /"pid"\s*:/, name);
    assert.doesNotMatch(content, /api[_-]?key|token|secret|password/i, name);
  }
  const state = JSON.parse(
    fs.readFileSync(path.join(DEMO_SESSIONS, 'library-committee', 'state.json'), 'utf8'),
  );
  assert.equal(state.running, undefined);
  // the precomputed session was summarized from the committed synthetic source
  const source = parseJsonl(
    fs.readFileSync(path.join(demoDir, 'source', 'library-committee.jsonl'), 'utf8'),
  );
  const transcript = fs
    .readFileSync(path.join(DEMO_SESSIONS, 'library-committee', 'transcript.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(transcript, source.lines);
});
