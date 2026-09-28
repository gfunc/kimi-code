/**
 * LAN pairing payload for the Kimi mobile app (spec §4.2).
 *
 * `kimi web --host` prints a `kimi://pair?…` QR next to the Local/Network
 * URLs so a phone can pair by scanning instead of typing host/port/code.
 * The QR travels out-of-band, so pairing is trust-on-first-use.
 */

import { stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { isLoopbackHost, isWildcardHost } from './access-urls';
import type { NetworkAddress } from './networks';

export interface PairingParams {
  /** LAN IP the phone should connect to (raw address, no IPv6 brackets). */
  host: string;
  /** Actual listening port — after the server auto-incremented past a busy one. */
  port: number;
  /** Short-lived, single-use pairing exchange code. */
  code: string;
  /** Human-facing machine alias (`os.hostname()`). */
  alias: string;
}

/** Filename of the pairing QR PNG fallback, written under the data dir. */
export const PAIRING_QR_PNG_FILE = 'pairing-qrcode.png';

/**
 * A pairing PNG older than this is provably dead residue: the exchange code
 * inside is single-use and dies with the ~60s pairing window, so the file can
 * never complete a pairing again. Two code lifetimes, so the sweep never
 * removes a file whose code could still be live — including one a
 * concurrently running instance has just written.
 */
export const PAIRING_QR_PNG_STALE_MS = 120_000;

export interface RemoveStalePairingQrPngOptions {
  /** Data dir holding the fixed `pairing-qrcode.png` path. */
  dataDir: string;
  /** Clock override for tests. */
  now?: number;
  /** Age threshold override for tests. */
  maxAgeMs?: number;
}

/**
 * Best-effort removal of the pairing QR PNG at its one fixed
 * `<dataDir>/pairing-qrcode.png` path — and only that path — once it is older
 * than the pairing-code lifetime. Shared files (`rc-qrcode.png`, anything
 * else in the dir) are never touched, and every error is swallowed (missing
 * file, a PNG held open by a Windows image viewer, ...): cleanup is advisory,
 * never fail-worthy. Returns whether a file was removed.
 */
export async function removeStalePairingQrPng(
  options: RemoveStalePairingQrPngOptions,
): Promise<boolean> {
  try {
    const pngPath = join(options.dataDir, PAIRING_QR_PNG_FILE);
    const info = await stat(pngPath);
    if (!info.isFile()) return false;
    const ageMs = (options.now ?? Date.now()) - info.mtimeMs;
    if (ageMs <= (options.maxAgeMs ?? PAIRING_QR_PNG_STALE_MS)) return false;
    await unlink(pngPath);
    return true;
  } catch {
    return false;
  }
}

/** Distinguishes "the file we wrote" from "a file another instance wrote". */
export interface PairingPngIdentity {
  readonly mtimeMs: number;
  readonly size: number;
}

/**
 * Snapshot the current pairing PNG's identity, or `undefined` when there is
 * nothing readable at the fixed path.
 */
export async function statPairingPng(
  dataDir: string,
): Promise<PairingPngIdentity | undefined> {
  try {
    const info = await stat(join(dataDir, PAIRING_QR_PNG_FILE));
    return info.isFile() ? { mtimeMs: info.mtimeMs, size: info.size } : undefined;
  } catch {
    return undefined;
  }
}

export interface RemoveOwnedPairingPngOptions {
  dataDir: string;
  /** Identity captured right after this process wrote the PNG; omit = nothing of ours to remove. */
  owned?: PairingPngIdentity;
}

/**
 * Remove the pairing PNG only if it is still exactly the file this process
 * wrote — same mtime and size as the captured identity — so a concurrently
 * pairing instance's overwrite is never deleted. Honesty note: the
 * stat→unlink check narrows the cross-instance race but cannot close it —
 * if another instance overwrites the file between our stat and our unlink,
 * this removes their just-written PNG (their terminal QR keeps working; only
 * their PNG fallback path goes stale until their next reprint or the next
 * age-gated sweep). Closing the window fully would need file locking, which
 * this deliberately does not add. Best-effort: returns whether the file was
 * removed.
 */
export async function removeOwnedPairingQrPng(
  options: RemoveOwnedPairingPngOptions,
): Promise<boolean> {
  const owned = options.owned;
  if (owned === undefined) return false;
  try {
    const pngPath = join(options.dataDir, PAIRING_QR_PNG_FILE);
    const info = await stat(pngPath);
    if (!info.isFile()) return false;
    if (info.mtimeMs !== owned.mtimeMs || info.size !== owned.size) return false;
    await unlink(pngPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the `kimi://pair?host=<ip>&port=<port>&code=<code>&alias=<hostname>`
 * URI the mobile app consumes. Values are percent-encoded per URI query rules
 * (spaces as `%20`, not `+`).
 */
export function buildPairingUri(params: PairingParams): string {
  if (params.host === '') {
    throw new Error('pairing URI requires a host');
  }
  if (params.code === '') {
    throw new Error('pairing URI requires a code');
  }
  const query = [
    `host=${encodeURIComponent(params.host)}`,
    `port=${params.port}`,
    `code=${encodeURIComponent(params.code)}`,
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
