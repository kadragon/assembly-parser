import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiSubtitleUrl, fetchMeeting, parsePlayerUrl } from './meeting.js';
import { acquireLock } from './ownership.js';
import { files, meetingDir, readJson, writeJson } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export function validatePort(value) {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535)
    throw new Error('Port must be an integer from 1 to 65535');
  return Number(value);
}
export function validateConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid configuration');
  for (const key of Object.keys(input))
    if (!['windowMinutes', 'focus', 'focusKeywords', 'focusNote'].includes(key))
      throw new Error(`Unknown setting: ${key}`);
  const windowMinutes = input.windowMinutes ?? 5;
  if (!Number.isInteger(windowMinutes) || windowMinutes <= 0 || 60 % windowMinutes !== 0)
    throw new Error('Window must be a positive integer dividing 60');
  const config = { windowMinutes };
  for (const key of ['focus', 'focusKeywords', 'focusNote']) {
    const value = input[key] ?? '';
    if (typeof value !== 'string' || value.length > 2000 || value.includes('\0'))
      throw new Error(`Invalid ${key}`);
    config[key] = value.trim();
  }
  if (!config.focus && (config.focusKeywords || config.focusNote))
    throw new Error('Focus name is required for keywords or scope notes');
  return config;
}

export class Sessions {
  constructor(
    root,
    {
      resolveMeeting = fetchMeeting,
      worker = (role) => path.join(here, role === 'collector' ? 'collect.js' : 'summarize.js'),
      interval = 30000,
    } = {},
  ) {
    this.root = path.resolve(root);
    this.resolveMeeting = resolveMeeting;
    this.worker = worker;
    this.entries = new Map();
    this.pending = [];
    this.summary = null;
    this.closing = false;
    this.chain = Promise.resolve();
    this.timer = setInterval(() => {
      for (const entry of this.entries.values())
        if (entry.collector && entry.state.summary === 'idle') this.enqueue(entry);
    }, interval);
  }
  serial(fn) {
    const run = this.chain.then(() => {
      if (this.closing) throw new Error('Server is stopping');
      return fn();
    });
    this.chain = run.catch(() => {});
    return run;
  }
  dir(id) {
    return meetingDir(id, this.root);
  }
  load(id) {
    if (this.entries.has(id)) return this.entries.get(id);
    const dir = this.dir(id);
    const meeting = readJson(files(dir).meeting);
    if (!meeting) throw new Error('Session not found');
    const saved = readJson(path.join(dir, 'session.json'));
    const entry = {
      id,
      dir,
      meeting,
      config: saved?.config ?? null,
      state: saved?.state ?? { collection: 'stopped', summary: 'idle' },
      collector: null,
      summarizer: null,
    };
    if (['running', 'starting'].includes(entry.state.collection)) {
      entry.state.collection = 'interrupted';
      entry.state.missedSince = entry.state.lastObservedAt ?? entry.state.startedAt;
    }
    if (['running', 'queued'].includes(entry.state.summary)) entry.state.summary = 'interrupted';
    this.entries.set(id, entry);
    return entry;
  }
  view(entry) {
    return { id: entry.id, meeting: entry.meeting, config: entry.config, ...entry.state };
  }
  list() {
    if (!fs.existsSync(this.root)) return [];
    return fs
      .readdirSync(this.root, { withFileTypes: true })
      .filter(
        (d) =>
          d.isDirectory() &&
          !d.name.startsWith('.') &&
          fs.existsSync(path.join(this.root, d.name, 'meeting.json')),
      )
      .map((d) => this.view(this.load(d.name)));
  }
  save(entry) {
    writeJson(path.join(entry.dir, 'session.json'), { config: entry.config, state: entry.state });
  }
  async start(input) {
    if (
      !input ||
      typeof input !== 'object' ||
      Object.keys(input).some((k) => !['url', 'config'].includes(k))
    )
      throw new Error('Invalid start payload');
    if (typeof input.url !== 'string' || input.url.length > 2048)
      throw new Error('Invalid player URL');
    const ids = parsePlayerUrl(input.url);
    const config = validateConfig(input.config);
    const dir = this.dir(ids.xcgcd);
    const existing = fs.existsSync(files(dir).meeting) ? this.load(ids.xcgcd) : null;
    if (existing?.config && JSON.stringify(config) !== JSON.stringify(existing.config))
      throw new Error('Saved settings differ; rebuilding is not available yet');
    if (existing && !existing.config && fs.existsSync(files(dir).state))
      throw new Error('Legacy summaries are read-only until rebuild support is available');
    if (existing?.collector) return this.view(existing);
    const meeting = await this.resolveMeeting(ids);
    if (
      meeting.xcode !== ids.xcode ||
      meeting.xcgcd !== ids.xcgcd ||
      typeof meeting.committee !== 'string' ||
      typeof meeting.subject !== 'string' ||
      !meeting.live
    )
      throw new Error('Meeting metadata does not identify a live broadcast');
    aiSubtitleUrl(meeting.smiServer);
    fs.mkdirSync(dir, { recursive: true });
    const release = acquireLock(dir, 'collector');
    let summaryRelease;
    try {
      summaryRelease = acquireLock(dir, 'summarizer');
    } catch (error) {
      release();
      throw error;
    }
    const entry = existing ?? { id: ids.xcgcd, dir, state: {}, collector: null, summarizer: null };
    entry.meeting = meeting;
    entry.config = config;
    entry.summaryRelease = summaryRelease;
    entry.url = input.url;
    if (entry.state.stoppedAt || entry.state.missedSince)
      entry.state.gap = { from: entry.state.missedSince ?? entry.state.stoppedAt, to: Date.now() };
    entry.state.collection = 'running';
    entry.state.summary = 'idle';
    entry.state.startedAt = Date.now();
    entry.state.lastObservedAt = Date.now();
    delete entry.state.collectionError;
    delete entry.state.summaryError;
    this.entries.set(entry.id, entry);
    try {
      writeJson(files(dir).meeting, meeting);
      this.save(entry);
      entry.collector = this.launch(entry, 'collector', [input.url, '--data', this.root], release);
      this.enqueue(entry);
    } catch (error) {
      release();
      summaryRelease();
      throw error;
    }
    return this.view(entry);
  }
  launch(entry, role, args, release = () => {}) {
    const child = spawn(process.execPath, [this.worker(role), ...args], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, ASSEMBLY_OWNER_PID: String(process.pid) },
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (data) => {
        output = (output + data).slice(-4000);
      });
    let done = false;
    child.finished = new Promise((resolve) => {
      const finish = (code, error) => {
        if (done) return;
        done = true;
        release();
        entry[role] = null;
        const field = role === 'collector' ? 'collection' : 'summary';
        if (child.stopping) entry.state[field] = 'stopped';
        else if (error || code !== 0) {
          entry.state[field] = 'error';
          entry.state[`${field}Error`] = error?.message ?? (output || `Worker exited ${code}`);
        } else
          entry.state[field] =
            role === 'collector' ? 'stopped' : entry.finalizing ? 'complete' : 'idle';
        if (role === 'collector') {
          entry.state.stoppedAt = Date.now();
          entry.state.missedSince = Date.now();
        }
        if (role === 'summarizer') {
          this.summary = null;
          if (!entry.collector) {
            entry.summaryRelease?.();
            entry.summaryRelease = null;
          }
        }
        this.save(entry);
        resolve();
        if (!this.closing) this.drain();
      };
      child.on('error', (error) => finish(null, error));
      child.on('close', (code) => finish(code));
    });
    return child;
  }
  enqueue(entry, finalizing = false) {
    if (entry.summarizer || this.pending.includes(entry) || this.closing) return;
    entry.finalizing = finalizing;
    entry.state.summary = 'queued';
    this.pending.push(entry);
    this.save(entry);
    this.drain();
  }
  drain() {
    if (this.summary || this.closing) return;
    const entry = this.pending.shift();
    if (!entry) return;
    try {
      entry.summaryRelease ??= acquireLock(entry.dir, 'summarizer');
      const c = entry.config;
      const args = [entry.id, '--data', this.root, '--window', String(c.windowMinutes), '--once'];
      if (c.focus)
        args.push(
          '--focus',
          c.focus,
          '--focus-keywords',
          c.focusKeywords || c.focus,
          '--focus-note',
          c.focusNote,
        );
      if (entry.finalizing) args.push('--finalize');
      entry.state.summary = 'running';
      delete entry.state.summaryError;
      this.save(entry);
      entry.summarizer = this.launch(entry, 'summarizer', args);
      this.summary = entry;
    } catch (error) {
      entry.state.summary = 'error';
      entry.state.summaryError = error.message;
      this.save(entry);
      this.drain();
    }
  }
  async kill(child) {
    if (!child) return;
    if (!child.pid) {
      await child.finished;
      return;
    }
    child.stopping = true;
    const signal = (sig) => {
      try {
        if (process.platform === 'win32') child.kill(sig);
        else process.kill(-child.pid, sig);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    };
    signal('SIGTERM');
    const timer = setTimeout(() => signal('SIGKILL'), 1500);
    await child.finished;
    clearTimeout(timer);
    // Descendants may outlive the direct child; kill the remaining process group.
    signal('SIGKILL');
  }
  async action(id, action) {
    const entry = this.load(id);
    if (action === 'resume') {
      if (!entry.config) throw new Error('Use URL entry to configure this session');
      return this.start({
        url: `https://assembly.webcast.go.kr/main/player.asp?xcode=${encodeURIComponent(entry.meeting.xcode)}&xcgcd=${encodeURIComponent(id)}`,
        config: entry.config,
      });
    }
    if (action === 'stop') {
      this.pending = this.pending.filter((e) => e !== entry);
      await this.kill(entry.collector);
      await this.kill(entry.summarizer);
      entry.summaryRelease?.();
      entry.summaryRelease = null;
      entry.state.collection = 'stopped';
      entry.state.summary = 'stopped';
      entry.state.stoppedAt = Date.now();
      entry.state.missedSince = Date.now();
      this.save(entry);
    } else if (action === 'retry' || action === 'finalize') {
      if (!entry.config) throw new Error('Legacy session cannot be reconfigured yet');
      if (action === 'finalize' && entry.collector)
        throw new Error('Stop collection before finalizing');
      this.enqueue(entry, action === 'finalize');
    } else throw new Error('Unknown action');
    return this.view(entry);
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    await this.chain;
    this.pending = [];
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        await this.kill(entry.collector);
        await this.kill(entry.summarizer);
        entry.summaryRelease?.();
        entry.summaryRelease = null;
      }),
    );
  }
}
