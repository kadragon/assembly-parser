import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseJsonl } from '../src/importer.js';
import { runClaude, schemaError } from '../src/runner.js';
import { writeJson } from '../src/store.js';

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assembly-runner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// Installs an executable fake `claude` first on PATH for this process and its children.
function fake(t, root, source) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  t.after(() => {
    process.env.PATH = saved;
  });
}

test('schema validation names the first mismatch and ignores absent optional fields', () => {
  const schema = {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: { notes: { type: 'string' }, title: { type: 'string' } },
          required: ['notes'],
        },
      },
    },
    required: ['items'],
  };
  assert.equal(schemaError(schema, { items: [{ notes: 'a', title: null }] }), null);
  assert.equal(schemaError(schema, {}), 'output.items is missing');
  assert.equal(schemaError(schema, { items: {} }), 'output.items must be an array');
  assert.equal(schemaError(schema, { items: [{}] }), 'output.items[0].notes is missing');
  assert.equal(
    schemaError(schema, { items: [{ notes: 1 }] }),
    'output.items[0].notes must be a string',
  );
});

test('summary calls run without tools or user settings; fact checks get only web tools', async (t) => {
  const root = tempRoot(t);
  const log = path.join(root, 'args.jsonl');
  fake(
    t,
    root,
    `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdin.resume(); process.stdin.on('end', () => console.log('**핵심**: ok'));`,
  );
  await runClaude('system', 'prompt');
  await runClaude('system', 'prompt', { tools: ['WebSearch', 'WebFetch'] });
  const [plain, web] = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  const value = (args, flag) => args[args.indexOf(flag) + 1];
  assert.equal(value(plain, '--tools'), '');
  assert.ok(!plain.includes('--allowedTools'));
  assert.equal(value(plain, '--setting-sources'), '');
  assert.ok(plain.includes('--strict-mcp-config'));
  assert.equal(value(web, '--tools'), 'WebSearch,WebFetch');
  assert.equal(value(web, '--allowedTools'), 'WebSearch,WebFetch');
});

test('a hung model call is killed at its timeout', async (t) => {
  const root = tempRoot(t);
  fake(t, root, 'setInterval(() => {}, 1000);');
  const started = Date.now();
  await assert.rejects(runClaude('s', 'p', { timeoutMs: 300 }), /timed out after 0.3s/);
  assert.ok(Date.now() - started < 5000);
});

test('topic summaries stay within four concurrent model calls', async (t) => {
  const root = tempRoot(t);
  const active = path.join(root, 'active');
  const peak = path.join(root, 'peak');
  fs.mkdirSync(active);
  // The router proposes eight topics in one window, so eight topic summaries are due at once.
  fake(
    t,
    root,
    `const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
const schema = args.includes('--json-schema') ? args[args.indexOf('--json-schema') + 1] : '';
const mine = path.join(${JSON.stringify(active)}, String(process.pid));
fs.writeFileSync(mine, '');
const now = fs.readdirSync(${JSON.stringify(active)}).length;
const before = Number(fs.existsSync(${JSON.stringify(peak)}) ? fs.readFileSync(${JSON.stringify(peak)}, 'utf8') : 0);
if (now > before) fs.writeFileSync(${JSON.stringify(peak)}, String(now));
process.stdin.resume();
process.stdin.on('end', () => setTimeout(() => {
  fs.rmSync(mine);
  if (schema.includes('topic_id')) {
    const items = Array.from({ length: 8 }, (_, i) => ({ topic_id: 'new', new_title: 'T' + i, new_category: '전체', notes: '- n', speakers: [], organizations: [] }));
    console.log(JSON.stringify({ structured_output: { items } }));
  } else if (schema.includes('bullets')) console.log(JSON.stringify({ structured_output: { core: 'c', bullets: [] } }));
  else console.log('**핵심**: s');
}, 300));`,
  );
  const dir = path.join(root, 'one');
  fs.mkdirSync(dir);
  writeJson(path.join(dir, 'meeting.json'), {
    profile: 'general',
    timeBasis: 'elapsed',
    complete: true,
    title: 't',
    subject: 't',
  });
  const { lines } = parseJsonl(
    '{"format":"assembly-parser.transcript","version":1}\n{"start":0,"text":"a"}',
  );
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), `${JSON.stringify(lines[0])}\n`);
  const child = spawn(process.execPath, ['src/summarize.js', 'one', '--data', root, '--once']);
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  const topics = fs.readdirSync(path.join(dir, 'topics')).filter((n) => n.endsWith('.json'));
  assert.equal(topics.length, 8);
  const max = Number(fs.readFileSync(peak, 'utf8'));
  assert.ok(max > 1 && max <= 4, `peak concurrency ${max}`);
});
