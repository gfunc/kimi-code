import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PrivateFileTooPermissiveError,
  readPrivateFile,
  writePrivateFile,
} from '../src/services/auth/privateFiles';
import {
  loadOrCreateServerToken,
  rotateServerToken,
} from '../src/services/auth/persistentToken';
import { createTokenStore } from '../src/services/auth/tokenStore';
import {
  createDeviceTokenStore,
  deviceTokensPath,
  hashDeviceToken,
} from '../src/services/auth/deviceTokenStore';
import {
  withPrivateFileLock,
  type PrivateFileLockHooks,
} from '../src/services/auth/privateFileLock';
import { createAuthTokenService } from '../src/services/auth/authTokenService';
import { resolvePasswordHash, verifyPassword } from '../src/services/auth/password';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-v2-auth-token-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('privateFiles', () => {
  it.skipIf(process.platform === 'win32')('writes a file with mode 0600', async () => {
    const p = join(tmpDir, 'secret');
    await writePrivateFile(p, 'hello');
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('creates an absent parent dir with mode 0700', async () => {
    const p = join(tmpDir, 'nested', 'dir', 'secret');
    await writePrivateFile(p, 'hello');
    expect(statSync(join(tmpDir, 'nested', 'dir')).mode & 0o777).toBe(0o700);
  });

  it('round-trips string content through readPrivateFile', async () => {
    const p = join(tmpDir, 'secret');
    await writePrivateFile(p, 's3cr3t-value');
    const buf = await readPrivateFile(p);
    expect(buf.toString('utf8')).toBe('s3cr3t-value');
  });

  it('round-trips Buffer content through readPrivateFile', async () => {
    const p = join(tmpDir, 'bin');
    const data = Buffer.from([0, 1, 2, 254, 255]);
    await writePrivateFile(p, data);
    const buf = await readPrivateFile(p);
    expect(buf.equals(data)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('readPrivateFile throws on a 0644 file', async () => {
    const p = join(tmpDir, 'leaky');
    writeFileSync(p, 'x', { mode: 0o644 });
    chmodSync(p, 0o644);
    await expect(readPrivateFile(p)).rejects.toThrowError(PrivateFileTooPermissiveError);
  });
});

describe('tokenStore', () => {
  it('returns the same token from repeated getToken() calls', async () => {
    const store = await createTokenStore(join(tmpDir, 'home'));
    expect(store.getToken()).toBe(store.getToken());
    await store.dispose();
  });

  it('produces different tokens for different home dirs', async () => {
    const a = await createTokenStore(join(tmpDir, 'home-a'));
    const b = await createTokenStore(join(tmpDir, 'home-b'));
    expect(a.getToken()).not.toBe(b.getToken());
    await a.dispose();
    await b.dispose();
  });

  it('reuses the same persistent token across stores in one home dir', async () => {
    const home = join(tmpDir, 'home');
    const a = await createTokenStore(home);
    const token = a.getToken();
    await a.dispose();
    const b = await createTokenStore(home);
    expect(b.getToken()).toBe(token);
    await b.dispose();
  });

  it.skipIf(process.platform === 'win32')('writes the token file with mode 0600 at server.token', async () => {
    const home = join(tmpDir, 'home');
    const store = await createTokenStore(home);
    expect(store.tokenPath).toBe(join(home, 'server.token'));
    expect(statSync(store.tokenPath).mode & 0o777).toBe(0o600);
    await store.dispose();
  });

  it('isValid accepts the token and rejects wrong / empty / same-length candidates', async () => {
    const store = await createTokenStore(join(tmpDir, 'home'));
    const token = store.getToken();
    expect(store.isValid(token)).toBe(true);
    expect(store.isValid('wrong')).toBe(false);
    expect(store.isValid('')).toBe(false);

    const other = await createTokenStore(join(tmpDir, 'home-other'));
    expect(other.getToken().length).toBe(token.length);
    expect(store.isValid(other.getToken())).toBe(false);
    await store.dispose();
    await other.dispose();
  });

  it('dispose() keeps the persistent token file on disk', async () => {
    const store = await createTokenStore(join(tmpDir, 'home'));
    expect(existsSync(store.tokenPath)).toBe(true);
    await store.dispose();
    expect(existsSync(store.tokenPath)).toBe(true);
  });

  it('re-reads the token after the file is rewritten (live rotation)', async () => {
    const home = join(tmpDir, 'home');
    const store = await createTokenStore(home);
    const original = store.getToken();
    const rotated = 'r'.repeat(original.length);
    await writePrivateFile(store.tokenPath, rotated);

    expect(store.getToken()).toBe(rotated);
    expect(store.isValid(rotated)).toBe(true);
    expect(store.isValid(original)).toBe(false);
    await store.dispose();
  });
});

describe('persistentToken', () => {
  it('loadOrCreateServerToken generates once and reuses thereafter', async () => {
    const home = join(tmpDir, 'home');
    const a = await loadOrCreateServerToken(home);
    const b = await loadOrCreateServerToken(home);
    expect(a).toBe(b);
  });

  it.skipIf(process.platform === 'win32')('writes server.token with mode 0600', async () => {
    const home = join(tmpDir, 'home');
    await loadOrCreateServerToken(home);
    expect(statSync(join(home, 'server.token')).mode & 0o777).toBe(0o600);
  });

  it('rotateServerToken writes a new, different token to server.token', async () => {
    const home = join(tmpDir, 'home');
    const original = await loadOrCreateServerToken(home);
    const rotated = await rotateServerToken(home);
    expect(rotated).not.toBe(original);
    expect(readFileSync(join(home, 'server.token'), 'utf8').trim()).toBe(rotated);
  });
});

describe('password', () => {
  it('resolvePasswordHash returns undefined when env is unset or empty', async () => {
    expect(await resolvePasswordHash({})).toBeUndefined();
    expect(await resolvePasswordHash({ KIMI_CODE_PASSWORD: '' })).toBeUndefined();
  });

  it('hashes a set password with bcrypt and verifies correctly', async () => {
    const passwordHash = await resolvePasswordHash({
      KIMI_CODE_PASSWORD: 'correct-horse-battery-staple',
    });
    expect(passwordHash?.startsWith('$2')).toBe(true);
    expect(await verifyPassword('correct-horse-battery-staple', passwordHash)).toBe(true);
    expect(await verifyPassword('wrong-password', passwordHash)).toBe(false);
  });

  it('verifyPassword returns false when the hash is undefined', async () => {
    expect(await verifyPassword('anything', undefined)).toBe(false);
  });
});

describe('deviceTokenStore', () => {
  it('stores device tokens only as sha256 hashes at server/auth/device-tokens.json', async () => {
    const home = join(tmpDir, 'home');
    const devices = await createDeviceTokenStore(home);
    expect(devices.path).toBe(join(home, 'server', 'auth', 'device-tokens.json'));
    const token = 'device-token-plaintext-value';
    await devices.add(token);
    expect(devices.has(token)).toBe(true);
    expect(devices.has('other-token')).toBe(false);
    const raw = readFileSync(devices.path, 'utf8');
    expect(raw).not.toContain(token);
    expect(raw).toContain(hashDeviceToken(token));
    await devices.dispose();
  });

  it.skipIf(process.platform === 'win32')('writes device-tokens.json with mode 0600 inside a 0700 dir', async () => {
    const home = join(tmpDir, 'home');
    const devices = await createDeviceTokenStore(home);
    await devices.add('token-value');
    expect(statSync(devices.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'server', 'auth')).mode & 0o777).toBe(0o700);
    await devices.dispose();
  });

  it('keeps surviving tokens valid after the store is recreated', async () => {
    const home = join(tmpDir, 'home');
    const devices = await createDeviceTokenStore(home);
    await devices.add('keeper');
    await devices.dispose();
    const recreated = await createDeviceTokenStore(home);
    expect(recreated.has('keeper')).toBe(true);
    expect(recreated.has('never-added')).toBe(false);
    await recreated.dispose();
  });

  it('drops revoked hashes from memory and disk', async () => {
    const home = join(tmpDir, 'home');
    const devices = await createDeviceTokenStore(home);
    await devices.add('keeper');
    await devices.add('gone');
    expect(await devices.revoke('gone')).toBe(true);
    expect(await devices.revoke('gone')).toBe(false);
    expect(devices.has('gone')).toBe(false);
    expect(devices.has('keeper')).toBe(true);
    await devices.dispose();
    const recreated = await createDeviceTokenStore(home);
    expect(recreated.has('gone')).toBe(false);
    expect(recreated.has('keeper')).toBe(true);
    await recreated.dispose();
  });

  it('starts empty when the stored file is corrupt', async () => {
    const home = join(tmpDir, 'home');
    const devices = await createDeviceTokenStore(home);
    await devices.add('survivor');
    await devices.dispose();
    writeFileSync(devices.path, '{not json');
    const recreated = await createDeviceTokenStore(home);
    expect(recreated.has('survivor')).toBe(false);
    await recreated.dispose();
  });

  it.skipIf(process.platform === 'win32')('starts empty when the stored file is too permissive', async () => {
    const home = join(tmpDir, 'home');
    const devices = await createDeviceTokenStore(home);
    await devices.add('survivor');
    await devices.dispose();
    chmodSync(devices.path, 0o644);
    const recreated = await createDeviceTokenStore(home);
    expect(recreated.has('survivor')).toBe(false);
    await recreated.dispose();
  });

  it('starts empty when the stored file is absent', async () => {
    const devices = await createDeviceTokenStore(join(tmpDir, 'home'));
    expect(devices.has('anything')).toBe(false);
    await devices.dispose();
  });
});

describe('deviceTokenStore v2', () => {
  it('migrates a v1 hashes file losslessly to v2 with stable device ids', async () => {
    const home = join(tmpDir, 'home');
    const legacyHash = hashDeviceToken('legacy-device-token');
    await writePrivateFile(
      deviceTokensPath(home),
      `${JSON.stringify({ version: 1, hashes: [legacyHash] })}\n`,
    );

    const store = await createDeviceTokenStore(home);
    expect(store.has('legacy-device-token')).toBe(true);
    const listed = store.list();
    expect(listed).toHaveLength(1);
    const id = listed[0]!.id;
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(Number.isNaN(new Date(listed[0]!.createdAt).getTime())).toBe(false);

    const raw = JSON.parse(readFileSync(store.path, 'utf8')) as {
      version: number;
      devices: Array<{ id: string; hash: string; created_at: string }>;
    };
    expect(raw.version).toBe(2);
    expect(raw.devices).toHaveLength(1);
    expect(raw.devices[0]!.hash).toBe(legacyHash);
    expect(raw.devices[0]!.id).toBe(id);
    expect(raw.devices[0]!.created_at).toBe(listed[0]!.createdAt);
    await store.dispose();

    const reopened = await createDeviceTokenStore(home);
    expect(reopened.has('legacy-device-token')).toBe(true);
    expect(reopened.list()).toEqual([{ id, createdAt: listed[0]!.createdAt }]);
    expect(await reopened.revokeById(id)).toBe(true);
    expect(reopened.has('legacy-device-token')).toBe(false);
    expect(await reopened.revokeById(id)).toBe(false);
    await reopened.dispose();

    const afterRevoke = await createDeviceTokenStore(home);
    expect(afterRevoke.has('legacy-device-token')).toBe(false);
    expect(afterRevoke.list()).toEqual([]);
    await afterRevoke.dispose();
  });

  it('adds return unique stable ids and revokeById removes exactly one device', async () => {
    const home = join(tmpDir, 'home');
    const store = await createDeviceTokenStore(home);
    const idA = await store.add('token-a');
    const idB = await store.add('token-b');
    expect(idA).not.toBe(idB);
    expect(await store.add('token-a')).toBe(idA);

    expect(store.find('token-a')?.id).toBe(idA);
    expect(store.find('token-b')?.id).toBe(idB);
    expect(store.find('unknown-token')).toBeUndefined();
    expect(store.list().map((entry) => entry.id).toSorted()).toEqual([idA, idB].toSorted());

    expect(await store.revokeById(idB)).toBe(true);
    expect(store.has('token-b')).toBe(false);
    expect(store.has('token-a')).toBe(true);
    expect(await store.revokeById(idB)).toBe(false);
    await store.dispose();
  });

  it('never exposes hashes through list or find', async () => {
    const home = join(tmpDir, 'home');
    const store = await createDeviceTokenStore(home);
    await store.add('hashless-token');
    const serialized = JSON.stringify({ list: store.list(), find: store.find('hashless-token') });
    expect(serialized).not.toContain('hash');
    expect(serialized).not.toContain(hashDeviceToken('hashless-token'));
    await store.dispose();
  });

  it('sees another instance writes and revocations on a shared home without re-creating', async () => {
    const home = join(tmpDir, 'home');
    const a = await createDeviceTokenStore(home);
    const b = await createDeviceTokenStore(home);

    await a.add('late-arrival');
    expect(b.has('late-arrival')).toBe(true);
    expect(await b.revoke('late-arrival')).toBe(true);
    expect(a.has('late-arrival')).toBe(false);
    expect(await b.revoke('late-arrival')).toBe(false);
    await a.dispose();
    await b.dispose();

    const fresh = await createDeviceTokenStore(home);
    expect(fresh.has('late-arrival')).toBe(false);
    await fresh.dispose();
  });

  it('keeps concurrent adds from two instances on one shared home', async () => {
    const home = join(tmpDir, 'home');
    const a = await createDeviceTokenStore(home);
    const b = await createDeviceTokenStore(home);

    await Promise.all([a.add('from-a'), b.add('from-b')]);
    await a.dispose();
    await b.dispose();

    const fresh = await createDeviceTokenStore(home);
    expect(fresh.has('from-a')).toBe(true);
    expect(fresh.has('from-b')).toBe(true);
    expect(fresh.list()).toHaveLength(2);
    expect(new Set(fresh.list().map((entry) => entry.id)).size).toBe(2);
    await fresh.dispose();
  });

  it('applies a cross-instance revocation after a concurrent add on a shared home', async () => {
    const home = join(tmpDir, 'home');
    const a = await createDeviceTokenStore(home);
    const b = await createDeviceTokenStore(home);

    await a.add('doomed');
    const [revoked, addedId] = await Promise.all([b.revoke('doomed'), a.add('survivor')]);
    expect(revoked).toBe(true);
    expect(typeof addedId).toBe('string');

    await a.dispose();
    await b.dispose();
    const fresh = await createDeviceTokenStore(home);
    expect(fresh.has('doomed')).toBe(false);
    expect(fresh.has('survivor')).toBe(true);
    await fresh.dispose();
  });

  it('takes over a lock left behind by a dead process and keeps mutating', async () => {
    const home = join(tmpDir, 'home');
    const store = await createDeviceTokenStore(home);
    await store.add('before-crash');

    const staleLock = join(home, 'server', 'auth', 'device-tokens.json.lock');
    await writePrivateFile(staleLock, `${JSON.stringify({ pid: 999999999, nonce: 'ghost' })}\n`);

    const id = await store.add('after-crash');
    expect(typeof id).toBe('string');
    expect(store.has('before-crash')).toBe(true);
    expect(store.has('after-crash')).toBe(true);
    await store.dispose();

    const fresh = await createDeviceTokenStore(home);
    expect(fresh.list()).toHaveLength(2);
    await fresh.dispose();
  });

  it('re-verifies staleness after a controlled stall and never double-holds the lock', async () => {
    const home = join(tmpDir, 'home');
    const store = await createDeviceTokenStore(home);
    await store.add('seed');
    await store.dispose();
    const dataPath = deviceTokensPath(home);
    const lockPath = `${dataPath}.lock`;
    await writePrivateFile(lockPath, `${JSON.stringify({ pid: 999999999, nonce: 'ghost' })}\n`);

    let overlap = 0;
    let maxOverlap = 0;
    let hookInvoked = false;
    const order: string[] = [];
    let resolveGate: (() => void) | undefined;
    const gateOpened = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });

    async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('wait timed out');
    }

    function lockNonce(): string {
      try {
        return (JSON.parse(readFileSync(lockPath, 'utf8')) as { nonce?: string }).nonce ?? '';
      } catch {
        return '';
      }
    }

    const holderBody = async (): Promise<void> => {
      overlap += 1;
      maxOverlap = Math.max(maxOverlap, overlap);
      try {
        order.push('holder-enter');
        await Promise.race([gateOpened, new Promise((resolve) => setTimeout(resolve, 2000))]);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('holder-exit');
      } finally {
        overlap -= 1;
      }
    };

    const hooks: PrivateFileLockHooks = {
      beforeStaleTakeoverRename: async () => {
        hookInvoked = true;
        await waitFor(() => lockNonce() !== '' && lockNonce() !== 'ghost', 2000);
        resolveGate?.();
      },
    };

    const holder = withPrivateFileLock(dataPath, holderBody);
    const lateContender = withPrivateFileLock(
      dataPath,
      async () => {
        overlap += 1;
        maxOverlap = Math.max(maxOverlap, overlap);
        try {
          order.push('late-enter');
          await new Promise((resolve) => setTimeout(resolve, 10));
        } finally {
          overlap -= 1;
        }
      },
      hooks,
    );

    await Promise.all([holder, lateContender]);

    expect(hookInvoked).toBe(true);
    expect(order[0]).toBe('holder-enter');
    expect(order).toContain('late-enter');
    expect(maxOverlap).toBe(1);
  });

  it('refuses to mutate and never rewrites when the store file is too permissive', async () => {
    const home = join(tmpDir, 'home');
    const store = await createDeviceTokenStore(home);
    await store.add('keeper');
    chmodSync(store.path, 0o644);
    const before = readFileSync(store.path, 'utf8');

    await expect(store.add('intruder')).rejects.toThrowError(PrivateFileTooPermissiveError);
    expect(readFileSync(store.path, 'utf8')).toBe(before);
    expect(store.has('intruder')).toBe(false);

    chmodSync(store.path, 0o600);
    expect(store.has('keeper')).toBe(true);
    await store.dispose();
  });

  it('dispose waits for a mutation queued behind an externally held lock', async () => {
    const home = join(tmpDir, 'home');
    const store = await createDeviceTokenStore(home);
    const lockPath = `${deviceTokensPath(home)}.lock`;
    await writePrivateFile(lockPath, `${JSON.stringify({ pid: process.pid, nonce: 'external' })}\n`);

    const pending = store.add('queued-behind-lock');
    const done = store.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    unlinkSync(lockPath);
    await done;

    expect(readFileSync(deviceTokensPath(home), 'utf8')).toContain(
      hashDeviceToken('queued-behind-lock'),
    );
    await pending;
  });
});

describe('createAuthTokenService', () => {
  it('getToken() returns the tokenStore token', async () => {
    const store = await createTokenStore(join(tmpDir, 'home'));
    const devices = await createDeviceTokenStore(join(tmpDir, 'home'));
    const svc = createAuthTokenService({
      tokenStore: store,
      deviceTokenStore: devices,
      passwordHash: undefined,
    });
    expect(svc.getToken()).toBe(store.getToken());
    await store.dispose();
    await devices.dispose();
  });

  it('exchanges pairing codes once for scoped device tokens', async () => {
    const store = await createTokenStore(join(tmpDir, 'home'));
    const devices = await createDeviceTokenStore(join(tmpDir, 'home'));
    const svc = createAuthTokenService({
      tokenStore: store,
      deviceTokenStore: devices,
      passwordHash: undefined,
      now: () => 1000,
    });
    const code = svc.createPairingCode();
    const exchange = await svc.exchangePairingCode(code);
    expect(exchange?.scope).toBe('device');
    expect(exchange?.token).not.toBe(store.getToken());
    expect(await svc.isValid(exchange!.token)).toBe(true);
    expect(await svc.exchangePairingCode(code)).toBeUndefined();
    await store.dispose();
    await devices.dispose();
  });

  it('expires pairing codes', async () => {
    const store = await createTokenStore(join(tmpDir, 'home'));
    const devices = await createDeviceTokenStore(join(tmpDir, 'home'));
    let time = 1000;
    const svc = createAuthTokenService({
      tokenStore: store,
      deviceTokenStore: devices,
      passwordHash: undefined,
      now: () => time,
    });
    const code = svc.createPairingCode();
    time += 60_000;
    expect(await svc.exchangePairingCode(code)).toBeUndefined();
    await store.dispose();
    await devices.dispose();
  });

  it('keeps exchanged device tokens valid after the service is recreated', async () => {
    const home = join(tmpDir, 'home');
    const storeA = await createTokenStore(home);
    const devicesA = await createDeviceTokenStore(home);
    const svcA = createAuthTokenService({
      tokenStore: storeA,
      deviceTokenStore: devicesA,
      passwordHash: undefined,
    });
    const code = svcA.createPairingCode();
    const exchange = await svcA.exchangePairingCode(code);
    const token = exchange!.token;
    await storeA.dispose();
    await devicesA.dispose();

    const storeB = await createTokenStore(home);
    const devicesB = await createDeviceTokenStore(home);
    const svcB = createAuthTokenService({
      tokenStore: storeB,
      deviceTokenStore: devicesB,
      passwordHash: undefined,
    });
    expect(await svcB.isValid(token)).toBe(true);
    expect(await svcB.isValid(svcB.getToken())).toBe(true);
    expect(await svcB.exchangePairingCode(code)).toBeUndefined();
    await storeB.dispose();
    await devicesB.dispose();
  });

  it('revokes a device token only when its own plaintext is presented', async () => {
    const home = join(tmpDir, 'home');
    const store = await createTokenStore(home);
    const devices = await createDeviceTokenStore(home);
    const svc = createAuthTokenService({
      tokenStore: store,
      deviceTokenStore: devices,
      passwordHash: undefined,
    });
    const exchange = await svc.exchangePairingCode(svc.createPairingCode());
    const token = exchange!.token;
    expect(await svc.isValid(token)).toBe(true);

    expect(await svc.revokeDeviceToken('not-the-token')).toBe(false);
    expect(await svc.isValid(token)).toBe(true);

    expect(await svc.revokeDeviceToken(token)).toBe(true);
    expect(await svc.isValid(token)).toBe(false);
    expect(await svc.revokeDeviceToken(token)).toBe(false);
    await store.dispose();
    await devices.dispose();

    const recreated = await createDeviceTokenStore(home);
    expect(recreated.has(token)).toBe(false);
    await recreated.dispose();
  });

  it('isValid accepts the token', async () => {
    const store = await createTokenStore(join(tmpDir, 'home'));
    const devices = await createDeviceTokenStore(join(tmpDir, 'home'));
    const svc = createAuthTokenService({
      tokenStore: store,
      deviceTokenStore: devices,
      passwordHash: undefined,
    });
    expect(await svc.isValid(store.getToken())).toBe(true);
    await store.dispose();
    await devices.dispose();
  });

  it('isValid accepts the password when a hash is configured', async () => {
    const store = await createTokenStore(join(tmpDir, 'home'));
    const devices = await createDeviceTokenStore(join(tmpDir, 'home'));
    const passwordHash = await resolvePasswordHash({
      KIMI_CODE_PASSWORD: 'correct horse battery staple',
    });
    const svc = createAuthTokenService({
      tokenStore: store,
      deviceTokenStore: devices,
      passwordHash,
    });
    expect(await svc.isValid('correct horse battery staple')).toBe(true);
    await store.dispose();
    await devices.dispose();
  });

  it('isValid rejects a wrong candidate', async () => {
    const store = await createTokenStore(join(tmpDir, 'home'));
    const devices = await createDeviceTokenStore(join(tmpDir, 'home'));
    const passwordHash = await resolvePasswordHash({
      KIMI_CODE_PASSWORD: 'correct horse battery staple',
    });
    const svc = createAuthTokenService({
      tokenStore: store,
      deviceTokenStore: devices,
      passwordHash,
    });
    expect(await svc.isValid('wrong')).toBe(false);
    await store.dispose();
    await devices.dispose();
  });

  it('isValid accepts only the token when passwordHash is undefined', async () => {
    const store = await createTokenStore(join(tmpDir, 'home'));
    const devices = await createDeviceTokenStore(join(tmpDir, 'home'));
    const svc = createAuthTokenService({
      tokenStore: store,
      deviceTokenStore: devices,
      passwordHash: undefined,
    });
    expect(await svc.isValid(store.getToken())).toBe(true);
    expect(await svc.isValid('any-password')).toBe(false);
    await store.dispose();
    await devices.dispose();
  });
});
