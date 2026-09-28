/**
 * `kimi web` — run the local server in the foreground and open the web UI.
 *
 * The server always runs in the current process, attached to the terminal,
 * and shuts down cleanly on SIGINT/SIGTERM. `--no-open` skips the browser.
 * Multiple instances can share the home directory: each registers itself in
 * the instance registry and takes the next free port (see kap-server's
 * `startServer`).
 */

import { existsSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';

import { createServerLogger, startServer, type ServerLogger } from '@moonshot-ai/kap-server';
import { shutdownTelemetry, track } from '@moonshot-ai/kimi-telemetry';
import chalk from 'chalk';
import { type Command, Option } from 'commander';

import { CLI_SHUTDOWN_TIMEOUT_MS, WEB_USER_AGENT_SUFFIX } from '#/constant/app';
import { getNativeWebAssetsDir } from '#/native/web-assets';
import { darkColors } from '#/tui/theme/colors';
import { openUrl as defaultOpenUrl } from '#/utils/open-url';
import { getDataDir } from '#/utils/paths';
import { persistedKimiOAuthRef } from '#/utils/region';
import { generateQr, generateRemoteControlQr } from '#/utils/remote-control-qr';

import { initializeServerTelemetry } from '../../telemetry';
import {
  createKimiCodeHostIdentity,
  getHostPackageRoot,
  getVersion,
} from '../../version';
import {
  accessUrlLines,
  browserOpenOrigin,
  buildOpenableUrl,
  isLoopbackHost,
  splitTokenFragment,
} from './access-urls';
import { listNetworkAddresses, type NetworkAddress } from './networks';
import {
  buildPairingUri,
  pairingLanHost,
  PAIRING_QR_PNG_FILE,
  removeOwnedPairingQrPng,
  removeStalePairingQrPng,
  statPairingPng,
  type PairingPngIdentity,
} from './pairing';
import {
  formatRemoteControlOutput,
  formatRemoteControlStatus,
  startRemoteControl,
  type RemoteControlHandle,
  type RemoteControlOptions,
  type RemoteControlStatus,
} from './remote-control';
import {
  DEFAULT_FOREGROUND_LOG_LEVEL,
  DEFAULT_LAN_HOST,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  parseServerOptions,
  tryResolveServerToken,
  VALID_LOG_LEVELS,
  type ParsedServerOptions,
  type ServerCliOptions,
} from './shared';

const WEB_ASSETS_DIR = 'dist-web';

/**
 * Minimal surface `runServerInProcess` needs from the server. kap-server's
 * `RunningServer` is adapted to it (it returns `{ host, port, close }`
 * instead of `{ address, logger, close }`).
 */
interface RoutedServer {
  readonly address: string;
  readonly logger: ServerLogger;
  readonly createPairingCode: () => string;
  close(): Promise<void>;
}

export interface WebCliOptions extends ServerCliOptions {
  open?: boolean;
  remoteControl?: boolean;
}

export interface StartForegroundHooks {
  /** Fires once the server is listening, before the foreground runner blocks. */
  onReady?: (origin: string, createPairingCode: () => string) => void | Promise<void>;
  /**
   * Fires when the user asks for a reprint of the ready banner (a fresh
   * pairing QR). The runner registers the platform-appropriate trigger: the
   * SIGUSR2 signal on POSIX, the raw-mode `R` key on a Windows foreground
   * TTY. Never registered when the full banner is not shown.
   */
  onReprint?: () => void | Promise<void>;
  onShutdown?: (reason: string) => void | Promise<void>;
}

/** Keys the interactive reprint listener reacts to. */
const REPRINT_KEY_CTRL_C = 0x03;
const REPRINT_KEY_R_LOWER = 0x72;
const REPRINT_KEY_R_UPPER = 0x52;

/**
 * The streams the interactive reprint listener runs against; injectable so
 * tests can drive it without a real terminal.
 */
export interface InteractiveReprintIo {
  stdin: {
    isTTY?: boolean;
    setRawMode(mode: boolean): unknown;
    resume(): unknown;
    pause(): unknown;
    on(event: string, listener: (chunk: string | Buffer) => void): unknown;
    removeListener(event: string, listener: (chunk: string | Buffer) => void): unknown;
  };
  stdout: { isTTY?: boolean };
}

/**
 * Whether the interactive reprint key listener can run: Windows only (POSIX
 * reprints via SIGUSR2, which Windows lacks) and only with a real interactive
 * terminal on both ends — stdin to receive the keypress, stdout so the user
 * can actually see the banner being reprinted.
 */
export function canInteractiveReprint(
  platform: NodeJS.Platform,
  stdin: { isTTY?: boolean } | undefined,
  stdout: { isTTY?: boolean } | undefined,
): boolean {
  return platform === 'win32' && stdin?.isTTY === true && stdout?.isTTY === true;
}

/**
 * Windows-safe reprint trigger for the foreground pairing banner: raw-mode
 * stdin watches for `R` (reprint) and Ctrl+C (quit). Raw mode necessarily
 * hides Ctrl+C from the terminal driver on every platform, so the listener
 * forwards `\x03` to `onQuit` — the graceful SIGINT shutdown — instead of
 * swallowing it. The returned stop function removes the listener and restores
 * cooked mode immediately, so any later Ctrl+C flows natively again; it is
 * idempotent and absorbs console errors, so a broken terminal can never block
 * or crash the shutdown that calls it.
 */
export function startInteractiveReprint(
  io: InteractiveReprintIo,
  onReprint: () => void,
  onQuit: () => void,
): () => void {
  const stdin = io.stdin;
  const onKey = (chunk: string | Buffer): void => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    if (bytes.includes(REPRINT_KEY_CTRL_C)) {
      onQuit();
      return;
    }
    // Reprint only on an exact lone R keystroke — a pasted burst that happens
    // to contain an `r` must not repaint the banner.
    if (
      bytes.length === 1 &&
      (bytes[0] === REPRINT_KEY_R_LOWER || bytes[0] === REPRINT_KEY_R_UPPER)
    ) {
      onReprint();
    }
  };
  // Setup failures roll everything back: a half-started listener must never
  // survive with raw mode on, swallowing Ctrl+C with no quit handler.
  stdin.on('data', onKey);
  try {
    stdin.setRawMode(true);
    stdin.resume();
  } catch (error) {
    // Un-raw first so a Ctrl+C during the rollback stays native, then remove
    // the listener; the rollback itself is best-effort.
    try {
      stdin.setRawMode(false);
    } catch {
      // Console is broken; the rethrow below still surfaces the cause.
    }
    stdin.removeListener('data', onKey);
    throw error;
  }
  let stopped = false;
  // Best-effort: a wedged console must never break the stop path (K3).
  const tryRun = (op: () => unknown): void => {
    try {
      op();
    } catch {
      // Console already gone; nothing left to restore.
    }
  };
  return () => {
    if (stopped) return;
    stopped = true;
    tryRun(() => stdin.removeListener('data', onKey));
    tryRun(() => stdin.setRawMode(false));
    tryRun(() => stdin.pause());
  };
}

export interface WebCommandDeps {
  /** Foreground runner; defaults to the real in-process runner when omitted. */
  startServerForeground?: (
    options: ParsedServerOptions,
    hooks?: StartForegroundHooks,
    io?: InteractiveReprintIo,
  ) => Promise<never>;
  startRemoteControl?: (options: RemoteControlOptions) => Promise<RemoteControlHandle>;
  openUrl(url: string): void;
  /**
   * Best-effort read of the server's persistent bearer token. When it returns
   * a token, the ready banner prints it and the opened Web UI URL carries it in
   * the `#token=` fragment (M5.5). Optional so callers/tests that don't supply
   * it simply print/open the plain origin.
   */
  resolveToken?: () => string | undefined;
  /**
   * Non-loopback interface addresses to display for a wildcard bind. Defaults
   * to the machine's own interfaces (`listNetworkAddresses()`); inject a fixed
   * list in tests for deterministic output.
   */
  networkAddresses?: NetworkAddress[];
  /**
   * Machine alias embedded in the LAN pairing QR payload. Defaults to
   * `os.hostname()`; inject a fixed one in tests for deterministic output.
   */
  hostname?: () => string;
  /**
   * Terminal streams used for the win32 interactive reprint: both the
   * banner's Reprint-hint decision and the foreground runner's key listener
   * judge this exact object, so the hint can never promise a key the listener
   * would not hear. Defaults to the process's own terminal streams.
   */
  interactiveIo?: InteractiveReprintIo;
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

/**
 * Build the Web UI URL, carrying the bearer token in the URL fragment.
 *
 * The token rides in `#token=<token>` — a client-side fragment that is never
 * sent to the server (so it never appears in server access logs) and is not
 * logged by proxies. The Web UI reads it from `location.hash` after load.
 */
export function buildWebUrl(origin: string, token: string): string {
  return buildOpenableUrl(origin, token);
}

/** Build the `web` command, mounting the runner action on `cmd` itself. */
export function buildWebCommand(
  cmd: Command,
  opts: { forceRemoteControl?: boolean } = {},
): Command {
  const forceRemoteControl = opts.forceRemoteControl === true;
  const withServerOptions = cmd
    .option(
      '--port <port>',
      `Bind port (default ${DEFAULT_SERVER_PORT})`,
      String(DEFAULT_SERVER_PORT),
    )
    .option(
      '--host [host]',
      `Bind host. Omit to bind ${DEFAULT_SERVER_HOST} (this machine only); pass --host to bind ${DEFAULT_LAN_HOST} (all interfaces), or --host <host> for a specific host. The bearer token is printed at startup.`,
    )
    .option(
      '--allowed-host <host...>',
      'Extra Host header value to allow through the DNS-rebinding check. Repeat or comma-separate; a leading dot matches a domain suffix (e.g. .example.com).',
    )
    .option(
      '--insecure-no-tls',
      'Allow a non-loopback bind without a TLS-terminating reverse proxy. Defaults to true; only relevant for non-loopback binds.',
      true,
    )
    .option(
      '--allow-remote-shutdown',
      'On a non-loopback bind, keep POST /api/v1/shutdown enabled (default: route is disabled → 404).',
      false,
    )
    .option(
      '--dangerous-bypass-auth',
      'Disable bearer-token auth on every REST and WebSocket route, and advertise it via /api/v1/meta so the web UI connects without a token. Only use on a trusted network or behind your own authenticating proxy.',
      false,
    )
    .option(
      '--log-level <level>',
      `Server log level: ${VALID_LOG_LEVELS.join('|')}. Omit to keep logs off.`,
    )
    .option(
      '--debug-endpoints',
      'Mount /api/v1/debug/* routes for test introspection. OFF by default; production callers leave this unset.',
      false,
    )
    .option(
      '--web-title <title>',
      'Set a custom browser tab title for this web UI instance (default: "<workspace dir> | Kimi Code").',
    );
  if (!forceRemoteControl) {
    withServerOptions.addOption(
      new Option(
        '--rc, --remote-control',
        'Expose the web UI through Kimi Remote Control.',
      ).default(false),
    );
  }
  return withServerOptions
    .option('--no-open', 'Do not open the web UI in the default browser.', true)
    .action(async (opts: WebCliOptions) => {
      try {
        await handleWebCommand(
          forceRemoteControl ? { ...opts, remoteControl: true } : opts,
        );
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}

export async function handleWebCommand(
  opts: WebCliOptions,
  deps: WebCommandDeps = DEFAULT_WEB_COMMAND_DEPS,
): Promise<void> {
  const parsed = parseServerOptions(opts);
  if (opts.remoteControl === true && parsed.dangerousBypassAuth) {
    throw new Error('--remote-control cannot be combined with --dangerous-bypass-auth.');
  }
  if (opts.remoteControl === true && !isLoopbackHost(parsed.host)) {
    throw new Error('--remote-control requires a loopback host.');
  }
  const run = deps.startServerForeground ?? startServerForeground;
  let remoteControl: RemoteControlHandle | undefined;
  // The banner's Reprint hint and the runner's key listener must judge the
  // same terminal, so one io object feeds both.
  const io: InteractiveReprintIo = deps.interactiveIo ?? {
    stdin: process.stdin,
    stdout: process.stdout,
  };
  // Only the full ready banner carries the pairing QR; a reprint trigger for
  // the compact line (or an auth-bypass run, which never pairs) is pointless.
  // The runner picks the trigger per platform: SIGUSR2 on POSIX, the raw-mode
  // `R` key on a Windows foreground TTY, nothing on Windows without a
  // terminal (the banner then points at a restart instead).
  const canReprint =
    opts.remoteControl !== true &&
    !parsed.dangerousBypassAuth &&
    parsed.logLevel === DEFAULT_FOREGROUND_LOG_LEVEL;
  // Sweep a pairing QR PNG left on the fixed path by an earlier run that died
  // without cleanup (loopback / remote-control / restarted / crashed /
  // expired). Age-gated: a file still inside the pairing-code window is never
  // removed, so a concurrently running pairing instance keeps its freshly
  // written QR. A pairing run regenerates the file moments later either way.
  await removeStalePairingQrPng({ dataDir: getDataDir() });
  let printReady: (() => Promise<void>) | undefined;
  let writtenPairingPng: PairingPngIdentity | undefined;
  await run(
    parsed,
    {
      onReady: async (origin, createPairingCode) => {
        // Resolve the persistent token only once the server is up: a fresh
        // server writes `server.token` on first boot, so reading it beforehand
        // would miss first-time starts and the browser would hit the auth gate.
        // It is printed in the ready banner and rides in the opened Web UI
        // URL's `#token=` fragment (M5.5); falls back to the plain origin / no
        // token line when unavailable. When auth is bypassed, the token is
        // meaningless and is intentionally NOT shown or carried in the URL.
        const token = parsed.dangerousBypassAuth ? undefined : deps.resolveToken?.();
        if (opts.remoteControl === true) {
          if (token === undefined) throw new Error('Unable to read the local server token.');
          const dataDir = getDataDir();
          const persisted = persistedKimiOAuthRef();
          let outputReady = false;
          const pendingStatuses: string[] = [];
          const onStatus = (status: RemoteControlStatus): void => {
            const line = formatRemoteControlStatus(status);
            if (outputReady) deps.stdout.write(line);
            else pendingStatuses.push(line);
          };
          remoteControl = await (deps.startRemoteControl ?? startRemoteControl)({
            homeDir: dataDir,
            localOrigin: origin,
            localServerToken: token,
            clientVersion: `kimi-code/${getVersion()}`,
            configuredOAuthKey: persisted?.key,
            configuredOAuthHost: persisted?.oauthHost,
            stderr: deps.stderr,
            onStatus,
          });
          const qrCode = await generateRemoteControlQr(remoteControl.url, dataDir);
          deps.stdout.write(
            formatRemoteControlOutput({
              url: remoteControl.url,
              localOrigin: origin,
              localServerToken: token,
              deviceName: remoteControl.deviceName,
              qrCode: qrCode.terminal,
              pngPath: qrCode.pngPath,
            }),
          );
          outputReady = true;
          for (const line of pendingStatuses) deps.stdout.write(line);
          if (opts.open === true) deps.openUrl(remoteControl.url);
          return;
        }
        const print = async (): Promise<void> => {
          // The pairing QR is generated only for the full banner: the compact
          // `--log-level` line has no Pairing section, and minting a
          // single-use code into an undisplayed QR/PNG would leak a secret to
          // the data dir for nothing (K3).
          if (parsed.logLevel !== DEFAULT_FOREGROUND_LOG_LEVEL) {
            deps.stdout.write(formatReadyLine(origin, token, parsed.dangerousBypassAuth));
            return;
          }
          const pairingQr = await generatePairingQr(
            origin,
            parsed.host,
            parsed.dangerousBypassAuth ? undefined : createPairingCode(),
            deps,
          );
          if (pairingQr !== undefined) {
            // Snapshot what we wrote so shutdown removes the file only while
            // it still matches this identity (mtime + size); that check
            // narrows the overwrite race but cannot fully close it.
            writtenPairingPng = await statPairingPng(getDataDir());
          }
          deps.stdout.write(
            formatReadyBanner(origin, parsed.host, {
              token,
              networkAddresses: deps.networkAddresses,
              dangerousBypassAuth: parsed.dangerousBypassAuth,
              pairingQr,
              reprintHint: canReprint ? formatReprintHint(io) : undefined,
            }),
          );
        };
        printReady = print;
        await print();
        if (opts.open === true) {
          const openOrigin = browserOpenOrigin(origin);
          deps.openUrl(token !== undefined ? buildWebUrl(openOrigin, token) : openOrigin);
        }
      },
      onReprint: canReprint
        ? () => {
            void printReady?.();
          }
        : undefined,
      onShutdown: async () => {
        await remoteControl?.close();
        // K3: a Ctrl+C right after pairing must leave no residue, so the
        // writer takes its PNG back immediately — but only while the file is
        // still exactly what this run wrote (mtime + size identity), never a
        // file a concurrently pairing instance has since overwritten. Anything
        // else is left to the next run's age-gated startup sweep.
        await removeOwnedPairingQrPng({ dataDir: getDataDir(), owned: writtenPairingPng });
      },
    },
    io,
  );
}

/**
 * The Reprint hint in the banner's pairing block. POSIX keeps the SIGUSR2
 * one-liner (works with or without a terminal); a Windows foreground TTY gets
 * the interactive key; Windows without a terminal can only restart.
 */
function formatReprintHint(io: InteractiveReprintIo): string {
  if (process.platform !== 'win32') return `kill -USR2 ${process.pid}`;
  const interactive = canInteractiveReprint(process.platform, io.stdin, io.stdout);
  return interactive ? 'press R' : 'restart kimi web';
}

function formatReadyLine(
  origin: string,
  token: string | undefined,
  dangerousBypassAuth = false,
): string {
  const notice = dangerousBypassAuth
    ? `${formatDangerNoticeLines().join('\n')}\n`
    : '';
  return `${notice}Kimi server: ${buildOpenableUrl(origin, token)}\n`;
}

/**
 * Red, impossible-to-miss notice emitted when `--dangerous-bypass-auth`
 * disables the bearer-token gate. Shared by the full ready banner and the
 * compact one-line output so the warning always shows regardless of log level.
 */
function formatDangerNoticeLines(): string[] {
  const danger = (text: string): string => chalk.hex(darkColors.error)(text);
  const dangerBold = (text: string): string => chalk.bold.hex(darkColors.error)(text);
  return [
    `  ${dangerBold('⚠ DANGER: authentication is DISABLED (--dangerous-bypass-auth).')}`,
    `  ${danger('Anyone who can reach this port gets full access. Only continue if you understand the risk.')}`,
    `  ${danger('If you are unsure, stop this process now with ')}${dangerBold('Ctrl+C')}${danger('.')}`,
  ];
}

/**
 * `kimi web` — runs the local server in-process, attached to the current
 * terminal. Resolves only via `process.exit` (SIGINT/SIGTERM). `io` injects
 * the streams for the win32 interactive key reprint; defaults to the real
 * terminal.
 */
export async function startServerForeground(
  options: ParsedServerOptions,
  hooks: StartForegroundHooks = {},
  io: InteractiveReprintIo = { stdin: process.stdin, stdout: process.stdout },
): Promise<never> {
  return runServerInProcess(options, hooks, io);
}

/**
 * Start the server in the current process and block until shutdown.
 * `onReady` fires once the server is listening.
 */
async function runServerInProcess(
  options: ParsedServerOptions,
  hooks: StartForegroundHooks,
  io: InteractiveReprintIo,
): Promise<never> {
  const version = getVersion();
  // Registers the telemetry provider for `track` / `shutdownTelemetry`; the
  // client itself is not passed into kap-server.
  initializeServerTelemetry({ version });

  let running: RoutedServer | undefined;
  let stopping = false;
  let stopInteractiveReprint: (() => void) | undefined;

  const reprintError = (error: unknown): void => {
    running?.logger.error(
      { err: error instanceof Error ? error : new Error(String(error)) },
      'reprint hook error',
    );
  };
  const invokeReprintHook = (): Promise<void> =>
    Promise.resolve()
      .then(() => hooks.onReprint?.())
      .catch(reprintError);

  const onSigint = (): void => {
    void shutdown('SIGINT');
  };
  const onSigterm = (): void => {
    void shutdown('SIGTERM');
  };

  async function shutdown(reason: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    // K3: detach the one-shot lifecycle listeners now that shutdown is under
    // way, so any further SIGINT/SIGTERM falls through to Node's default hard
    // termination instead of re-entering this no-op guard. Symmetric for both
    // signals.
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    // Restore the terminal first: raw mode would otherwise survive every
    // await below (and process.exit) and eat the user's keystrokes. A console
    // that refuses the restore is logged and skipped — it must never stop the
    // shutdown from reaching process.exit.
    try {
      stopInteractiveReprint?.();
    } catch (error) {
      running?.logger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        'terminal restore failed',
      );
    }
    running?.logger.info({ reason }, 'server shutting down');
    try {
      await hooks.onShutdown?.(reason);
    } catch (error) {
      running?.logger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        'foreground shutdown hook error',
      );
    }
    try {
      await running?.close();
      await shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS });
    } catch (error) {
      running?.logger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        'server shutdown error',
      );
    }
    process.exit(0);
  }

  // kap-server (the DI × Scope engine server) is the only server flavor. Its
  // `startServer` returns `{ host, port, close }` rather than `{ address,
  // logger, close }`, so adapt it to the `RoutedServer` surface the rest of
  // this runner consumes.
  const logger = createServerLogger({ level: options.logLevel });
  const webAssetsDir = serverWebAssetsDir();
  if (webAssetsDir === undefined) {
    logger.info(
      'dev mode: web assets not built; starting the API server without the web UI',
    );
  }
  const v2 = await startServer({
    host: options.host,
    port: options.port,
    // Report the CLI's product version as `server_version` (/meta, web UI)
    // rather than kap-server's private package version.
    serverVersion: version,
    // The CLI's host identity: feeds the engine's bootstrap client identity
    // and the derived outbound headers (User-Agent + X-Msh-*), so web-UI
    // OAuth flows and model / WebSearch requests carry the CLI identity. The
    // `web` User-Agent suffix distinguishes web-UI traffic from direct CLI
    // runs upstream (same product token, same platform).
    hostIdentity: {
      ...createKimiCodeHostIdentity(version),
      userAgentSuffix: WEB_USER_AGENT_SUFFIX,
    },
    logLevel: options.logLevel,
    logger,
    debugEndpoints: options.debugEndpoints,
    insecureNoTls: options.insecureNoTls,
    allowRemoteShutdown: options.allowRemoteShutdown,
    allowedHosts: options.allowedHosts,
    disableAuth: options.dangerousBypassAuth,
    webTitle: options.webTitle,
    // Attach the engine's cloud telemetry appender (still gated by the config
    // `telemetry` toggle). Complements the v1 client registered above, which
    // only covers host-level events.
    telemetry: true,
    webAssetsDir,
  });
  logger.info('serving the REST/WS API and the bundled web UI');
  running = {
    address: `http://${v2.host}:${v2.port}`,
    logger,
    createPairingCode: v2.createPairingCode,
    close: () => v2.close(),
  };

  track('server_started', { daemon: false });

  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  if (hooks.onReprint !== undefined && process.platform !== 'win32') {
    // SIGUSR2 is POSIX-only: `process.on('SIGUSR2')` throws ERR_UNKNOWN_SIGNAL
    // on Windows, where the interactive key listener takes over instead.
    process.on('SIGUSR2', () => {
      void invokeReprintHook();
    });
  }

  running.logger.info({ address: running.address }, 'server ready');

  try {
    await hooks.onReady?.(running.address, running.createPairingCode);
  } catch (error) {
    try {
      await hooks.onShutdown?.('startup_failed');
    } finally {
      await running.close();
      await shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS }).catch(() => {});
    }
    throw error;
  }

  if (
    hooks.onReprint !== undefined &&
    canInteractiveReprint(process.platform, io.stdin, io.stdout)
  ) {
    // Windows foreground TTY: the raw-mode `R` key reprints (a fresh pairing
    // QR); Ctrl+C is forwarded to the graceful SIGINT shutdown instead of
    // being swallowed by raw mode. The TUI's `/web`/`/rc` handoff never
    // supplies `onReprint`, so its own stdin handling is untouched.
    try {
      const stopKeys = startInteractiveReprint(
        io,
        () => void invokeReprintHook(),
        () => void shutdown('SIGINT'),
      );
      // Abnormal exits (an uncaught error anywhere, process.exit not via
      // shutdown) would otherwise leave the terminal stuck in raw mode; the
      // 'exit' hook hands it back synchronously on every exit path. The stop
      // function is idempotent, so running after shutdown's own restore is a
      // no-op.
      const restoreTerminal = (): void => {
        stopKeys();
        process.off('exit', restoreTerminal);
      };
      process.on('exit', restoreTerminal);
      stopInteractiveReprint = restoreTerminal;
    } catch (error) {
      reprintError(error);
    }
  }

  return new Promise<never>(() => {
    // Keeps the event loop alive; the process ends via shutdown()/process.exit.
  });
}

/**
 * Resolve the web assets directory passed to kap-server. In dev mode
 * (`KIMI_CODE_DEV_SERVER=1`, set by the repo's `dev:server` / `dev:kap-server*`
 * scripts) a missing `dist-web` build is tolerated: the server starts API-only
 * and the web UI is expected to come from a Vite dev server (the web UI source lives in the code-app repo).
 * Outside dev mode the directory is always returned and kap-server keeps
 * failing fast when the assets are missing.
 */
export function serverWebAssetsDir(
  env: NodeJS.ProcessEnv = process.env,
  nativeWebAssetsDir: string | null = getNativeWebAssetsDir(),
): string | undefined {
  const dir = resolveServerWebAssetsDir(nativeWebAssetsDir);
  if (env['KIMI_CODE_DEV_SERVER'] === '1' && !existsSync(join(dir, 'index.html'))) {
    return undefined;
  }
  return dir;
}

export function resolveServerWebAssetsDir(
  nativeWebAssetsDir: string | null = getNativeWebAssetsDir(),
): string {
  return nativeWebAssetsDir ?? join(getHostPackageRoot(), WEB_ASSETS_DIR);
}

interface FormatReadyBannerOptions {
  /** Persistent bearer token to print; omitted when unresolvable. */
  token?: string;
  /** Non-loopback interface addresses to list for a wildcard bind. */
  networkAddresses?: NetworkAddress[];
  /** When true, render a red danger notice (auth is disabled). */
  dangerousBypassAuth?: boolean;
  /** LAN pairing QR for the mobile app (spec §4.2); omitted when not pairable. */
  pairingQr?: TerminalQr;
  /** Shell command that reprints the banner with a fresh pairing code; shown in the pairing block. */
  reprintHint?: string;
}

/** A terminal-rendered QR plus its PNG fallback path, as built by `generateQr`. */
interface TerminalQr {
  readonly qrCode: string;
  readonly pngPath: string;
}

/**
 * Render the LAN pairing QR for the ready banner.
 *
 * The QR encodes `kimi://pair?host&port&code&alias` — the out-of-band
 * payload the mobile app scans (spec §4.2) — with the same plumbing as the
 * Remote Control QR (inline image / half-blocks / PNG fallback). Best-effort
 * and additive: loopback binds, auth bypass, a wildcard bind without a usable
 * LAN address, or a QR/PNG write failure all degrade to `undefined` — the
 * Local/Network URLs above stay the primary way in.
 */
async function generatePairingQr(
  origin: string,
  bindHost: string,
  code: string | undefined,
  deps: Pick<WebCommandDeps, 'networkAddresses' | 'hostname'>,
): Promise<TerminalQr | undefined> {
  if (code === undefined) return undefined;
  const host = pairingLanHost(bindHost, deps.networkAddresses ?? listNetworkAddresses());
  if (host === undefined) return undefined;
  const port = Number(origin.slice(origin.lastIndexOf(':') + 1));
  const uri = buildPairingUri({
    host,
    port,
    code,
    alias: deps.hostname?.() ?? osHostname(),
  });
  try {
    const { terminal: qrCode, pngPath } = await generateQr(
      uri,
      getDataDir(),
      PAIRING_QR_PNG_FILE,
    );
    return { qrCode, pngPath };
  } catch {
    return undefined;
  }
}

export function formatReadyBanner(
  origin: string,
  host: string,
  opts: FormatReadyBannerOptions = {},
): string {
  const primary = (text: string): string => chalk.hex(darkColors.primary)(text);
  const title = (text: string): string => chalk.bold.hex(darkColors.primary)(text);
  const dim = (text: string): string => chalk.hex(darkColors.textDim)(text);
  const muted = (text: string): string => chalk.hex(darkColors.textMuted)(text);
  const label = (text: string): string => chalk.bold.hex(darkColors.textDim)(text);
  const url = (text: string): string => chalk.hex(darkColors.accent)(text);
  // Render the `#token=…` fragment in a de-emphasized gray so the host/port
  // stands out while the full URL stays selectable for copying.
  const urlWithDimToken = (href: string): string => {
    const [base, frag] = splitTokenFragment(href);
    return frag === '' ? url(base) : url(base) + dim(frag);
  };

  const port = Number(origin.slice(origin.lastIndexOf(':') + 1));
  // Borderless header: the Kimi sprite (the little mascot with eyes) sits next
  // to the title, keeping the brand without the enclosing box.
  const logo = ['▐█▛█▛█▌', '▐█████▌'] as const;
  const lines: string[] = [
    '',
    `  ${primary(logo[0])}  ${title('Kimi server ready')}  ${dim(getVersion())}`,
    `  ${primary(logo[1])}  ${dim('Local web UI is available from this machine.')}`,
    '',
  ];

  if (opts.dangerousBypassAuth === true) {
    // Red, impossible-to-miss notice: the bearer-token gate is off, so anyone
    // who can reach this port gets full session / filesystem / shell access.
    lines.push(...formatDangerNoticeLines(), '');
  }

  // Access links.
  for (const { label: text, url: href } of accessUrlLines(
    host,
    port,
    opts.token,
    opts.networkAddresses,
  )) {
    lines.push(`  ${label(text)}${urlWithDimToken(href)}`);
  }
  // On a loopback bind there is no network URL; show how to enable one.
  if (isLoopbackHost(host)) {
    lines.push(`  ${label('Network:  ')}${muted('off')}${dim('  use --host to enable')}`);
  }
  if (opts.token !== undefined) {
    // Set the token off with surrounding whitespace rather than color, so it is
    // easy to spot without being highlighted.
    lines.push('');
    lines.push(`  ${label('Token:    ')}${opts.token}`);
    lines.push('');
  }

  // LAN pairing QR for the mobile app: sits below the copyable URLs/token so
  // those stay the primary entry points, and above the auxiliary controls.
  if (opts.pairingQr !== undefined) {
    lines.push(`  ${label('Pairing:  ')}${muted('scan with the Kimi mobile app')}`);
    lines.push('');
    lines.push(opts.pairingQr.qrCode.trimEnd().replaceAll(/^/gm, '  '));
    lines.push('');
    lines.push(
      `  ${label('QR PNG:   ')}${opts.pairingQr.pngPath} ${muted('(open this if the QR above does not scan)')}`,
    );
    if (opts.reprintHint !== undefined) {
      lines.push(
        `  ${label('Reprint:  ')}${opts.reprintHint} ${muted('(prints a fresh pairing code — the old one is single-use)')}`,
      );
    }
    lines.push('');
  }

  // Auxiliary controls last.
  lines.push(`  ${label('Logs:     ')}${muted('off')}${dim('  use --log-level info to enable')}`);
  // The server always runs in the foreground attached to this terminal.
  lines.push(`  ${label('Stop:     ')}${muted('Ctrl+C')}`);
  lines.push('');
  return lines.join('\n');
}

const DEFAULT_WEB_COMMAND_DEPS: WebCommandDeps = {
  startServerForeground,
  openUrl: defaultOpenUrl,
  resolveToken: () => {
    // Read the persistent `<homeDir>/server.token` written on first boot
    // (M5.1). Best-effort: a missing/older server yields undefined and the
    // caller opens the plain origin.
    return tryResolveServerToken(getDataDir());
  },
  stdout: process.stdout,
  stderr: process.stderr,
};
