import { createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

import { readPrivateFile, writePrivateFile } from './privateFiles';

export const DEVICE_TOKENS_FILE = 'device-tokens.json';

const FORMAT_VERSION = 1;

export function deviceTokensPath(homeDir: string): string {
  return join(homeDir, 'server', 'auth', DEVICE_TOKENS_FILE);
}

export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

interface DeviceTokensFormat {
  readonly version: number;
  readonly hashes: readonly string[];
}

export interface DeviceTokenStore {
  readonly path: string;
  has(candidate: string): boolean;
  add(token: string): Promise<void>;
  revoke(candidate: string): Promise<boolean>;
  dispose(): Promise<void>;
}

export async function createDeviceTokenStore(homeDir: string): Promise<DeviceTokenStore> {
  const path = deviceTokensPath(homeDir);
  const hashes = new Set<string>(await loadHashes(path));

  let writeQueue: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    const snapshot: DeviceTokensFormat = { version: FORMAT_VERSION, hashes: [...hashes] };
    const write = writeQueue.then(() =>
      writePrivateFile(path, `${JSON.stringify(snapshot, undefined, 2)}\n`),
    );
    writeQueue = write.catch(() => {});
    return write;
  };

  return {
    path,
    has: (candidate) => matches(hashDeviceToken(candidate), hashes),
    add: async (token) => {
      hashes.add(hashDeviceToken(token));
      await persist();
    },
    revoke: async (candidate) => {
      const digest = hashDeviceToken(candidate);
      if (!matches(digest, hashes)) return false;
      hashes.delete(digest);
      await persist();
      return true;
    },
    dispose: () => writeQueue,
  };
}

function matches(digest: string, hashes: ReadonlySet<string>): boolean {
  const candidateBuf = Buffer.from(digest);
  for (const hash of hashes) {
    const storedBuf = Buffer.from(hash);
    if (storedBuf.length === candidateBuf.length && timingSafeEqual(storedBuf, candidateBuf)) {
      return true;
    }
  }
  return false;
}

async function loadHashes(path: string): Promise<readonly string[]> {
  let raw: Buffer;
  try {
    raw = await readPrivateFile(path);
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as Partial<DeviceTokensFormat>;
    if (parsed.version !== FORMAT_VERSION || !Array.isArray(parsed.hashes)) return [];
    return parsed.hashes.filter((hash): hash is string => typeof hash === 'string' && hash.length > 0);
  } catch {
    return [];
  }
}
