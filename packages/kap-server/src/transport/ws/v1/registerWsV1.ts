import type { IncomingMessage } from 'node:http';

import type { Scope } from '@moonshot-ai/agent-core-v2';
import { WebSocketServer } from 'ws';

import type { AuthIdentity, CredentialValidator } from '../../../services/auth/credentials';
import { type IConnectionRegistry } from '../connectionRegistry';
import type { ConnectionCredentialGuard } from '../credentialGuard';
import type { SessionEventBroadcaster } from './sessionEventBroadcaster';
import type { JournalLogger } from './sessionEventJournal';
import { WsConnectionV1 } from './wsConnectionV1';
import { selectWsBearerProtocol } from '../bearerProtocol';

export const WS_PATH = '/api/v1/ws';

export interface WsAuthContext {
  readonly credential: string;
  readonly identity: AuthIdentity;
}

export interface RegisterWsV1Options {
  readonly validateCredential?: CredentialValidator;
  readonly registry: IConnectionRegistry;
  readonly broadcaster: SessionEventBroadcaster;
  readonly logger?: JournalLogger;
  readonly maxBufferSize?: number;
  readonly flushIntervalMs?: number;
  readonly maxBatchSize?: number;
  readonly highWaterMarkBytes?: number;
  readonly heartbeatIntervalMs?: number;
  readonly guard?: ConnectionCredentialGuard;
  readonly authContext?: (req: IncomingMessage) => WsAuthContext | undefined;
}

export function registerWsV1(core: Scope, opts: RegisterWsV1Options): WebSocketServer {
  void core;
  const wss = new WebSocketServer({ noServer: true, handleProtocols: selectWsBearerProtocol });
  const { registry, broadcaster } = opts;

  wss.on('connection', (socket, req) => {
    const conn = new WsConnectionV1({
      socket,
      broadcaster,
      connectionRegistry: registry,
      validateCredential: opts.validateCredential,
      remoteAddress: req.socket.remoteAddress ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      logger: opts.logger,
      maxBufferSize: opts.maxBufferSize,
      flushIntervalMs: opts.flushIntervalMs,
      maxBatchSize: opts.maxBatchSize,
      highWaterMarkBytes: opts.highWaterMarkBytes,
      heartbeatIntervalMs: opts.heartbeatIntervalMs,
    });
    const auth = opts.authContext?.(req);
    if (auth !== undefined && opts.guard !== undefined) {
      opts.guard.attach({
        id: conn.id,
        credential: auth.credential,
        identity: auth.identity,
        close: () => conn.revoke(),
      });
    }
    socket.on('close', () => {
      opts.guard?.detach(conn.id);
      registry.remove(conn.id);
    });
  });

  return wss;
}
