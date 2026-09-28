import { randomBytes } from 'node:crypto';
import { link, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const LOCK_WAIT_BUDGET_MS = 5_000;
const LOCK_BASE_BACKOFF_MS = 5;
const LOCK_MAX_BACKOFF_MS = 100;
const SETTLE_BASE_MS = 15;
const SETTLE_MAX_MS = 1_000;

export class PrivateFileLockBusyError extends Error {
  readonly code = 'EPRIVATE_FILE_LOCK_BUSY';

  constructor(readonly lockPath: string) {
    super(`private file lock is still held by a live owner: ${lockPath}`);
    this.name = 'PrivateFileLockBusyError';
  }
}

export interface PrivateFileLockHooks {
  beforeStaleTakeoverRename?: () => Promise<void>;
}

interface LockHolder {
  readonly pid: number;
  readonly nonce: string;
}

type AttemptOutcome = 'held' | 'lost' | 'busy';

export function privateFileLockPath(dataPath: string): string {
  return `${dataPath}.lock`;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readHolder(lockPath: string): Promise<LockHolder | undefined> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockHolder>;
    if (typeof parsed.pid === 'number' && typeof parsed.nonce === 'string') {
      return { pid: parsed.pid, nonce: parsed.nonce };
    }
  } catch {
  }
  return { pid: 0, nonce: '' };
}

async function publishLock(lockPath: string, nonce: string): Promise<boolean> {
  const tmp = `${lockPath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    await writeFile(tmp, JSON.stringify({ pid: process.pid, nonce }));
    try {
      await link(tmp, lockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

function isLiveHolder(holder: LockHolder | undefined, nonce: string): boolean {
  return holder !== undefined && holder.nonce !== nonce && pidAlive(holder.pid);
}

async function takeOverStaleLock(
  lockPath: string,
  nonce: string,
  hooks: PrivateFileLockHooks | undefined,
): Promise<boolean> {
  const bid = `${lockPath}.bid.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    await writeFile(bid, JSON.stringify({ pid: process.pid, nonce }));
    if (!isStaleHolder(await readHolder(lockPath), nonce)) return false;
    await hooks?.beforeStaleTakeoverRename?.();
    if (!isStaleHolder(await readHolder(lockPath), nonce)) return false;
    try {
      await rename(bid, lockPath);
      return true;
    } catch {
      return false;
    }
  } finally {
    await unlink(bid).catch(() => {});
  }
}

function isStaleHolder(holder: LockHolder | undefined, nonce: string): boolean {
  return holder !== undefined && holder.nonce !== nonce && !pidAlive(holder.pid);
}

async function hasLiveForeignWatch(dir: string, base: string, watchPath: string): Promise<boolean> {
  const prefix = `${base}.watch-`;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.startsWith(prefix)) continue;
    const candidate = join(dir, name);
    if (candidate === watchPath) continue;
    let pid: number | undefined;
    try {
      pid = (JSON.parse(await readFile(candidate, 'utf8')) as { pid?: number }).pid;
    } catch {
      pid = undefined;
    }
    if (pidAlive(pid ?? 0)) return true;
    await unlink(candidate).catch(() => {});
  }
  return false;
}

async function releaseLock(lockPath: string, nonce: string): Promise<void> {
  const holder = await readHolder(lockPath);
  if (holder === undefined || holder.nonce !== nonce) return;
  await unlink(lockPath).catch(() => {});
}

export async function withPrivateFileLock<T>(
  dataPath: string,
  fn: () => Promise<T>,
  hooks?: PrivateFileLockHooks,
): Promise<T> {
  const lockPath = privateFileLockPath(dataPath);
  const dir = dirname(lockPath);
  const base = basename(lockPath);
  const deadline = Date.now() + LOCK_WAIT_BUDGET_MS;
  let backoff = LOCK_BASE_BACKOFF_MS;

  for (;;) {
    const nonce = randomBytes(8).toString('hex');
    const watchPath = join(dir, `${base}.watch-${process.pid}.${randomBytes(4).toString('hex')}`);
    let outcome: AttemptOutcome;
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const watchTmp = `${watchPath}.tmp.${randomBytes(4).toString('hex')}`;
      await writeFile(watchTmp, JSON.stringify({ pid: process.pid, nonce }));
      await link(watchTmp, watchPath).catch(async (error) => {
        await unlink(watchTmp).catch(() => {});
        throw error;
      });
      await unlink(watchTmp).catch(() => {});

      outcome = await attemptLock(lockPath, nonce, watchPath, dir, base, deadline, hooks);
    } finally {
      await unlink(watchPath).catch(() => {});
    }

    if (outcome === 'held') {
      try {
        return await fn();
      } finally {
        await releaseLock(lockPath, nonce);
      }
    }
    if (outcome === 'busy') {
      if (Date.now() >= deadline) throw new PrivateFileLockBusyError(lockPath);
      await delay(backoff + Math.floor(Math.random() * backoff));
      backoff = Math.min(backoff * 2, LOCK_MAX_BACKOFF_MS);
    }
  }
}

async function attemptLock(
  lockPath: string,
  nonce: string,
  watchPath: string,
  dir: string,
  base: string,
  deadline: number,
  hooks: PrivateFileLockHooks | undefined,
): Promise<AttemptOutcome> {
  for (;;) {
    const published = await publishLock(lockPath, nonce);
    if (!published && isLiveHolder(await readHolder(lockPath), nonce)) {
      return 'busy';
    }
    if (!published && !(await takeOverStaleLock(lockPath, nonce, hooks))) {
      if (Date.now() >= deadline) throw new PrivateFileLockBusyError(lockPath);
      await delay(LOCK_BASE_BACKOFF_MS);
      continue;
    }

    let settleMs = SETTLE_BASE_MS;
    for (;;) {
      await delay(settleMs);
      const holder = await readHolder(lockPath);
      if (holder === undefined || holder.nonce !== nonce) return 'lost';
      if (!(await hasLiveForeignWatch(dir, base, watchPath))) {
        if (holder.nonce !== nonce) return 'lost';
        return 'held';
      }
      if (Date.now() >= deadline) {
        await releaseLock(lockPath, nonce);
        throw new PrivateFileLockBusyError(lockPath);
      }
      settleMs = Math.min(settleMs * 2, SETTLE_MAX_MS);
    }
  }
}
