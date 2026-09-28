import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

function openConn(url: string, protocols: string[]): Promise<{ ws: WebSocket; firstFrame: unknown }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols);
    ws.once('message', (data) => {
      try {
        resolve({ ws, firstFrame: JSON.parse(rawToString(data)) });
      } catch {
        resolve({ ws, firstFrame: null });
      }
    });
    ws.once('error', reject);
  });
}

function expectRejected(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const done = (err?: Error): void => {
      clearTimeout(t);
      ws.removeAllListeners();
      try {
        ws.terminate();
      } catch {
      }
      if (err === undefined) resolve();
      else reject(err);
    };
    const t = setTimeout(
      () => done(new Error('connection was not rejected within timeout')),
      1500,
    );
    ws.once('open', () => done(new Error('connection unexpectedly opened')));
    ws.once('error', () => done());
    ws.once('close', () => done());
  });
}

function waitClose(ws: WebSocket, timeoutMs = 3000): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('close', onClose);
      reject(new Error('connection was not closed within timeout'));
    }, timeoutMs);
    const onClose = (): void => {
      clearTimeout(timer);
      resolve();
    };
    ws.once('close', onClose);
  });
}

async function pollUntil(probe: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('condition was not met within timeout');
}

describe('production auth wiring', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  const sockets: WebSocket[] = [];
  const extraServers: RunningServer[] = [];

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-auth-wiring-'));
    await boot();
  });

  async function boot(opts?: { wsCredentialRecheckIntervalMs?: number }): Promise<void> {
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      ...opts,
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  afterEach(() => {
    for (const ws of sockets.splice(0)) {
      try {
        ws.close();
      } catch {
      }
    }
  });

  afterAll(async () => {
    while (extraServers.length > 0) {
      await extraServers.pop()!.close();
    }
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as never);
      home = undefined;
    }
  });

  async function serverToken(): Promise<string> {
    return (await readFile(join(home as string, 'server.token'), 'utf8')).trim();
  }

  interface PairingResult {
    token: string;
    deviceId: string;
  }

  async function pairDevice(): Promise<PairingResult> {
    const srv = server as RunningServer;
    const code = srv.authTokenService.createPairingCode();
    const response = await fetch(`${base}/api/v1/pairing/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { token: string; scope: string; device_id?: string };
    };
    expect(typeof body.data.device_id).toBe('string');
    return { token: body.data.token, deviceId: body.data.device_id! };
  }

  async function revokeDevice(deviceId: string): Promise<void> {
    const response = await fetch(`${base}/api/v1/devices/${deviceId}:revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await serverToken()}` },
    });
    expect(response.status).toBe(200);
  }

  it.skipIf(process.platform === 'win32')('writes a 0600 token file at boot and keeps it on close', async () => {
    const p = join(home as string, 'server.token');
    const info = await stat(p);
    expect(info.mode & 0o777).toBe(0o600);
    const token = (await readFile(p, 'utf8')).trim();
    expect(token.length).toBeGreaterThan(0);

    await (server as RunningServer).close();
    server = undefined;
    const after = await stat(p);
    expect(after.mode & 0o777).toBe(0o600);
    await boot();
  });

  it('exchanges a pairing code for a device token and consumes it once', async () => {
    const unknown = await fetch(`${base}/api/v1/pairing/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'never-issued' }),
    });
    expect(unknown.status).toBe(401);
    const unknownBody = (await unknown.json()) as { code: number; msg: string };
    expect(unknownBody.code).toBe(40101);
    expect(unknownBody.msg).toBe('Invalid or expired pairing code');

    const code = (server as RunningServer).authTokenService.createPairingCode();
    const response = await fetch(`${base}/api/v1/pairing/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      code: number;
      data: { token: string; scope: string };
    };
    expect(body.code).toBe(0);
    expect(body.data.scope).toBe('device');
    expect(body.data.token).not.toContain((await readFile(join(home as string, 'server.token'), 'utf8')).trim());

    const replay = await fetch(`${base}/api/v1/pairing/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(replay.status).toBe(401);

    const gated = await fetch(`${base}/api/v1/auth`, {
      headers: { Authorization: `Bearer ${body.data.token}` },
    });
    expect(gated.status).toBe(200);
  });

  it('keeps exchanged device tokens valid across a restart', async () => {
    const code = (server as RunningServer).authTokenService.createPairingCode();
    const response = await fetch(`${base}/api/v1/pairing/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { token: string } };
    const deviceToken = body.data.token;

    await (server as RunningServer).close();
    await boot();

    const persisted = await fetch(`${base}/api/v1/auth`, {
      headers: { Authorization: `Bearer ${deviceToken}` },
    });
    expect(persisted.status).toBe(200);

    const replay = await fetch(`${base}/api/v1/pairing/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(replay.status).toBe(401);

    const raw = await readFile(
      join(home as string, 'server', 'auth', 'device-tokens.json'),
      'utf8',
    );
    expect(raw).not.toContain(deviceToken);
  });

  it.skipIf(process.platform === 'win32')('stores device tokens in a 0600 file inside a 0700 dir', async () => {
    const p = join(home as string, 'server', 'auth', 'device-tokens.json');
    expect((await stat(p)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home as string, 'server', 'auth'))).mode & 0o777).toBe(0o700);
  });

  it('gates HTTP: 200 with the token, 401 without', async () => {
    const token = (await readFile(join(home as string, 'server.token'), 'utf8')).trim();

    const ok = await fetch(`${base}/openapi.json`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);

    const bad = await fetch(`${base}/openapi.json`);
    expect(bad.status).toBe(401);
    const body = (await bad.json()) as { code: number };
    expect(body.code).toBe(40101);
  });

  it('gates /asyncapi.json: 200 with the token, 401 without', async () => {
    const token = (await readFile(join(home as string, 'server.token'), 'utf8')).trim();

    const ok = await fetch(`${base}/asyncapi.json`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);
    const doc = (await ok.json()) as { asyncapi?: string };
    expect(doc.asyncapi).toBeDefined();

    const bad = await fetch(`${base}/asyncapi.json`);
    expect(bad.status).toBe(401);
  });

  it('gates WS: server_hello with the token, rejected without', async () => {
    const token = (await readFile(join(home as string, 'server.token'), 'utf8')).trim();
    const wsUrl = `ws://127.0.0.1:${(server as RunningServer).port}/api/v1/ws`;

    const { ws, firstFrame } = await openConn(wsUrl, [`kimi-code.bearer.${token}`]);
    sockets.push(ws);
    expect(firstFrame).toMatchObject({ type: 'server_hello' });

    await expectRejected(wsUrl);
  });

  it('keeps device management host-only over the real HTTP surface', async () => {
    const srv = server as RunningServer;
    const paired = await pairDevice();
    const token = await serverToken();

    const deviceAuth = await fetch(`${base}/api/v1/auth`, {
      headers: { authorization: `Bearer ${paired.token}` },
    });
    expect(deviceAuth.status).toBe(200);

    const deniedList = await fetch(`${base}/api/v1/devices`, {
      headers: { authorization: `Bearer ${paired.token}` },
    });
    expect(deniedList.status).toBe(403);
    expect(((await deniedList.json()) as { code: number }).code).toBe(40302);

    const deniedRevoke = await fetch(`${base}/api/v1/devices/${paired.deviceId}:revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${paired.token}` },
    });
    expect(deniedRevoke.status).toBe(403);

    const list = await fetch(`${base}/api/v1/devices`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      data: { devices: Array<{ device_id: string; created_at: string }> };
    };
    const mine = listBody.data.devices.find((device) => device.device_id === paired.deviceId);
    expect(mine).toBeDefined();
    expect(Number.isNaN(new Date(mine!.created_at).getTime())).toBe(false);

    const unknown = await fetch(`${base}/api/v1/devices/dev_unknown:revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { code: number }).code).toBe(40421);

    await revokeDevice(paired.deviceId);
    const after = await fetch(`${base}/api/v1/auth`, {
      headers: { authorization: `Bearer ${paired.token}` },
    });
    expect(after.status).toBe(401);
    expect(srv.port).toBeGreaterThan(0);
  });

  it('closes a revoked device-token WS in place and leaves the server-token WS alone', async () => {
    const srv = server as RunningServer;
    const wsUrl = `ws://127.0.0.1:${srv.port}/api/v1/ws`;
    const paired = await pairDevice();
    const token = await serverToken();

    const deviceWs = (await openConn(wsUrl, [`kimi-code.bearer.${paired.token}`])).ws;
    sockets.push(deviceWs);
    const hostWs = (await openConn(wsUrl, [`kimi-code.bearer.${token}`])).ws;
    sockets.push(hostWs);

    await revokeDevice(paired.deviceId);

    await waitClose(deviceWs);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(hostWs.readyState).toBe(WebSocket.OPEN);
  });

  it('detects a cross-instance revocation on a shared home via periodic recheck', async () => {
    const srvA = server as RunningServer;
    const srvB = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      wsCredentialRecheckIntervalMs: 25,
    });
    extraServers.push(srvB);
    const paired = await pairDevice();
    const token = await serverToken();

    const wsUrlA = `ws://127.0.0.1:${srvA.port}/api/v1/ws`;
    const wsUrlB = `ws://127.0.0.1:${srvB.port}/api/v1/ws`;
    const wsA = (await openConn(wsUrlA, [`kimi-code.bearer.${paired.token}`])).ws;
    sockets.push(wsA);
    const wsB = (await openConn(wsUrlB, [`kimi-code.bearer.${paired.token}`])).ws;
    sockets.push(wsB);

    const revoke = await fetch(`${base}/api/v1/devices/${paired.deviceId}:revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(revoke.status).toBe(200);

    await waitClose(wsA);
    await waitClose(wsB);

    await expectRejected(wsUrlB);
  });

  it('keeps shutdown host-only and lets the server token stop the host', async () => {
    const paired = await pairDevice();
    const token = await serverToken();

    const denied = await fetch(`${base}/api/v1/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${paired.token}` },
    });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { code: number }).code).toBe(40302);
    expect((await fetch(`${base}/api/v1/healthz`)).status).toBe(200);

    const allowed = await fetch(`${base}/api/v1/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(allowed.status).toBe(200);
    await pollUntil(async () => {
      try {
        return (await fetch(`${base}/api/v1/healthz`)).status !== 200;
      } catch {
        return true;
      }
    }, 5000);
    server = undefined;
    await new Promise((resolve) => setTimeout(resolve, 250));
    await boot();
  });
});

describe('pollUntil', () => {
  it('times out when an async probe keeps returning false', async () => {
    await expect(pollUntil(async () => false, 250)).rejects.toThrow('condition was not met within timeout');
  });

  it('keeps polling until an async probe turns true', async () => {
    let calls = 0;
    await pollUntil(async () => {
      calls += 1;
      return calls >= 3;
    }, 2000);
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});
