import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
function removeOwner(lock, owner) {
  try {
    fs.unlinkSync(path.join(lock, owner));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    fs.rmdirSync(lock);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}
// Publish an already populated directory atomically. A competing rename cannot
// replace a live, nonempty lock. Recovery deletes only the observed dead owner's
// unique file; rmdir cannot remove a replacement owner's populated directory.
export function acquireLock(dir, role) {
  const lock = path.join(dir, `.${role}.lock`);
  const owner = `${process.pid}-${randomUUID()}`;
  const candidate = `${lock}-${owner}`;
  fs.mkdirSync(candidate);
  fs.writeFileSync(path.join(candidate, owner), String(process.pid));
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.renameSync(candidate, lock);
        let released = false;
        return () => {
          if (!released) {
            released = true;
            removeOwner(lock, owner);
          }
        };
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
        const owners = fs.readdirSync(lock);
        if (owners.length !== 1 || !/^\d+-[a-f0-9-]+$/.test(owners[0]))
          throw new Error(`${role} already owned (unknown lock): ${lock}`);
        const pid = Number(owners[0].split('-')[0]);
        if (!pid || alive(pid)) throw new Error(`${role} already owned by process ${pid}`);
        removeOwner(lock, owners[0]);
      }
    }
    throw new Error(`${role} ownership changed; retry`);
  } finally {
    fs.rmSync(candidate, { recursive: true, force: true });
  }
}

export function workerLock(dir, role) {
  if (process.env.ASSEMBLY_OWNER_PID === String(process.ppid) && process.connected) {
    const lock = path.join(dir, `.${role}.lock`);
    const owners = fs.readdirSync(lock);
    if (owners.length === 1 && owners[0].startsWith(`${process.ppid}-`)) return () => {};
  }
  return acquireLock(dir, role);
}
