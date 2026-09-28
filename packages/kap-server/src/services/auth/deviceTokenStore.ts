import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ulid } from 'ulid';

import { writePrivateFile, PrivateFileTooPermissiveError } from './privateFiles';
import { withPrivateFileLock } from './privateFileLock';

export const DEVICE_TOKENS_FILE = 'device-tokens.json';

const FORMAT_VERSION = 2;
const V1_FORMAT_VERSION = 1;

export function deviceTokensPath(homeDir: string): string {
  return join(homeDir, 'server', 'auth', DEVICE_TOKENS_FILE);
}

export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

export interface DeviceTokenRecord {
  readonly id: string;
  readonly createdAt: string;
}

interface DeviceTokenEntry {
  readonly id: string;
  readonly hash: string;
  readonly createdAt: string;
}

interface DeviceTokensFormat {
  readonly version: number;
  readonly devices: readonly DeviceEntryDisk[];
}

interface DeviceEntryDisk {
  readonly id: string;
  readonly hash: string;
  readonly created_at: string;
}

interface LegacyTokensFormat {
  readonly version: number;
  readonly hashes: readonly string[];
}

interface DiskState {
  readonly entries: readonly DeviceTokenEntry[];
  readonly fromVersion: number;
}

export interface DeviceTokenStore {
  readonly path: string;
  has(candidate: string): boolean;
  find(candidate: string): DeviceTokenRecord | undefined;
  list(): DeviceTokenRecord[];
  add(token: string): Promise<string>;
  revoke(candidate: string): Promise<boolean>;
  revokeById(deviceId: string): Promise<boolean>;
  dispose(): Promise<void>;
}

export async function createDeviceTokenStore(homeDir: string): Promise<DeviceTokenStore> {
  const path = deviceTokensPath(homeDir);
  let cache:
    | { readonly ino: number; readonly mtimeMs: number; readonly entries: readonly DeviceTokenEntry[] }
    | undefined;

  const digestEquals = (a: string, b: string): boolean => {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  };

  const freshId = (): string => `dev_${ulid()}`;

  const toRecord = (entry: DeviceTokenEntry): DeviceTokenRecord => ({
    id: entry.id,
    createdAt: entry.createdAt,
  });

  const parseDisk = (raw: string): DiskState => {
    try {
      const parsed = JSON.parse(raw) as Partial<DeviceTokensFormat & LegacyTokensFormat>;
      if (parsed.version === FORMAT_VERSION && Array.isArray(parsed.devices)) {
        const entries = parsed.devices
          .filter(
            (device): device is DeviceEntryDisk =>
              device !== null &&
              typeof device === 'object' &&
              typeof device.id === 'string' &&
              device.id.length > 0 &&
              typeof device.hash === 'string' &&
              device.hash.length > 0 &&
              typeof device.created_at === 'string',
          )
          .map((device) => ({ id: device.id, hash: device.hash, createdAt: device.created_at }));
        return { entries, fromVersion: FORMAT_VERSION };
      }
      if (parsed.version === V1_FORMAT_VERSION && Array.isArray(parsed.hashes)) {
        const createdAt = new Date().toISOString();
        const entries = parsed.hashes
          .filter((hash): hash is string => typeof hash === 'string' && hash.length > 0)
          .map((hash) => ({ id: freshId(), hash, createdAt }));
        return { entries, fromVersion: V1_FORMAT_VERSION };
      }
    } catch {
    }
    return { entries: [], fromVersion: 0 };
  };

  const freshDiskState = (): DiskState => {
    try {
      const st = statSync(path);
      if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
        return { entries: [], fromVersion: 0 };
      }
      return parseDisk(readFileSync(path).toString('utf8'));
    } catch {
      return { entries: [], fromVersion: 0 };
    }
  };

  const cachedEntries = (): readonly DeviceTokenEntry[] => {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        cache = undefined;
        return [];
      }
      return cache?.entries ?? [];
    }
    if (cache !== undefined && cache.ino === st.ino && cache.mtimeMs === st.mtimeMs) {
      return cache.entries;
    }
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
      cache = undefined;
      return [];
    }
    let raw: Buffer;
    try {
      raw = readFileSync(path);
    } catch {
      cache = undefined;
      return [];
    }
    const { entries } = parseDisk(raw.toString('utf8'));
    cache = { ino: st.ino, mtimeMs: st.mtimeMs, entries };
    return entries;
  };

  const serialize = (entries: readonly DeviceTokenEntry[]): string =>
    `${JSON.stringify(
      {
        version: FORMAT_VERSION,
        devices: entries.map((entry) => ({
          id: entry.id,
          hash: entry.hash,
          created_at: entry.createdAt,
        })),
      },
      undefined,
      2,
    )}\n`;

  let tail: Promise<unknown> = Promise.resolve();
  const assertWritableStore = (): void => {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
      throw new PrivateFileTooPermissiveError(path, st.mode & 0o777);
    }
  };
  const mutate = <T>(
    apply: (
      entries: readonly DeviceTokenEntry[],
    ) => { entries: readonly DeviceTokenEntry[]; result: T; changed: boolean },
  ): Promise<T> => {
    const run = tail.then(() =>
      withPrivateFileLock(path, async () => {
        assertWritableStore();
        const applied = apply(freshDiskState().entries);
        if (applied.changed) {
          await writePrivateFile(path, serialize(applied.entries));
          cache = undefined;
        }
        return applied.result;
      }),
    );
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  if (freshDiskState().fromVersion === V1_FORMAT_VERSION) {
    await withPrivateFileLock(path, async () => {
      const current = freshDiskState();
      if (current.fromVersion !== V1_FORMAT_VERSION) return;
      await writePrivateFile(path, serialize(current.entries));
      cache = undefined;
    });
  }

  return {
    path,
    has: (candidate) => {
      const digest = hashDeviceToken(candidate);
      return cachedEntries().some((entry) => digestEquals(entry.hash, digest));
    },
    find: (candidate) => {
      const digest = hashDeviceToken(candidate);
      const entry = cachedEntries().find((other) => digestEquals(other.hash, digest));
      return entry === undefined ? undefined : toRecord(entry);
    },
    list: () => cachedEntries().map(toRecord),
    add: (token) => {
      const digest = hashDeviceToken(token);
      return mutate((entries) => {
        const existing = entries.find((entry) => digestEquals(entry.hash, digest));
        if (existing !== undefined) return { entries, result: existing.id, changed: false };
        const entry: DeviceTokenEntry = {
          id: freshId(),
          hash: digest,
          createdAt: new Date().toISOString(),
        };
        return { entries: [...entries, entry], result: entry.id, changed: true };
      });
    },
    revoke: (candidate) => {
      const digest = hashDeviceToken(candidate);
      return mutate((entries) => {
        if (!entries.some((entry) => digestEquals(entry.hash, digest))) {
          return { entries, result: false, changed: false };
        }
        return {
          entries: entries.filter((entry) => !digestEquals(entry.hash, digest)),
          result: true,
          changed: true,
        };
      });
    },
    revokeById: (deviceId) =>
      mutate((entries) => {
        if (!entries.some((entry) => entry.id === deviceId)) {
          return { entries, result: false, changed: false };
        }
        return { entries: entries.filter((entry) => entry.id !== deviceId), result: true, changed: true };
      }),
    dispose: () => tail.then(() => undefined),
  };
}
