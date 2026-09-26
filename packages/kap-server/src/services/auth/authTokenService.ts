import { randomBytes } from 'node:crypto';

import { createDecorator } from '@moonshot-ai/agent-core-v2';

import { verifyPassword } from './password';
import type { TokenStore } from './tokenStore';

const PAIRING_CODE_TTL_MS = 60_000;

interface PairingCode {
  readonly expiresAt: number;
}

interface PairingExchange {
  readonly token: string;
  readonly scope: 'device';
}

export interface IAuthTokenService {
  readonly _serviceBrand: undefined;

  getToken(): string;

  isValid(candidate: string): Promise<boolean>;

  createPairingCode(): string;

  exchangePairingCode(code: string): PairingExchange | undefined;
}

export const IAuthTokenService =
  createDecorator<IAuthTokenService>('authTokenService');

export function createAuthTokenService(deps: {
  readonly tokenStore: TokenStore;
  readonly passwordHash: string | undefined;
  readonly now?: () => number;
}): IAuthTokenService {
  const pairingCodes = new Map<string, PairingCode>();
  const deviceTokens = new Set<string>();
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
      deviceTokens.has(candidate) ||
      (await verifyPassword(candidate, deps.passwordHash)),
    createPairingCode: () => {
      removeExpired();
      const code = randomBytes(24).toString('base64url');
      pairingCodes.set(code, { expiresAt: now() + PAIRING_CODE_TTL_MS });
      return code;
    },
    exchangePairingCode: (code) => {
      removeExpired();
      const pairing = pairingCodes.get(code);
      if (pairing === undefined) return undefined;
      pairingCodes.delete(code);
      const token = randomBytes(32).toString('base64url');
      deviceTokens.add(token);
      return { token, scope: 'device' };
    },
  };
}
