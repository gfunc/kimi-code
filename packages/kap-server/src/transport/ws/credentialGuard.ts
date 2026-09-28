import type { AuthIdentity, CredentialValidator } from '../../services/auth/credentials';
import { isAcceptedIdentity } from '../../services/auth/credentials';

export interface GuardedConnection {
  readonly id: string;
  readonly credential: string;
  readonly identity: AuthIdentity;
  close(): void;
}

export interface ConnectionCredentialGuard {
  attach(conn: GuardedConnection): void;
  detach(connId: string): void;
  closeForDevice(deviceId: string): number;
  startRevalidation(validate: CredentialValidator, intervalMs: number): void;
  dispose(): void;
}

const REVOCABLE_KINDS: ReadonlySet<AuthIdentity['kind']> = new Set(['server', 'device']);

export function createConnectionCredentialGuard(): ConnectionCredentialGuard {
  const tracked = new Map<string, GuardedConnection>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const drop = (connId: string): void => {
    const conn = tracked.get(connId);
    if (conn === undefined) return;
    tracked.delete(connId);
    try {
      conn.close();
    } catch {
    }
  };

  return {
    attach: (conn) => {
      tracked.set(conn.id, conn);
    },
    detach: (connId) => {
      tracked.delete(connId);
    },
    closeForDevice: (deviceId) => {
      let closed = 0;
      for (const conn of tracked.values()) {
        if (conn.identity.kind !== 'device' || conn.identity.deviceId !== deviceId) continue;
        drop(conn.id);
        closed += 1;
      }
      return closed;
    },
    startRevalidation: (validate, intervalMs) => {
      if (timer !== undefined || intervalMs <= 0) return;
      timer = setInterval(() => {
        void (async () => {
          for (const conn of tracked.values()) {
            if (!REVOCABLE_KINDS.has(conn.identity.kind)) continue;
            let valid = true;
            try {
              valid = isAcceptedIdentity(await validate(conn.credential));
            } catch {
              valid = false;
            }
            if (!valid) drop(conn.id);
          }
        })();
      }, intervalMs);
      timer.unref?.();
    },
    dispose: () => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      tracked.clear();
    },
  };
}
