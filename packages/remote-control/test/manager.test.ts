import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  RemoteControlHandle,
  RemoteControlOptions,
  RemoteControlStatus,
} from '../src/remote-control';

const startRemoteControlMock = vi.hoisted(() => vi.fn());

vi.mock('../src/remote-control', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/remote-control')>();
  return { ...actual, startRemoteControl: startRemoteControlMock };
});

const { createRemoteControlManager } = await import('../src/manager');

function stubHandle(onStatus?: (status: RemoteControlStatus) => void): RemoteControlHandle {
  return {
    deviceId: 'dev-1',
    deviceName: 'host',
    url: 'https://relay.example.test/devices/dev-1',
    closed: Promise.resolve(),
    close: async () => {
      onStatus?.('relay_disconnected');
    },
  };
}

describe('Remote Control manager', () => {
  afterEach(() => {
    startRemoteControlMock.mockReset();
  });

  it('passes the manager onStatus through to the tunnel', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-rc-manager-'));
    const statuses: RemoteControlStatus[] = [];
    startRemoteControlMock.mockImplementation(async (options: RemoteControlOptions) => {
      options.onStatus?.('relay_connected');
      return stubHandle(options.onStatus);
    });
    const manager = createRemoteControlManager({
      homeDir: dir,
      localOrigin: () => 'http://127.0.0.1:58627',
      localServerToken: () => 'server-token',
      clientVersion: 'kimi-code/test',
      onStatus: (status) => statuses.push(status),
    });
    try {
      const enabled = await manager.enable();
      expect(enabled.enabled).toBe(true);
      expect(statuses).toEqual(['relay_connected']);

      await manager.disable();
      expect(statuses).toEqual(['relay_connected', 'relay_disconnected']);
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts without an onStatus callback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-rc-manager-'));
    startRemoteControlMock.mockImplementation(async () => stubHandle(undefined));
    const manager = createRemoteControlManager({
      homeDir: dir,
      localOrigin: () => 'http://127.0.0.1:58627',
      localServerToken: () => 'server-token',
      clientVersion: 'kimi-code/test',
    });
    try {
      const enabled = await manager.enable();
      expect(enabled.enabled).toBe(true);
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
