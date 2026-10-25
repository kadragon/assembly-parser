// The only model transport: the Claude Code CLI run as a subprocess.
import { spawn } from 'node:child_process';

export const MODEL = process.env.SUMMARY_MODEL || 'haiku';
// a hung CLI call would otherwise hold the summary loop forever
export const TIMEOUT_MS = 3 * 60_000;

// Small models occasionally add headings or <br> despite the prompt; the UI renders neither.
export function clean(text) {
  return text
    .split('\n')
    .filter((l) => !/^\s*#{1,6}\s/.test(l) && !/^\s*<br\s*\/?>\s*$/i.test(l) && !/^\s*```/.test(l))
    .join('\n')
    .trim();
}

/**
 * First mismatch between a value and the JSON schema subset our prompts use (object, array,
 * string, required), or null. Nothing reaches the output files until this passes.
 */
export function schemaError(schema, value, at = 'output') {
  if (schema.type === 'string') return typeof value === 'string' ? null : `${at} must be a string`;
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${at} must be an array`;
    for (const [i, item] of value.entries()) {
      const error = schemaError(schema.items, item, `${at}[${i}]`);
      if (error) return error;
    }
    return null;
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return `${at} must be an object`;
    for (const key of schema.required ?? [])
      if (value[key] === undefined || value[key] === null) return `${at}.${key} is missing`;
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      if (value[key] === undefined || value[key] === null) continue;
      const error = schemaError(property, value[key], `${at}.${key}`);
      if (error) return error;
    }
  }
  return null;
}

// In-flight `claude -p` calls, so the UI can show what is being summarized right now.
const jobs = new Map();
let nextJobId = 0;
let onJobsChange = () => {};
export const runningJobs = () => [...jobs.values()];
export function watchJobs(fn) {
  onJobsChange = fn;
}

function track(job, promise) {
  const id = nextJobId++;
  jobs.set(id, { job, since: Date.now() });
  onJobsChange();
  return promise.finally(() => {
    jobs.delete(id);
    onJobsChange();
  });
}

// Tools are disabled because the subtitle text is untrusted input; fact checks get
// read-only web tools only (nothing local to read, run or leak).
export function runClaude(
  system,
  prompt,
  { schema, job = '요약', model = MODEL, tools = [], timeoutMs = TIMEOUT_MS } = {},
) {
  return track(job, spawnClaude(system, prompt, schema, model, tools, timeoutMs));
}

const modelChildren = new Set();
export function stopModelChildren() {
  for (const child of modelChildren) child.kill('SIGKILL');
}

// Turn the two setup failures a new user hits into something they can act on.
function explain(error, detail = '') {
  if (error?.code === 'ENOENT')
    return new Error(
      'Claude Code CLI not found: install Claude Code and make sure `claude` is on PATH',
    );
  if (
    /not logged in|please log ?in|\/login|invalid api key|authenticat|unauthori[sz]ed/i.test(detail)
  )
    return new Error(`Claude Code is not signed in: run \`claude\` once and sign in (${detail})`);
  return null;
}

function spawnClaude(system, prompt, schema, model, tools, timeoutMs) {
  // isolate from the dev setup: no MCP servers, no user/project settings (so no installed plugins,
  // skills, hooks or CLAUDE.md), and no built-in skills either; ~2s less startup per call
  const args = [
    '-p',
    '--model',
    model,
    '--tools',
    tools.join(','),
    '--no-session-persistence',
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--disable-slash-commands',
    '--system-prompt',
    system,
  ];
  if (tools.length) args.push('--allowedTools', tools.join(','));
  if (schema) args.push('--output-format', 'json', '--json-schema', JSON.stringify(schema));
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    modelChildren.add(child);
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    // a CLI that exits before reading the prompt must not crash the worker with EPIPE
    child.stdin.on('error', () => {});
    child.on('error', (e) => {
      modelChildren.delete(child);
      clearTimeout(timer);
      reject(explain(e) ?? e);
    });
    child.on('close', (code) => {
      modelChildren.delete(child);
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`claude timed out after ${timeoutMs / 1000}s`));
      if (code !== 0) {
        const detail = (err || out).trim();
        return reject(explain(null, detail) ?? new Error(`claude exited ${code}: ${detail}`));
      }
      if (!schema) return resolve(clean(out));
      try {
        const envelope = JSON.parse(out);
        if (envelope.is_error || !envelope.structured_output)
          throw (
            explain(null, envelope.result ?? '') ??
            new Error(envelope.result || 'no structured output')
          );
        const error = schemaError(schema, envelope.structured_output);
        if (error) throw new Error(error);
        resolve(envelope.structured_output);
      } catch (e) {
        reject(new Error(`bad structured output: ${e.message}`));
      }
    });
    child.stdin.end(prompt);
  });
}
