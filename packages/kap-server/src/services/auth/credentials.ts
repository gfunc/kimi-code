import { timingSafeEqual } from 'node:crypto';

import type { IAuthTokenService } from './authTokenService';

export type AuthIdentityKind = 'server' | 'device' | 'password' | 'rpc';

export interface AuthIdentity {
  readonly kind: AuthIdentityKind;
  readonly deviceId?: string;
}

export type CredentialValidator = (candidate: string) => Promise<AuthIdentity | undefined>;

const AUTH_IDENTITY_KINDS: ReadonlySet<string> = new Set([
  'server',
  'device',
  'password',
  'rpc',
]);

export function isAcceptedIdentity(value: unknown): value is AuthIdentity {
  return (
    typeof value === 'object' &&
    value !== null &&
    AUTH_IDENTITY_KINDS.has((value as { kind?: unknown }).kind as string)
  );
}

function timingSafeMatch(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createCredentialValidator(
  authTokenService: IAuthTokenService,
  rpcToken?: string,
): CredentialValidator {
  return async (candidate) => {
    let identity: AuthIdentity | undefined;
    try {
      identity = await authTokenService.identify(candidate);
    } catch {
      return undefined;
    }
    if (identity !== undefined) return identity;
    if (rpcToken !== undefined && candidate.length > 0 && timingSafeMatch(candidate, rpcToken)) {
      return { kind: 'rpc' };
    }
    return undefined;
  };
}
