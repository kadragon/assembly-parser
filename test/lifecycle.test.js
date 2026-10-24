import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collect } from '../src/collector.js';
import { alive } from '../src/ownership.js';
import { writeJson } from '../src/store.js';
import { windowStart } from '../src/transcript.js';

test('stop cancels a queued reconnect and ignores late socket events', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sockets = [];
  class Socket extends EventTarget {
    constructor() {
      super();
      sockets.push(this);
    }
    close() {
      this.dispatchEvent(new Event('close'));
    }
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  t.after(() => {
    globalThis.WebSocket = original;
  });
  let lines = 0;
  const stop = collect('wss://fixture.test', { onLine: () => lines++, log: () => {} });
  sockets[0].close();
  stop();
  sockets[0].dispatchEvent(new Event('open'));
  sockets[0].dispatchEvent(
    new MessageEvent('message', {
      data: JSON.stringify({ segment: 1, final: true, transcript: 'late' }),
    }),
  );
  t.mock.timers.tick(130000);
  assert.equal(sockets.length, 1);
  assert.equal(lines, 0);
});

async function run(args, env) {
  const child = spawn(process.execPath, ['src/summarize.js', ...args], { env });
  let output = '';
  child.stderr.on('data', (data) => {
    output += data;
  });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, output);
}

test('real summary CLI finalizes current partial window and leaves unchanged output alone', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assembly-finalize-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'one');
  fs.mkdirSync(dir);
  writeJson(path.join(dir, 'meeting.json'), { committee: 'Synthetic', subject: 'Fixture' });
  const ts = Date.now();
  fs.writeFileSync(
    path.join(dir, 'transcript.jsonl'),
    `${JSON.stringify({ key: 'one', ts, text: 'Synthetic final caption' })}\n`,
  );
  // Exercise the actual CLI transport using an executable fake Claude, never credentials.
  fs.writeFileSync(
    path.join(root, 'claude'),
    `#!/usr/bin/env node\nconst fs=require('node:fs'); fs.appendFileSync(process.env.CALL_LOG,'call\\n'); process.stdin.resume(); process.stdin.on('end',()=>console.log(process.argv.includes('--json-schema') ? JSON.stringify({structured_output:{items:[]}}) : '**핵심** 합성 요약'));\n`,
    { mode: 0o755 },
  );
  const log = path.join(root, 'calls');
  const env = {
    ...process.env,
    PATH: `${root}${path.delimiter}${process.env.PATH}`,
    CALL_LOG: log,
  };
  const args = ['one', '--data', root, '--once'];
  await run(args, env);
  assert.equal(fs.existsSync(log), false);
  await run([...args, '--finalize'], env);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.ok(state.windows[windowStart(ts, 300000)].summary);
  assert.equal(state.windows[windowStart(ts, 300000)].routed, true);
  assert.equal(state.finalizedThrough, windowStart(ts, 300000) + 300000);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 2);
  await run([...args, '--finalize'], env);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 2);
});

test('summary termination kills active model children and frees writer ownership', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assembly-model-stop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'one');
  fs.mkdirSync(dir);
  writeJson(path.join(dir, 'meeting.json'), { committee: 'Synthetic', subject: 'Fixture' });
  fs.writeFileSync(
    path.join(dir, 'transcript.jsonl'),
    `${JSON.stringify({ key: 'one', ts: 1, text: 'Synthetic caption' })}\n`,
  );
  fs.writeFileSync(
    path.join(root, 'claude'),
    `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(process.env.PID_LOG,process.pid+'\\n'); setInterval(()=>{},1000);\n`,
    { mode: 0o755 },
  );
  const log = path.join(root, 'pids');
  const child = spawn(process.execPath, ['src/summarize.js', 'one', '--data', root, '--once'], {
    env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}`, PID_LOG: log },
  });
  t.after(() => child.kill('SIGKILL'));
  const deadline = Date.now() + 5000;
  while (
    (!fs.existsSync(log) || fs.readFileSync(log, 'utf8').trim().split('\n').length < 2) &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(log));
  const pids = fs.readFileSync(log, 'utf8').trim().split('\n').map(Number);
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(pids.every((pid) => !alive(pid)));
  assert.equal(fs.existsSync(path.join(dir, '.summarizer.lock')), false);
});
