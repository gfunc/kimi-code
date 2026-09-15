/**
 * LAN pairing payload for the Kimi mobile app (spec §4.2).
 *
 * `kimi web --host` prints a `kimi://pair?…` QR next to the Local/Network
 * URLs so a phone can pair by scanning instead of typing host/port/token.
 * The QR travels out-of-band, so pairing is trust-on-first-use.
 */

import { isLoopbackHost, isWildcardHost } from './access-urls';
import type { NetworkAddress } from './networks';

export interface PairingParams {
  /** LAN IP the phone should connect to (raw address, no IPv6 brackets). */
  host: string;
  /** Actual listening port — after the server auto-incremented past a busy one. */
  port: number;
  /** Persistent server bearer token (`server.token`). */
  token: string;
  /** Human-facing machine alias (`os.hostname()`). */
  alias: string;
}

/** Filename of the pairing QR PNG fallback, written under the data dir. */
export const PAIRING_QR_PNG_FILE = 'pairing-qrcode.png';

/**
 * Build the `kimi://pair?host=<ip>&port=<port>&token=<token>&alias=<hostname>`
 * URI the mobile app consumes. Values are percent-encoded per URI query rules
 * (spaces as `%20`, not `+`).
 */
export function buildPairingUri(params: PairingParams): string {
  if (params.host === '') {
    throw new Error('pairing URI requires a host');
  }
  if (params.token === '') {
    throw new Error('pairing URI requires a token');
  }
  const query = [
    `host=${encodeURIComponent(params.host)}`,
    `port=${params.port}`,
    `token=${encodeURIComponent(params.token)}`,
    `alias=${encodeURIComponent(params.alias)}`,
  ].join('&');
  return `kimi://pair?${query}`;
}

/**
 * The host a phone on the LAN should connect to, derived from the bind host.
 *
 * A wildcard bind is not dialable, so it resolves to the primary LAN
 * interface address — the same first address the banner's `Network:` lines
 * list (IPv4 first). A specific non-loopback bind is used as-is. Loopback
 * binds never pair (nothing off-machine can reach them), and neither do
 * wildcard binds without a usable address; both return `undefined`.
 */
export function pairingLanHost(
  bindHost: string,
  addresses: readonly NetworkAddress[],
): string | undefined {
  if (isLoopbackHost(bindHost)) return undefined;
  if (isWildcardHost(bindHost)) return addresses[0]?.address;
  return bindHost;
}
