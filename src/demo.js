#!/usr/bin/env node
// Serve the committed, precomputed demo from a temporary copy, so viewing it needs no
// Claude credentials or live broadcast and nothing done in the browser touches demo/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startApp } from './app.js';
import { validatePort } from './control.js';

export const DEMO_SESSIONS = fileURLToPath(new URL('../demo/sessions/', import.meta.url));

export async function startDemo(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assembly-parser-demo-'));
  try {
    fs.cpSync(DEMO_SESSIONS, root, { recursive: true });
    const app = await startApp({ ...options, root });
    const close = app.close;
    return {
      ...app,
      root,
      close: async () => {
        try {
          await close();
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { port: { type: 'string', default: '3000' } } });
    const app = await startDemo({ port: validatePort(values.port) });
    console.log(`Demo sessions: ${app.origin}`);
    console.log(`Temporary data (removed on exit): ${app.root}`);
    const shutdown = () => {
      app.close().then(
        () => process.exit(0),
        (error) => {
          console.error(error.message);
          process.exit(1);
        },
      );
    };
    // closing the terminal sends SIGHUP; the temporary copy must not outlive it either
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, shutdown);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
