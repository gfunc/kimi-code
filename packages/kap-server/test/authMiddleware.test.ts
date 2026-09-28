import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { type IAuthTokenService } from '../src/services/auth/authTokenService';
import { fixedTokenAuth } from './helpers/fixedAuth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

describe('server-v2 /api/v1 bearer auth', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-auth-middleware-'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('allows healthz without a token', async () => {
    const res = await server!.app.inject({ method: 'GET', url: '/api/v1/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('allows the pairing exchange POST without a token', async () => {
    const res = await server!.app.inject({
      method: 'POST',
      url: '/api/v1/pairing/exchange',
      payload: { code: 'no-such-code' },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe(40101);
    expect(body['msg']).toBe('Invalid or expired pairing code');
  });

  it('keeps the token requirement for other methods on the pairing path', async () => {
    const res = await server!.app.inject({ method: 'GET', url: '/api/v1/pairing/exchange' });
    expect(res.statusCode).toBe(401);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe(40101);
  });

  it('rejects /api/v1/auth without a token with 40101', async () => {
    const res = await server!.app.inject({ method: 'GET', url: '/api/v1/auth' });
    expect(res.statusCode).toBe(401);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe(40101);
  });

  it('rejects /api/v1/auth with a wrong token', async () => {
    const res = await server!.app.inject({
      method: 'GET',
      url: '/api/v1/auth',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe(40101);
  });

  it('accepts /api/v1/auth with the persistent token', async () => {
    const token = server!.authTokenService.getToken();
    const res = await server!.app.inject({
      method: 'GET',
      url: '/api/v1/auth',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe(0);
  });

  it('requires auth for /openapi.json', async () => {
    const res = await server!.app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(401);
  });
});

describe('server-v2 device identity on REST', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-device-rest-'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  async function pairDevice(): Promise<{ token: string; deviceId: string }> {
    const code = server!.authTokenService.createPairingCode();
    const res = await server!.app.inject({
      method: 'POST',
      url: '/api/v1/pairing/exchange',
      payload: { code },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { token: string; device_id?: string } };
    expect(typeof body.data.device_id).toBe('string');
    expect(body.data.device_id!.length).toBeGreaterThan(0);
    return { token: body.data.token, deviceId: body.data.device_id! };
  }

  function hostHeaders(): Record<string, string> {
    return { authorization: `Bearer ${server!.authTokenService.getToken()}` };
  }

  it('returns a device_id alongside the token and scope from a pairing exchange', async () => {
    const { token, deviceId } = await pairDevice();
    expect(token).not.toBe(server!.authTokenService.getToken());
    expect((await pairDevice()).deviceId).not.toBe(deviceId);
  });

  it('accepts a device token on protected routes', async () => {
    const { token } = await pairDevice();
    const res = await server!.app.inject({
      method: 'GET',
      url: '/api/v1/auth',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { code: number }).code).toBe(0);
  });

  it('keeps device enumeration host-only', async () => {
    const { token, deviceId } = await pairDevice();

    const denied = await server!.app.inject({
      method: 'GET',
      url: '/api/v1/devices',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as { code: number }).code).toBe(40302);

    const anonymous = await server!.app.inject({ method: 'GET', url: '/api/v1/devices' });
    expect(anonymous.statusCode).toBe(401);

    const allowed = await server!.app.inject({
      method: 'GET',
      url: '/api/v1/devices',
      headers: hostHeaders(),
    });
    expect(allowed.statusCode).toBe(200);
    const body = allowed.json() as {
      code: number;
      data: { devices: Array<{ device_id: string; created_at: string }> };
    };
    expect(body.code).toBe(0);
    const mine = body.data.devices.find((device) => device.device_id === deviceId);
    expect(mine).toBeDefined();
    expect(Number.isNaN(new Date(mine!.created_at).getTime())).toBe(false);
    expect(allowed.body).not.toContain('hash');
  });

  it('keeps device revocation host-only and scoped to the given device', async () => {
    const a = await pairDevice();
    const b = await pairDevice();

    const denied = await server!.app.inject({
      method: 'POST',
      url: `/api/v1/devices/${b.deviceId}:revoke`,
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as { code: number }).code).toBe(40302);

    const missing = await server!.app.inject({
      method: 'POST',
      url: '/api/v1/devices/dev_does_not_exist:revoke',
      headers: hostHeaders(),
    });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { code: number }).code).toBe(40421);

    const revoked = await server!.app.inject({
      method: 'POST',
      url: `/api/v1/devices/${b.deviceId}:revoke`,
      headers: hostHeaders(),
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json() as { data: { device_id: string; revoked: boolean } }).toEqual({
      code: 0,
      msg: 'success',
      data: { device_id: b.deviceId, revoked: true },
      request_id: expect.any(String),
    });

    const bAfter = await server!.app.inject({
      method: 'GET',
      url: '/api/v1/auth',
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(bAfter.statusCode).toBe(401);

    const aAfter = await server!.app.inject({
      method: 'GET',
      url: '/api/v1/auth',
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(aAfter.statusCode).toBe(200);
  });

  it('rejects a device token on host shutdown while the host stays up', async () => {
    const { token } = await pairDevice();

    const denied = await server!.app.inject({
      method: 'POST',
      url: '/api/v1/shutdown',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as { code: number }).code).toBe(40302);

    const health = await server!.app.inject({ method: 'GET', url: '/api/v1/healthz' });
    expect(health.statusCode).toBe(200);
  });
});

describe('server-v2 fail-closed identity handling', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fail-closed-'));
    const falseIdentityAuth = {
      ...fixedTokenAuth('tok'),
      identify: async () => false,
    } as unknown as IAuthTokenService;
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      authTokenService: falseIdentityAuth,
    });
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('rejects a runtime boolean-false identity on REST instead of accepting it', async () => {
    const res = await server!.app.inject({
      method: 'GET',
      url: '/api/v1/auth',
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { code: number }).code).toBe(40101);
  });

  it('rejects a runtime boolean-false identity on host-only routes', async () => {
    const res = await server!.app.inject({
      method: 'GET',
      url: '/api/v1/devices',
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(401);
  });
});
