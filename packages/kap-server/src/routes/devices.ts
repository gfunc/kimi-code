import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestIdentity } from '../middleware/identity';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { parseActionSuffix } from './action-suffix';
import type { IAuthTokenService } from '../services/auth/authTokenService';
import { isAcceptedIdentity } from '../services/auth/credentials';
import type { ConnectionCredentialGuard } from '../transport/ws/credentialGuard';

const HOST_ONLY_MSG = 'This route requires the host server token; device tokens are not allowed';

const deviceSummarySchema = z.object({
  device_id: z.string(),
  created_at: z.string(),
});
const devicesListResponseSchema = z.object({ devices: z.array(deviceSummarySchema) });
const deviceRevokeResponseSchema = z.object({
  device_id: z.string(),
  revoked: z.literal(true),
});
const deviceActionTailParamSchema = z.object({ tail: z.string().min(1) });

interface DevicesRouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (req: { id: string }, reply: DevicesReply) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (req: { id: string; params: { tail: string } }, reply: DevicesReply) => Promise<void> | void,
  ): unknown;
}

interface DevicesReply {
  code(status: number): DevicesReply;
  send(payload: unknown): unknown;
}

export interface DevicesRouteOptions {
  readonly authTokenService: IAuthTokenService;
  readonly guard?: ConnectionCredentialGuard;
}

export function registerDevicesRoutes(
  app: DevicesRouteHost,
  opts: DevicesRouteOptions,
): void {
  const requireHost = (req: { id: string }, reply: DevicesReply): boolean => {
    const identity = requestIdentity(req);
    if (identity === undefined) return true;
    if (isAcceptedIdentity(identity) && identity.kind !== 'device') return true;
    reply.code(403).send(errEnvelope(ErrorCode.AUTH_HOST_ONLY, HOST_ONLY_MSG, req.id));
    return false;
  };

  const list = defineRoute(
    {
      method: 'GET',
      path: '/api/v1/devices',
      success: { data: devicesListResponseSchema },
      errors: { [ErrorCode.AUTH_HOST_ONLY]: {} },
      description: 'List paired device tokens (host server token required)',
      tags: ['auth'],
    },
    async (req, reply) => {
      const r = reply as unknown as DevicesReply;
      if (!requireHost(req, r)) return;
      r.send(
        okEnvelope(
          {
            devices: opts.authTokenService.listDevices().map((device) => ({
              device_id: device.id,
              created_at: device.createdAt,
            })),
          },
          req.id,
        ),
      );
    },
  );

  const revoke = defineRoute(
    {
      method: 'POST',
      path: '/api/v1/devices/{tail}',
      params: deviceActionTailParamSchema,
      success: { data: deviceRevokeResponseSchema },
      errors: {
        [ErrorCode.AUTH_HOST_ONLY]: {},
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.DEVICE_NOT_FOUND]: {},
      },
      description:
        'Revoke one paired device token by device id and close its live connections (host server token required)',
      tags: ['auth'],
      operationId: 'runDeviceAction',
    },
    async (req, reply) => {
      const r = reply as unknown as DevicesReply;
      if (!requireHost(req, r)) return;
      const parsed = parseActionSuffix({
        tail: req.params.tail,
        allowedActions: ['revoke'],
        resourceLabel: 'device',
      });
      if (parsed.kind === 'invalid') {
        r.send({
          code: ErrorCode.VALIDATION_FAILED,
          msg: parsed.reason,
          data: null,
          request_id: req.id,
          details: [{ path: 'device_id', message: parsed.reason }],
        });
        return;
      }
      const revoked = await opts.authTokenService.revokeDeviceById(parsed.id);
      if (!revoked) {
        r.code(404).send(errEnvelope(ErrorCode.DEVICE_NOT_FOUND, `Unknown device: ${parsed.id}`, req.id));
        return;
      }
      opts.guard?.closeForDevice(parsed.id);
      r.send(okEnvelope({ device_id: parsed.id, revoked: true }, req.id));
    },
  );

  app.get(
    list.path,
    list.options,
    list.handler as unknown as Parameters<DevicesRouteHost['get']>[2],
  );
  app.post(
    revoke.path,
    revoke.options,
    revoke.handler as unknown as Parameters<DevicesRouteHost['post']>[2],
  );
}
