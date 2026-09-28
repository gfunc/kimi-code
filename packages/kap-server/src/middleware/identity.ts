import type { FastifyRequest } from 'fastify';

import type { AuthIdentity } from '../services/auth/credentials';

const IDENTITY = Symbol('kapAuthIdentity');

type IdentityCarrier = { [IDENTITY]?: AuthIdentity };

export function setRequestIdentity(req: FastifyRequest, identity: AuthIdentity): void {
  (req as unknown as IdentityCarrier)[IDENTITY] = identity;
}

export function requestIdentity(req: object): AuthIdentity | undefined {
  return (req as unknown as IdentityCarrier)[IDENTITY];
}
