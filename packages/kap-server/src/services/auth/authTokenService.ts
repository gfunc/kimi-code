import { randomBytes } from 'node:crypto';

import { createDecorator } from '@moonshot-ai/agent-core-v2';

import type { AuthIdentity } from './credentials';
import type { DeviceTokenRecord, DeviceTokenStore } from './deviceTokenStore';
import { verifyPassword } from './password';
import type { TokenStore } from './tokenStore';

const PAIRING_CODE_TTL_MS = 60_000;

interface PairingCode {
  readonly expiresAt: number;
}

export interface PairingExchange {
  readonly token: string;
  readonly scope: 'device';
  readonly deviceId: string;
}

export interface IAuthTokenService {
  readonly _serviceBrand: undefined;

  getToken(): string;

  isValid(candidate: string): Promise<boolean>;

  identify(candidate: string): Promise<AuthIdentity | undefined>;

  createPairingCode(): string;

  exchangePairingCode(code: string): Promise<PairingExchange | undefined>;

  revokeDeviceToken(candidate: string): Promise<boolean>;

  listDevices(): readonly DeviceTokenRecord[];

  revokeDeviceById(deviceId: string): Promise<boolean>;
}

export const IAuthTokenService =
  createDecorator<IAuthTokenService>('authTokenService');

export function createAuthTokenService(deps: {
  readonly tokenStore: TokenStore;
  readonly deviceTokenStore: DeviceTokenStore;
  readonly passwordHash: string | undefined;
  readonly now?: () => number;
}): IAuthTokenService {
  const pairingCodes = new Map<string, PairingCode>();
  const now = deps.now ?? Date.now;
  const removeExpired = (): void => {
    const current = now();
    for (const [code, pairing] of pairingCodes) {
      if (pairing.expiresAt <= current) pairingCodes.delete(code);
    }
  };

  return {
    _serviceBrand: undefined,
    getToken: () => deps.tokenStore.getToken(),
    isValid: async (candidate) =>
      deps.tokenStore.isValid(candidate) ||
      deps.deviceTokenStore.has(candidate) ||
      (await verifyPassword(candidate, deps.passwordHash)),
    identify: async (candidate) => {
      if (deps.tokenStore.isValid(candidate)) return { kind: 'server' };
      const device = deps.deviceTokenStore.find(candidate);
      if (device !== undefined) return { kind: 'device', deviceId: device.id };
      if (await verifyPassword(candidate, deps.passwordHash)) return { kind: 'password' };
      return undefined;
    },
    createPairingCode: () => {
      removeExpired();
      const code = randomBytes(24).toString('base64url');
      pairingCodes.set(code, { expiresAt: now() + PAIRING_CODE_TTL_MS });
      return code;
    },
    exchangePairingCode: async (code) => {
      removeExpired();
      const pairing = pairingCodes.get(code);
      if (pairing === undefined) return undefined;
      pairingCodes.delete(code);
      const token = randomBytes(32).toString('base64url');
      const deviceId = await deps.deviceTokenStore.add(token);
      return { token, scope: 'device', deviceId };
    },
    revokeDeviceToken: (candidate) => deps.deviceTokenStore.revoke(candidate),
    listDevices: () => deps.deviceTokenStore.list(),
    revokeDeviceById: (deviceId) => deps.deviceTokenStore.revokeById(deviceId),
  };
}
