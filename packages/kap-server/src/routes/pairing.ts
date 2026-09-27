import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import type { IAuthTokenService } from '../services/auth/authTokenService';

const PAIRING_ERROR_CODE = 40101;
const PAIRING_ERROR_MSG = 'Invalid or expired pairing code';

const pairingExchangeRequestSchema = z.object({ code: z.string().min(1) });
const pairingExchangeResponseSchema = z.object({
  token: z.string(),
  scope: z.literal('device'),
});

interface PairingRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (req: { id: string; body: unknown }, reply: PairingReply) => Promise<void> | void,
  ): unknown;
}

interface PairingReply {
  code(status: number): PairingReply;
  send(payload: unknown): unknown;
}

export function registerPairingRoutes(
  app: PairingRouteHost,
  authTokenService: IAuthTokenService,
): void {
  const route = defineRoute(
    {
      method: 'POST',
      path: '/api/v1/pairing/exchange',
      body: pairingExchangeRequestSchema,
      success: { data: pairingExchangeResponseSchema },
      errors: { [PAIRING_ERROR_CODE]: {} },
      description: 'Exchange a short-lived single-use pairing code for a device bearer token',
      tags: ['auth'],
    },
    async (req, reply) => {
      const { code } = req.body;
      const exchange = await authTokenService.exchangePairingCode(code);
      const r = reply as unknown as PairingReply;
      if (exchange === undefined) {
        r.code(401).send(errEnvelope(PAIRING_ERROR_CODE, PAIRING_ERROR_MSG, req.id));
        return;
      }
      r.send(okEnvelope(exchange, req.id));
    },
  );
  app.post(
    route.path,
    route.options,
    route.handler as unknown as Parameters<PairingRouteHost['post']>[2],
  );
}
