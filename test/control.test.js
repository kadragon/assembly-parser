import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateConfig, validatePort } from '../src/control.js';
import { parsePlayerUrl } from '../src/meeting.js';
import { acquireLock } from '../src/ownership.js';
import { meetingDir } from '../src/store.js';

test('control inputs reject foreign URLs, paths and invalid configuration', () => {
  for (const url of [
    'https://evil.test/main/player.asp?xcode=1&xcgcd=2',
    'https://assembly.webcast.go.kr/other?xcode=1&xcgcd=2',
    'https://assembly.webcast.go.kr/main/player.asp?xcode=1&xcgcd=../x',
  ])
    assert.throws(() => parsePlayerUrl(url));
  for (const id of ['../x', '/tmp/x', '.', 'a/b']) assert.throws(() => meetingDir(id));
  for (const windowMinutes of [0, -1, 7, 1.5, Infinity, '5'])
    assert.throws(() => validateConfig({ windowMinutes }));
  for (const port of ['0', '65536', 'abc', '3.5']) assert.throws(() => validatePort(port));
  assert.equal(validateConfig({ focus: '$(touch pwn);`x`' }).focus, '$(touch pwn);`x`');
});

test('writer ownership rejects duplicate writers and releases only its own lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assembly-lock-'));
  try {
    const release = acquireLock(dir, 'collector');
    assert.throws(() => acquireLock(dir, 'collector'), /already/);
    const summary = acquireLock(dir, 'summarizer');
    summary();
    release();
    acquireLock(dir, 'collector')();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dead owner recovery cannot leave a duplicate owner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assembly-stale-'));
  try {
    const lock = path.join(dir, '.collector.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, '99999999-dead'), '99999999');
    const release = acquireLock(dir, 'collector');
    assert.equal(fs.readdirSync(lock).length, 1);
    assert.throws(() => acquireLock(dir, 'collector'), /already/);
    release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('official legacy player URL forms normalize without allowing foreign origins', () => {
  for (const url of [
    'http://assembly.webcast.go.kr/main/player.asp?xcode=58&xcgcd=one',
    'https://www.assembly.webcast.go.kr/main/player.asp?xcode=58&xcgcd=one#player',
  ])
    assert.deepEqual(parsePlayerUrl(url), { xcode: '58', xcgcd: 'one' });
});
