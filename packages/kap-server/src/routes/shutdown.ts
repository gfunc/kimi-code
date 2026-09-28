import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestIdentity } from '../middleware/identity';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { isAcceptedIdentity } from '../services/auth/credentials';
import { requestLog } from '../lib/requestLog';

interface ShutdownRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export interface ShutdownRouteOptions {
  readonly onShutdown: () => void;
}

export function registerShutdownRoutes(
  app: ShutdownRouteHost,
  opts: ShutdownRouteOptions,
): void {
  const route = defineRoute(
    {
      method: 'POST',
      path: '/shutdown',
      success: { data: z.object({ ok: z.literal(true) }) },
      errors: { [ErrorCode.AUTH_HOST_ONLY]: {} },
      description: 'Gracefully shut down the server (host identity required)',
      tags: ['meta'],
    },
    (req, reply) => {
      const identity = requestIdentity(req);
      if (identity !== undefined && !(isAcceptedIdentity(identity) && identity.kind !== 'device')) {
        const r = reply as unknown as { code(status: number): { send(payload: unknown): unknown } };
        r.code(403).send(
          errEnvelope(
            ErrorCode.AUTH_HOST_ONLY,
            'Shutting down the host requires the host server token; device tokens are not allowed',
            req.id,
          ),
        );
        return;
      }
      requestLog(req)?.info(
        { remoteAddress: (req as unknown as { ip?: string }).ip },
        'shutdown requested',
      );
      reply.send(okEnvelope({ ok: true }, req.id));
      setImmediate(() => opts.onShutdown());
    },
  );
  app.post(
    route.path,
    route.options,
    route.handler as Parameters<ShutdownRouteHost['post']>[2],
  );
}
