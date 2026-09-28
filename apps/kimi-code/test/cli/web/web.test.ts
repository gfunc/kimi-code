/**
 * Tests for the `kimi web` Commander wiring and its subcommands.
 *
 * These tests don't actually start the server — the foreground runner is
 * injected, so they verify option parsing, the ready banner / one-line ready
 * output, browser opening, and the rotate-token / deprecated `kimi server kill`
 * subcommands against fake deps. The reprint tests are the exception: they run
 * the real in-process runner against a mocked kap-server so the process-level
 * plumbing itself is under test — SIGUSR2 on POSIX and the raw-mode R / Ctrl+C
 * key listener on a win32 TTY. The stale pairing-PNG sweep tests hit the real
 * filesystem under a temp `KIMI_CODE_HOME`.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import chalk, { Chalk } from 'chalk';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as QRCode from 'qrcode';

import { resetCapabilitiesCache, setCapabilities } from '@moonshot-ai/pi-tui';

import { registerWebCommand } from '#/cli/sub/web';
import type { LegacyKillDeps } from '#/cli/sub/web/legacy-kill';
import type {
  InteractiveReprintIo,
  StartForegroundHooks,
  WebCommandDeps,
} from '#/cli/sub/web/run';
import type { ParsedServerOptions } from '#/cli/sub/web/shared';
import { darkColors } from '#/tui/theme/colors';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

function stripAnsi(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

function makeProgram(): Command {
  // `commander` exitOverride avoids killing the test runner when --help/error fires.
  const program = new Command('kimi').exitOverride();
  registerWebCommand(program);
  return program;
}

type ForegroundRunner = NonNullable<WebCommandDeps['startServerForeground']>;

/**
 * Fake foreground runner: records the parsed options and fires `onReady` with
 * a fixed origin, then returns (the real runner blocks until SIGINT/SIGTERM).
 */
function makeRunner(origin = 'http://127.0.0.1:58627'): {
  runner: ForegroundRunner;
  calls: { options: ParsedServerOptions | undefined };
} {
  const calls: { options: ParsedServerOptions | undefined } = { options: undefined };
  const runner: ForegroundRunner = async (options, hooks) => {
    calls.options = options;
    await hooks?.onReady?.(origin, () => 'code-pair');
    return undefined as never;
  };
  return { runner, calls };
}

/** Capturing stdout/stderr pair for `WebCommandDeps`. */
function makeIo(): {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
  readStdout(): string;
} {
  let out = '';
  return {
    stdout: {
      write(chunk: string | Uint8Array) {
        out += String(chunk);
        return true;
      },
    },
    stderr: {
      write() {
        return true;
      },
    },
    readStdout: () => out,
  };
}

/** Fake TTY stdin matching exactly the surface `startInteractiveReprint` uses. */
function makeFakeStdin(
  isTTY: boolean,
  options: { throwOnUnraw?: boolean; throwOnResume?: boolean } = {},
): {
  stdin: InteractiveReprintIo['stdin'];
  raw: boolean[];
  listeners: Array<(chunk: string | Buffer) => void>;
  emit(chunk: string | Buffer): void;
} {
  const raw: boolean[] = [];
  const listeners: Array<(chunk: string | Buffer) => void> = [];
  const stdin: InteractiveReprintIo['stdin'] = {
    isTTY,
    setRawMode: (mode: boolean) => {
      raw.push(mode);
      // Simulates an exotic console refusing the mode flip (K3: the restore
      // path must never be able to block or crash shutdown).
      if (options.throwOnUnraw === true && mode === false) {
        throw new Error('setRawMode(false) failed');
      }
      return stdin;
    },
    resume: () => {
      if (options.throwOnResume === true) {
        throw new Error('resume failed');
      }
      return stdin;
    },
    pause: () => stdin,
    on: (event: string, listener: (chunk: string | Buffer) => void) => {
      if (event === 'data') listeners.push(listener);
      return stdin;
    },
    removeListener: (event: string, listener: (chunk: string | Buffer) => void) => {
      const index = listeners.indexOf(listener);
      if (event === 'data' && index >= 0) listeners.splice(index, 1);
      return stdin;
    },
  };
  return {
    stdin,
    raw,
    listeners,
    emit: (chunk) => {
      for (const listener of [...listeners]) listener(chunk);
    },
  };
}

describe('kimi web', () => {
  it('registers the `web` command with only the rotate-token subcommand', () => {
    const program = makeProgram();
    const web = program.commands.find((c) => c.name() === 'web');
    expect(web).toBeDefined();
    const subs = web?.commands.map((c) => c.name()).toSorted();
    // Foreground servers stop with Ctrl+C, so there is no kill/ps.
    expect(subs).toEqual(['rotate-token']);
  });

  it('exposes the foreground server options on `web` itself', () => {
    const program = makeProgram();
    const web = program.commands.find((c) => c.name() === 'web');
    expect(web).toBeDefined();
    const longs = web!.options.map((o) => o.long).filter(Boolean);
    expect(longs).toContain('--port');
    expect(longs).toContain('--host');
    expect(longs).toContain('--allowed-host');
    expect(longs).toContain('--insecure-no-tls');
    expect(longs).toContain('--allow-remote-shutdown');
    expect(longs).toContain('--dangerous-bypass-auth');
    expect(longs).toContain('--log-level');
    expect(longs).toContain('--debug-endpoints');
    expect(longs).toContain('--web-title');
    const remoteControl = web!.options.find((option) => option.long === '--remote-control');
    expect(remoteControl?.short).toBe('--rc');
    // web opens the browser by default → the option is the negative --no-open.
    expect(longs).toContain('--no-open');
    // The background/daemon era flags are gone: the server always runs in the
    // foreground.
    expect(longs).not.toContain('--foreground');
    expect(longs).not.toContain('--keep-alive');
    expect(longs).not.toContain('--daemon');
    expect(longs).not.toContain('--idle-grace-ms');
    expect(longs).not.toContain('--allow-remote-terminals');
  });

  it('routes `kimi server` and any legacy subcommand to a deprecation notice', async () => {
    for (const argv of [
      ['node', 'kimi', 'server'],
      ['node', 'kimi', 'server', 'run', '--port', '1'],
      ['node', 'kimi', 'server', 'status'],
      ['node', 'kimi', 'server', 'ps', '--json'],
    ]) {
      const program = makeProgram();
      let stderr = '';
      const exitCalls: number[] = [];
      const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stderr += String(chunk);
        return true;
      });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        exitCalls.push(code ?? 0);
        return undefined;
      }) as never);

      await program.parseAsync(argv);
      errSpy.mockRestore();
      exitSpy.mockRestore();

      expect(exitCalls).toEqual([1]);
      expect(stderr).toContain('`kimi server` has been deprecated and no longer works.');
      expect(stderr).toContain('kimi web');
      expect(stderr).toContain('kimi server kill');
      expect(stderr).toContain('0.28.0');
      expect(stderr).toContain('next major version');
    }
  });
});

describe('`kimi web` ready banner', () => {
  it('prints the TUI-style ready panel once listening', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    // The runner reports the actual bound origin — the banner must take the
    // port from it, not from the requested --port.
    const { runner } = makeRunner('http://127.0.0.1:58628');
    const { stdout, stderr, readStdout } = makeIo();

    await handleWebCommand(
      { port: '58627', open: false },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok',
        openUrl: vi.fn(),
        stdout,
        stderr,
      },
    );

    const plain = stripAnsi(readStdout());
    expect(plain).toContain('Kimi server ready');
    expect(plain).toContain('Local:');
    expect(plain).toContain('http://127.0.0.1:58628/#token=tok');
    expect(plain).toContain('Token:');
    // Loopback bind shows a Network hint for enabling network access.
    expect(plain).toContain('Network:');
    expect(plain).toContain('use --host to enable');
    expect(plain).toContain('Logs:');
    expect(plain).toContain('off');
    expect(plain).toContain('Stop:');
    expect(plain).toContain('Ctrl+C');
    // No bordered panel (the token URL must print in full for copying), but
    // the Kimi sprite stays next to the title.
    expect(plain).not.toContain('╭');
    expect(plain).not.toContain('╰');
    expect(plain).toContain('▐█▛█▛█▌');
    expect(plain).toContain('▐█████▌');
    expect(plain).not.toContain('Kimi server:');

    // Title is above the URLs; Logs/Stop are at the bottom.
    expect(plain.indexOf('Kimi server ready')).toBeLessThan(plain.indexOf('Local:'));
    expect(plain.indexOf('Logs:')).toBeLessThan(plain.indexOf('Stop:'));
  });

  it('uses the TUI dark palette for the ready banner', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner();
    const { stdout, stderr, readStdout } = makeIo();
    const previousChalkLevel = chalk.level;
    chalk.level = 3;

    try {
      await handleWebCommand(
        { port: '58627', host: '127.0.0.1', open: false },
        { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
      );
    } finally {
      chalk.level = previousChalkLevel;
    }

    const out = readStdout();
    const color = new Chalk({ level: 3 });
    expect(out).toContain(color.hex(darkColors.primary)('▐█▛█▛█▌'));
    expect(out).toContain(color.bold.hex(darkColors.primary)('Kimi server ready'));
    expect(out).toContain(color.hex(darkColors.accent)('http://127.0.0.1:58627/'));
    expect(out).toContain(color.bold.hex(darkColors.textDim)('Local:    '));
    expect(out).toContain(color.hex(darkColors.textMuted)('off'));
  });

  it('renders the bypass danger notice in the error color', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner();
    const { stdout, stderr, readStdout } = makeIo();
    const previousChalkLevel = chalk.level;
    chalk.level = 3;

    try {
      await handleWebCommand(
        { port: '58627', dangerousBypassAuth: true, open: false },
        { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
      );
    } finally {
      chalk.level = previousChalkLevel;
    }

    const color = new Chalk({ level: 3 });
    expect(readStdout()).toContain(
      color.bold.hex(darkColors.error)(
        '⚠ DANGER: authentication is DISABLED (--dangerous-bypass-auth).',
      ),
    );
  });

  it('prints the danger notice and suppresses the token when auth is bypassed', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner();
    const { stdout, stderr, readStdout } = makeIo();
    const openUrl = vi.fn();

    await handleWebCommand(
      { port: '58627', host: '127.0.0.1', dangerousBypassAuth: true, open: true },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok',
        openUrl,
        stdout,
        stderr,
      },
    );

    const plain = stripAnsi(readStdout());
    // Red, impossible-to-miss danger notice.
    expect(plain).toContain('DANGER: authentication is DISABLED');
    expect(plain).toContain('--dangerous-bypass-auth');
    expect(plain).toContain('Ctrl+C');
    // The token is irrelevant when bypassed — neither printed nor carried in
    // any URL (so it cannot leak via copy/paste of the banner).
    expect(plain).not.toContain('tok');
    expect(plain).not.toContain('#token=');
    // The opened browser URL carries no token fragment either.
    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:58627');
  });
});

describe('ready banner reflects the bind class', () => {
  it('lists Local + Network addresses for a 0.0.0.0 bind (Vite-style)', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner('http://0.0.0.0:58627');
    const { stdout, stderr, readStdout } = makeIo();

    await handleWebCommand(
      { host: '0.0.0.0', open: false },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok-xyz',
        networkAddresses: [
          { address: '192.0.2.66', family: 'IPv4' },
          { address: '198.51.100.216', family: 'IPv4' },
        ],
        openUrl: vi.fn(),
        stdout,
        stderr,
      },
    );

    const raw = stripAnsi(readStdout());
    expect(raw).toContain('Kimi server ready');
    expect(raw).toContain('Local:');
    expect(raw).toContain('Network:');
    // Full token-bearing URLs are printed plainly (no box, no truncation) so
    // they are easy to copy.
    expect(raw).toContain('http://localhost:58627/#token=tok-xyz');
    expect(raw).toContain('http://192.0.2.66:58627/#token=tok-xyz');
    expect(raw).toContain('http://198.51.100.216:58627/#token=tok-xyz');
    expect(raw).toContain('Token:');
    expect(raw).toContain('tok-xyz');
    expect(raw).not.toContain('╭');
  });

  it('lists only the Local URL for a 127.0.0.1 bind', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner('http://127.0.0.1:58627');
    const { stdout, stderr, readStdout } = makeIo();

    await handleWebCommand(
      { host: '127.0.0.1', open: false },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok-loop',
        // Injected interface addresses must NOT leak into a loopback banner.
        networkAddresses: [{ address: '192.0.2.66', family: 'IPv4' }],
        openUrl: vi.fn(),
        stdout,
        stderr,
      },
    );

    const raw = stripAnsi(readStdout());
    expect(raw).toContain('Kimi server ready');
    expect(raw).toContain('Local:');
    expect(raw).toContain('http://127.0.0.1:58627/#token=tok-loop');
    expect(raw).toContain('Token:');
    expect(raw).toContain('tok-loop');
    // No network URLs on a loopback bind — just the "off" hint.
    expect(raw).toContain('use --host to enable');
    expect(raw).not.toContain('Network:  http');
    expect(raw).not.toContain('192.0.2.66');
    expect(raw).not.toContain('╭');
  });
});

describe('buildPairingUri', () => {
  it('encodes the bound host, actual port, exchange code, and hostname alias', async () => {
    const { buildPairingUri } = await import('#/cli/sub/web/pairing');
    expect(
      buildPairingUri({ host: '192.168.1.5', port: 58627, code: 'code-abc', alias: 'devbox' }),
    ).toBe('kimi://pair?host=192.168.1.5&port=58627&code=code-abc&alias=devbox');
  });

  it('percent-encodes special characters in the query values', async () => {
    const { buildPairingUri } = await import('#/cli/sub/web/pairing');
    expect(
      buildPairingUri({ host: '192.168.1.5', port: 58627, code: 'a b&c', alias: 'my box' }),
    ).toBe('kimi://pair?host=192.168.1.5&port=58627&code=a%20b%26c&alias=my%20box');
  });

  it('rejects a missing host or code', async () => {
    const { buildPairingUri } = await import('#/cli/sub/web/pairing');
    expect(() =>
      buildPairingUri({ host: '', port: 58627, code: 'code', alias: 'devbox' }),
    ).toThrow(/host/);
    expect(() =>
      buildPairingUri({ host: '192.168.1.5', port: 58627, code: '', alias: 'devbox' }),
    ).toThrow(/code/);
  });
});

describe('pairingLanHost', () => {
  it('uses the primary LAN interface address for a wildcard bind', async () => {
    const { pairingLanHost } = await import('#/cli/sub/web/pairing');
    expect(
      pairingLanHost('0.0.0.0', [
        { address: '192.168.1.5', family: 'IPv4' },
        { address: '198.51.100.7', family: 'IPv4' },
        { address: '2001:db8::1', family: 'IPv6' },
      ]),
    ).toBe('192.168.1.5');
    expect(pairingLanHost('::', [{ address: '2001:db8::1', family: 'IPv6' }])).toBe(
      '2001:db8::1',
    );
  });

  it('uses the bound host itself for a specific non-loopback bind', async () => {
    const { pairingLanHost } = await import('#/cli/sub/web/pairing');
    expect(pairingLanHost('10.0.0.5', [{ address: '192.168.1.5', family: 'IPv4' }])).toBe(
      '10.0.0.5',
    );
  });

  it('returns undefined for loopback binds or wildcard binds without LAN addresses', async () => {
    const { pairingLanHost } = await import('#/cli/sub/web/pairing');
    expect(
      pairingLanHost('127.0.0.1', [{ address: '192.168.1.5', family: 'IPv4' }]),
    ).toBeUndefined();
    expect(pairingLanHost('0.0.0.0', [])).toBeUndefined();
  });
});

describe('LAN pairing QR in the ready banner', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kimi-pair-qr-'));
    vi.stubEnv('KIMI_CODE_HOME', home);
    // Force the half-block QR fallback so the banner output is deterministic.
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetCapabilitiesCache();
    rmSync(home, { recursive: true, force: true });
  });

  it('prints a scannable kimi://pair QR with the LAN IP, the actual port, the exchange code, and the alias', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { renderTerminalQr } = await import('#/utils/remote-control-qr');
    // The runner reports the actual bound origin: the port auto-incremented
    // past the busy 58627 default. The QR must carry 58628, never 58627.
    const { runner } = makeRunner('http://0.0.0.0:58628');
    const { stdout, stderr, readStdout } = makeIo();

    await handleWebCommand(
      { host: '0.0.0.0', open: false },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok-pair',
        networkAddresses: [
          { address: '192.168.1.5', family: 'IPv4' },
          { address: '198.51.100.7', family: 'IPv4' },
        ],
        hostname: () => 'devbox',
        openUrl: vi.fn(),
        stdout,
        stderr,
      },
    );

    const uri = 'kimi://pair?host=192.168.1.5&port=58628&code=code-pair&alias=devbox';
    const raw = readStdout();
    // The terminal QR is exactly the half-block rendering of that payload
    // (compare with the two-space banner indent removed).
    const dedented = raw.split('\n').map((line) => line.replace(/^ {2}/, '')).join('\n');
    expect(dedented).toContain(renderTerminalQr(uri));
    // The PNG fallback encodes the same payload byte-for-byte.
    const pngPath = join(home, 'pairing-qrcode.png');
    expect(readFileSync(pngPath)).toEqual(await QRCode.toBuffer(uri));
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(pngPath).mode & 0o777).toBe(0o600);

    const plain = stripAnsi(raw);
    expect(plain).toContain('Pairing:');
    expect(plain).toContain(join(home, 'pairing-qrcode.png'));
    // The QR sits after the token and before the auxiliary controls.
    expect(plain.indexOf('Token:')).toBeLessThan(plain.indexOf('Pairing:'));
    expect(plain.indexOf('Pairing:')).toBeLessThan(plain.indexOf('Logs:'));
    // The existing Local/Network lines are unchanged alongside the QR.
    expect(plain).toContain('http://localhost:58628/#token=tok-pair');
    expect(plain).toContain('http://192.168.1.5:58628/#token=tok-pair');
    expect(plain).toContain('http://198.51.100.7:58628/#token=tok-pair');
  });

  it('prints no pairing QR on a loopback bind', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner('http://127.0.0.1:58627');
    const { stdout, stderr, readStdout } = makeIo();

    await handleWebCommand(
      { host: '127.0.0.1', open: false },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok-loop',
        networkAddresses: [{ address: '192.168.1.5', family: 'IPv4' }],
        hostname: () => 'devbox',
        openUrl: vi.fn(),
        stdout,
        stderr,
      },
    );

    const plain = stripAnsi(readStdout());
    expect(plain).toContain('Kimi server ready');
    expect(plain).not.toContain('Pairing:');
    expect(existsSync(join(home, 'pairing-qrcode.png'))).toBe(false);
  });

  it('keeps pairing available when the persistent token is not resolvable', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner('http://0.0.0.0:58627');
    const { stdout, stderr, readStdout } = makeIo();

    await handleWebCommand(
      { host: '0.0.0.0', open: false },
      {
        startServerForeground: runner,
        resolveToken: () => undefined,
        networkAddresses: [{ address: '192.168.1.5', family: 'IPv4' }],
        hostname: () => 'devbox',
        openUrl: vi.fn(),
        stdout,
        stderr,
      },
    );

    const plain = stripAnsi(readStdout());
    expect(plain).toContain('Pairing:');
    // The code never prints as text; it rides in the QR payload.
    expect(readFileSync(join(home, 'pairing-qrcode.png'))).toEqual(
      await QRCode.toBuffer('kimi://pair?host=192.168.1.5&port=58627&code=code-pair&alias=devbox'),
    );
    expect(plain).toContain('Reprint:');
    // POSIX keeps the SIGUSR2 hint (works with or without a terminal).
    expect(plain).toMatch(/kill -USR2 \d+/);
  });

  it('prints no pairing QR when auth is bypassed', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner('http://0.0.0.0:58627');
    const { stdout, stderr, readStdout } = makeIo();

    await handleWebCommand(
      { host: '0.0.0.0', open: false, dangerousBypassAuth: true },
      {
        startServerForeground: runner,
        resolveToken: () => undefined,
        networkAddresses: [{ address: '192.168.1.5', family: 'IPv4' }],
        hostname: () => 'devbox',
        openUrl: vi.fn(),
        stdout,
        stderr,
      },
    );

    const plain = stripAnsi(readStdout());
    expect(plain).toContain('Kimi server ready');
    expect(plain).not.toContain('Pairing:');
    expect(existsSync(join(home, 'pairing-qrcode.png'))).toBe(false);
  });

  it('prints no pairing QR on a wildcard bind without any LAN address', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner('http://0.0.0.0:58627');
    const { stdout, stderr, readStdout } = makeIo();

    await handleWebCommand(
      { host: '0.0.0.0', open: false },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok-pair',
        networkAddresses: [],
        hostname: () => 'devbox',
        openUrl: vi.fn(),
        stdout,
        stderr,
      },
    );

    const plain = stripAnsi(readStdout());
    expect(plain).toContain('Kimi server ready');
    expect(plain).not.toContain('Pairing:');
    expect(existsSync(join(home, 'pairing-qrcode.png'))).toBe(false);
  });
});

describe('server reprint plumbing (SIGUSR2 on POSIX, keys on win32 TTY)', () => {
  const REAL_SERVER_OPTIONS: ParsedServerOptions = {
    host: '127.0.0.1',
    port: 58627,
    logLevel: 'silent',
    debugEndpoints: false,
    insecureNoTls: true,
    allowRemoteShutdown: false,
    dangerousBypassAuth: false,
    allowedHosts: [],
  };
  const LIFECYCLE_SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGUSR2']);

  /**
   * Fake kap-server (no port bind, no engine) and telemetry (no sink) for the
   * real in-process runner, scoped to these tests via `vi.doMock`. Scoped —
   * not file-level — because the rotate-token tests depend on `resetModules`
   * re-evaluating the real kap-server with their stubbed `KIMI_CODE_HOME`
   * (`getLiveServerInstance()` reads its instances dir at module load).
   */
  function mockServerSeams(): void {
    vi.doMock('@moonshot-ai/kap-server', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@moonshot-ai/kap-server')>();
      const fakeLogger = { info: vi.fn(), error: vi.fn() };
      return {
        ...actual,
        createServerLogger: () => fakeLogger,
        startServer: vi.fn(async () => ({
          host: '127.0.0.1',
          port: 58627,
          createPairingCode: () => 'code-pair',
          close: async () => {},
        })),
      };
    });
    vi.doMock('@moonshot-ai/kimi-telemetry', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@moonshot-ai/kimi-telemetry')>();
      return {
        ...actual,
        initializeTelemetry: vi.fn(),
        track: vi.fn(),
        shutdownTelemetry: vi.fn(async () => {}),
      };
    });
    // run.ts is already cached from the file's static imports; drop the cache
    // so the next dynamic import binds the mocked seams.
    vi.resetModules();
  }

  function unmockServerSeams(): void {
    vi.doUnmock('@moonshot-ai/kap-server');
    vi.doUnmock('@moonshot-ai/kimi-telemetry');
    vi.resetModules();
  }

  function spySignals() {
    const onSpy = vi.spyOn(process, 'on');
    const onceSpy = vi.spyOn(process, 'once');
    return {
      onSpy,
      onceSpy,
      // Remove exactly what these tests registered; leave vitest infra alone.
      // 'exit' covers the terminal-restore exit hook the runner registers.
      cleanup: () => {
        for (const [signal, listener] of [...onSpy.mock.calls, ...onceSpy.mock.calls]) {
          if (LIFECYCLE_SIGNALS.has(String(signal)) || signal === 'exit') {
            process.off(signal as NodeJS.Signals, listener as never);
          }
        }
        onSpy.mockRestore();
        onceSpy.mockRestore();
      },
    };
  }

  /**
   * Drive the real in-process foreground runner (against the mocked
   * kap-server) until `onReady` fires. The runner never settles after that,
   * so each test must call `cleanup()` to unregister the lifecycle listeners.
   * `io` injects fake streams for the win32 interactive key listener.
   */
  async function runForegroundUntilReady(
    hooks: StartForegroundHooks = {},
    io?: InteractiveReprintIo,
  ): Promise<void> {
    mockServerSeams();
    const { startServerForeground } = await import('#/cli/sub/web/run');
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const blocking = startServerForeground(
      REAL_SERVER_OPTIONS,
      {
        ...hooks,
        onReady: async (origin, createPairingCode) => {
          await hooks.onReady?.(origin, createPairingCode);
          resolveReady();
        },
      },
      io,
    );
    void blocking.catch(() => {});
    await ready;
  }

  function stubTmpHome(prefix: string): string {
    const home = mkdtempSync(join(tmpdir(), prefix));
    vi.stubEnv('KIMI_CODE_HOME', home);
    return home;
  }

  it('prints the press-R reprint hint in the win32 banner on an interactive TTY', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const home = stubTmpHome('kimi-web-win-elig-');
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      const seen: { hooks?: StartForegroundHooks; io?: InteractiveReprintIo } = {};
      const runner: ForegroundRunner = async (_options, hooks, io) => {
        seen.hooks = hooks;
        seen.io = io;
        await hooks?.onReady?.('http://0.0.0.0:58627', () => 'code-pair');
        return undefined as never;
      };
      const io = makeIo();
      const interactiveIo: InteractiveReprintIo = {
        stdin: makeFakeStdin(true).stdin,
        stdout: { isTTY: true },
      };

      await handleWebCommand(
        { host: '0.0.0.0', open: false },
        {
          startServerForeground: runner,
          resolveToken: () => 'tok-win',
          interactiveIo,
          networkAddresses: [{ address: '192.168.1.5', family: 'IPv4' }],
          hostname: () => 'devbox',
          openUrl: vi.fn(),
          stdout: io.stdout,
          stderr: io.stderr,
        },
      );

      // The hook reaches the runner on win32 too now; the runner picks the
      // trigger per platform (SIGUSR2 on POSIX, the key listener on a TTY).
      expect(seen.hooks?.onReprint).toBeDefined();
      expect(seen.hooks?.onReady).toBeDefined();
      const plain = stripAnsi(io.readStdout());
      expect(plain).toContain('Pairing:');
      expect(plain).toContain('Reprint:');
      expect(plain).toContain('press R');
      expect(plain).not.toContain('kill -USR2');
      // K3 consistency: the banner judged the exact same streams the runner
      // was handed — the hint can never promise a key the listener won't hear.
      expect(seen.io).toBe(interactiveIo);
    } finally {
      platformSpy.mockRestore();
      vi.unstubAllEnvs();
      resetCapabilitiesCache();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('falls back to a restart hint in the win32 banner without a terminal', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const home = stubTmpHome('kimi-web-win-headless-banner-');
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      const seen: { hooks?: StartForegroundHooks; io?: InteractiveReprintIo } = {};
      const runner: ForegroundRunner = async (_options, hooks, io) => {
        seen.hooks = hooks;
        seen.io = io;
        await hooks?.onReady?.('http://0.0.0.0:58627', () => 'code-pair');
        return undefined as never;
      };
      const io = makeIo();
      const interactiveIo: InteractiveReprintIo = {
        stdin: makeFakeStdin(false).stdin,
        stdout: { isTTY: true },
      };

      await handleWebCommand(
        { host: '0.0.0.0', open: false },
        {
          startServerForeground: runner,
          resolveToken: () => 'tok-win',
          interactiveIo,
          networkAddresses: [{ address: '192.168.1.5', family: 'IPv4' }],
          hostname: () => 'devbox',
          openUrl: vi.fn(),
          stdout: io.stdout,
          stderr: io.stderr,
        },
      );

      // The hook is still supplied (the runner ignores it without a TTY); the
      // banner points at a restart instead of a key or signal.
      expect(seen.hooks?.onReprint).toBeDefined();
      const plain = stripAnsi(io.readStdout());
      expect(plain).toContain('Pairing:');
      expect(plain).toContain('Reprint:');
      expect(plain).toContain('restart kimi web');
      expect(plain).not.toContain('press R');
      expect(plain).not.toContain('kill -USR2');
      // Same streams reached the runner, so both sides agree there is no key.
      expect(seen.io).toBe(interactiveIo);
    } finally {
      platformSpy.mockRestore();
      vi.unstubAllEnvs();
      resetCapabilitiesCache();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('registers no SIGUSR2 listener on win32 (even when a hook is supplied) while startup continues', async () => {
    const home = stubTmpHome('kimi-web-win-runner-');
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const { onSpy, onceSpy, cleanup } = spySignals();
    try {
      await runForegroundUntilReady({ onReprint: () => {} });

      // Startup continued far enough to fire onReady, with the normal
      // lifecycle handlers in place and no SIGUSR2 anywhere.
      expect(onceSpy.mock.calls.map(([signal]) => signal)).toEqual(
        expect.arrayContaining(['SIGINT', 'SIGTERM']),
      );
      expect(onSpy.mock.calls.map(([signal]) => signal)).not.toContain('SIGUSR2');
    } finally {
      unmockServerSeams();
      cleanup();
      platformSpy.mockRestore();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('registers the SIGUSR2 reprint listener on POSIX and fires the hook (control)', async () => {
    if (process.platform === 'win32') return;
    const home = stubTmpHome('kimi-web-posix-runner-');
    const { onSpy, cleanup } = spySignals();
    try {
      const reprint = vi.fn();
      await runForegroundUntilReady({ onReprint: reprint });

      const registration = onSpy.mock.calls.find(([signal]) => signal === 'SIGUSR2');
      expect(registration).toBeDefined();
      (registration![1] as () => void)();
      await new Promise((resolve) => setImmediate(resolve));
      expect(reprint).toHaveBeenCalledTimes(1);
    } finally {
      unmockServerSeams();
      cleanup();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('starts the key listener on a win32 TTY: R reprints, Ctrl+C shuts down, terminal restored', async () => {
    const home = stubTmpHome('kimi-web-win-keys-');
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const { onSpy, onceSpy, cleanup } = spySignals();
    const fake = makeFakeStdin(true);
    try {
      const reprint = vi.fn();
      await runForegroundUntilReady(
        { onReprint: reprint },
        { stdin: fake.stdin, stdout: { isTTY: true } },
      );

      expect(fake.raw).toEqual([true]);
      expect(fake.listeners.length).toBe(1);

      fake.emit('r');
      await new Promise((resolve) => setImmediate(resolve));
      expect(reprint).toHaveBeenCalledTimes(1);

      // Ctrl+C must not be swallowed: it drives the graceful shutdown to the
      // same process.exit(0) a real SIGINT reaches, and raw mode is undone.
      fake.emit(Buffer.from([0x03]));
      for (let i = 0; i < 10 && exitSpy.mock.calls.length === 0; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(fake.raw).toEqual([true, false]);

      // K3: the first Ctrl+C also detaches the once-armed lifecycle listeners,
      // so the NEXT Ctrl+C (a real signal, cooked mode restored) hits Node's
      // default hard termination instead of a no-op guard and needing a third.
      // SIGINT and SIGTERM are symmetric.
      const sigintHandler = onceSpy.mock.calls.find(([signal]) => signal === 'SIGINT')?.[1];
      expect(sigintHandler).toBeDefined();
      expect(process.listeners('SIGINT')).not.toContain(sigintHandler);
      const sigtermHandler = onceSpy.mock.calls.find(([signal]) => signal === 'SIGTERM')?.[1];
      expect(sigtermHandler).toBeDefined();
      expect(process.listeners('SIGTERM')).not.toContain(sigtermHandler);

      // The listener is gone after the stop: further keys do nothing.
      fake.emit('r');
      fake.emit(Buffer.from([0x03]));
      expect(reprint).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledTimes(1);
    } finally {
      unmockServerSeams();
      cleanup();
      platformSpy.mockRestore();
      exitSpy.mockRestore();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps shutdown reaching process.exit when restoring raw mode throws (K3 hang)', async () => {
    const home = stubTmpHome('kimi-web-win-unraw-throw-');
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const { onSpy, onceSpy, cleanup } = spySignals();
    const fake = makeFakeStdin(true, { throwOnUnraw: true });
    try {
      await runForegroundUntilReady(
        { onReprint: () => {} },
        { stdin: fake.stdin, stdout: { isTTY: true } },
      );

      fake.emit(Buffer.from([0x03]));
      for (let i = 0; i < 10 && exitSpy.mock.calls.length === 0; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      // The setRawMode(false) failure is absorbed; shutdown still completes
      // (stopping must never become a trap with no way out). raw records the
      // attempted restore — the throw just never escapes.
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(fake.raw).toEqual([true, false]);
    } finally {
      unmockServerSeams();
      cleanup();
      platformSpy.mockRestore();
      exitSpy.mockRestore();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('restores the terminal through the process exit hook on abnormal exit', async () => {
    const home = stubTmpHome('kimi-web-win-exit-hook-');
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const { onSpy, onceSpy, cleanup } = spySignals();
    const fake = makeFakeStdin(true);
    try {
      await runForegroundUntilReady(
        { onReprint: () => {} },
        { stdin: fake.stdin, stdout: { isTTY: true } },
      );
      expect(fake.raw).toEqual([true]);

      // Simulate an abnormal exit path that never runs shutdown(): fire the
      // registered 'exit' hook directly.
      const exitHook = onSpy.mock.calls.find(([event]) => event === 'exit')?.[1];
      expect(exitHook).toBeDefined();
      (exitHook as () => void)();
      expect(fake.raw).toEqual([true, false]);
      expect(fake.listeners).toEqual([]);

      // The hook is one-shot: firing it again (post-stop) is inert.
      (exitHook as () => void)();
      expect(fake.raw).toEqual([true, false]);
    } finally {
      unmockServerSeams();
      cleanup();
      platformSpy.mockRestore();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('starts no key listener on win32 when stdin is not a TTY (headless restart-hint case)', async () => {
    const home = stubTmpHome('kimi-web-win-headless-runner-');
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const { onSpy, onceSpy, cleanup } = spySignals();
    const fake = makeFakeStdin(false);
    try {
      await runForegroundUntilReady(
        { onReprint: () => {} },
        { stdin: fake.stdin, stdout: { isTTY: true } },
      );

      expect(fake.raw).toEqual([]);
      expect(fake.listeners).toEqual([]);
    } finally {
      unmockServerSeams();
      cleanup();
      platformSpy.mockRestore();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('starts no key listener on POSIX even with a TTY (SIGUSR2 stays the only trigger)', async () => {
    if (process.platform === 'win32') return;
    const home = stubTmpHome('kimi-web-posix-keys-');
    const { onSpy, onceSpy, cleanup } = spySignals();
    const fake = makeFakeStdin(true);
    try {
      await runForegroundUntilReady(
        { onReprint: () => {} },
        { stdin: fake.stdin, stdout: { isTTY: true } },
      );

      expect(fake.raw).toEqual([]);
      expect(fake.listeners).toEqual([]);
    } finally {
      unmockServerSeams();
      cleanup();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('interactive reprint keys', () => {
  it('requires win32 with a TTY on both stdin and stdout', async () => {
    const { canInteractiveReprint } = await import('#/cli/sub/web/run');
    const tty = { isTTY: true };
    const pipe = { isTTY: false };
    expect(canInteractiveReprint('win32', tty, { isTTY: true })).toBe(true);
    // Negative controls: each gate alone must disable the key listener.
    expect(canInteractiveReprint('linux', tty, { isTTY: true })).toBe(false);
    expect(canInteractiveReprint('darwin', tty, { isTTY: true })).toBe(false);
    expect(canInteractiveReprint('win32', pipe, { isTTY: true })).toBe(false);
    expect(canInteractiveReprint('win32', tty, pipe)).toBe(false);
    expect(canInteractiveReprint('win32', undefined, undefined)).toBe(false);
  });

  it('reprints only on an exact lone R, quits on Ctrl+C (never swallowing it), and restores raw mode on stop', async () => {
    const { startInteractiveReprint } = await import('#/cli/sub/web/run');
    const fake = makeFakeStdin(true);
    const reprint = vi.fn();
    const quit = vi.fn();
    const stop = startInteractiveReprint(
      { stdin: fake.stdin, stdout: { isTTY: true } },
      reprint,
      quit,
    );

    expect(fake.raw).toEqual([true]);
    fake.emit('x'); // unrelated key: ignored
    fake.emit(Buffer.from('rr')); // K3: a burst (paste) containing r must not reprint
    fake.emit(Buffer.from('bar'));
    expect(reprint).not.toHaveBeenCalled();
    fake.emit('r');
    fake.emit(Buffer.from('R'));
    expect(reprint).toHaveBeenCalledTimes(2);
    expect(quit).not.toHaveBeenCalled();

    fake.emit(Buffer.from('a\u0003b')); // Ctrl+C inside a burst still quits
    expect(quit).toHaveBeenCalledTimes(1);
    expect(reprint).toHaveBeenCalledTimes(2);

    stop();
    stop(); // idempotent
    expect(fake.raw).toEqual([true, false]);
    fake.emit('r');
    fake.emit(Buffer.from([0x03]));
    expect(reprint).toHaveBeenCalledTimes(2);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('never throws from stop even when the console refuses unraw', async () => {
    const { startInteractiveReprint } = await import('#/cli/sub/web/run');
    const fake = makeFakeStdin(true, { throwOnUnraw: true });
    const stop = startInteractiveReprint(
      { stdin: fake.stdin, stdout: { isTTY: true } },
      () => {},
      () => {},
    );
    expect(() => stop()).not.toThrow();
    expect(fake.listeners).toEqual([]);
  });

  it('rolls the terminal fully back when resume fails after raw mode is on', async () => {
    const { startInteractiveReprint } = await import('#/cli/sub/web/run');
    const fake = makeFakeStdin(true, { throwOnResume: true });
    expect(() =>
      startInteractiveReprint(
        { stdin: fake.stdin, stdout: { isTTY: true } },
        () => {},
        () => {},
      ),
    ).toThrow('resume failed');
    // K3: raw mode is undone and the listener is gone — the failed start must
    // not leave a raw terminal swallowing Ctrl+C with no quit handler.
    expect(fake.raw).toEqual([true, false]);
    expect(fake.listeners).toEqual([]);
  });
});

describe('stale pairing PNG sweep', () => {
  let home: string;

  const pngPath = (): string => join(home, 'pairing-qrcode.png');

  function seedPng(ageMs?: number): void {
    writeFileSync(pngPath(), 'png');
    if (ageMs !== undefined) {
      const stamp = new Date(Date.now() - ageMs);
      utimesSync(pngPath(), stamp, stamp);
    }
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kimi-pair-sweep-'));
    vi.stubEnv('KIMI_CODE_HOME', home);
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetCapabilitiesCache();
    rmSync(home, { recursive: true, force: true });
  });

  it('sweeps a stale pairing PNG at startup and keeps a fresh one (loopback run)', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner('http://127.0.0.1:58627');
    const { stdout, stderr } = makeIo();

    seedPng(10 * 60_000);
    await handleWebCommand(
      { host: '127.0.0.1', open: false },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );
    expect(existsSync(pngPath())).toBe(false);

    // Negative control: a fresh PNG (inside the pairing-code window) survives,
    // so a concurrently pairing instance's QR is never swept.
    seedPng();
    await handleWebCommand(
      { host: '127.0.0.1', open: false },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );
    expect(existsSync(pngPath())).toBe(true);
    expect(readFileSync(pngPath(), 'utf8')).toBe('png');
  });

  it('a short pairing session removes its own PNG on graceful shutdown (no fresh residue)', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { stdout, stderr } = makeIo();
    const runner: ForegroundRunner = async (_options, hooks) => {
      await hooks?.onReady?.('http://0.0.0.0:58627', () => 'code-pair');
      // K3: a Ctrl+C right after pairing must not leave the still-fresh PNG
      // behind until some age threshold — the writer takes it back.
      await hooks?.onShutdown?.('SIGINT');
      return undefined as never;
    };

    await handleWebCommand(
      { host: '0.0.0.0', open: false },
      {
        startServerForeground: runner,
        networkAddresses: [{ address: '192.168.1.5', family: 'IPv4' }],
        hostname: () => 'devbox',
        openUrl: vi.fn(),
        stdout,
        stderr,
      },
    );
    expect(existsSync(pngPath())).toBe(false);
  });

  it('shutdown keeps a foreign pairing PNG this run did not write (loopback run)', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { stdout, stderr } = makeIo();
    const runner: ForegroundRunner = async (_options, hooks) => {
      await hooks?.onReady?.('http://127.0.0.1:58627', () => 'code-pair');
      await hooks?.onShutdown?.('SIGINT');
      return undefined as never;
    };

    // Negative control: a PNG this run never wrote (fresh, so the startup age
    // sweep must also keep it) survives a loopback run's whole lifecycle.
    seedPng();
    await handleWebCommand(
      { host: '127.0.0.1', open: false },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );
    expect(existsSync(pngPath())).toBe(true);
    expect(readFileSync(pngPath(), 'utf8')).toBe('png');
  });

  it('shutdown keeps the PNG when another instance overwrote it after our banner', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { stdout, stderr } = makeIo();
    const runner: ForegroundRunner = async (_options, hooks) => {
      await hooks?.onReady?.('http://0.0.0.0:58627', () => 'code-pair');
      // A concurrently pairing instance rewrites the fixed path between our
      // banner and our shutdown: the file is theirs now, not ours to remove.
      writeFileSync(pngPath(), 'another-instance');
      await hooks?.onShutdown?.('SIGINT');
      return undefined as never;
    };

    await handleWebCommand(
      { host: '0.0.0.0', open: false },
      {
        startServerForeground: runner,
        networkAddresses: [{ address: '192.168.1.5', family: 'IPv4' }],
        hostname: () => 'devbox',
        openUrl: vi.fn(),
        stdout,
        stderr,
      },
    );
    expect(existsSync(pngPath())).toBe(true);
    expect(readFileSync(pngPath(), 'utf8')).toBe('another-instance');
  });
});

describe('removeStalePairingQrPng', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-pair-sweep-unit-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function ageFile(path: string, ageMs: number): void {
    const stamp = new Date(Date.now() - ageMs);
    utimesSync(path, stamp, stamp);
  }

  it('removes only the fixed pairing PNG, never the shared remote-control QR or siblings', async () => {
    const { removeStalePairingQrPng } = await import('#/cli/sub/web/pairing');
    const png = join(dir, 'pairing-qrcode.png');
    writeFileSync(png, 'dead');
    ageFile(png, 10 * 60_000);
    const rc = join(dir, 'rc-qrcode.png');
    writeFileSync(rc, 'shared-rc');
    ageFile(rc, 10 * 60_000);
    writeFileSync(join(dir, 'unrelated.txt'), 'keep');

    await expect(removeStalePairingQrPng({ dataDir: dir })).resolves.toBe(true);

    expect(existsSync(png)).toBe(false);
    expect(existsSync(rc)).toBe(true);
    expect(readFileSync(rc, 'utf8')).toBe('shared-rc');
    expect(existsSync(join(dir, 'unrelated.txt'))).toBe(true);
  });

  it('keeps the PNG up to the threshold and removes it only past it', async () => {
    const { removeStalePairingQrPng } = await import('#/cli/sub/web/pairing');
    const png = join(dir, 'pairing-qrcode.png');
    writeFileSync(png, 'png');
    ageFile(png, 90_000);
    await expect(removeStalePairingQrPng({ dataDir: dir })).resolves.toBe(false);
    expect(existsSync(png)).toBe(true);
    // Injected clock exactly at the threshold: still kept (age <= maxAge).
    const mtimeMs = statSync(png).mtimeMs;
    await expect(
      removeStalePairingQrPng({ dataDir: dir, now: mtimeMs + 120_000 }),
    ).resolves.toBe(false);
    // One tick past it: removed.
    await expect(
      removeStalePairingQrPng({ dataDir: dir, now: mtimeMs + 120_000 + 1 }),
    ).resolves.toBe(true);
    expect(existsSync(png)).toBe(false);
  });

  it('treats a missing file or a directory at the path as nothing to sweep', async () => {
    const { removeStalePairingQrPng } = await import('#/cli/sub/web/pairing');
    await expect(removeStalePairingQrPng({ dataDir: dir })).resolves.toBe(false);
    mkdirSync(join(dir, 'pairing-qrcode.png'));
    await expect(removeStalePairingQrPng({ dataDir: dir })).resolves.toBe(false);
    expect(statSync(join(dir, 'pairing-qrcode.png')).isDirectory()).toBe(true);
  });
});

describe('pairing PNG ownership cleanup', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-pair-owned-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const pngPath = (): string => join(dir, 'pairing-qrcode.png');

  it('snapshots the identity of the current PNG, undefined when missing or a directory', async () => {
    const { statPairingPng } = await import('#/cli/sub/web/pairing');
    await expect(statPairingPng(dir)).resolves.toBeUndefined();
    writeFileSync(pngPath(), 'png-bytes');
    const identity = await statPairingPng(dir);
    expect(identity).toEqual({
      mtimeMs: statSync(pngPath()).mtimeMs,
      size: statSync(pngPath()).size,
    });
    rmSync(pngPath());
    mkdirSync(pngPath());
    await expect(statPairingPng(dir)).resolves.toBeUndefined();
  });

  it('removes the file only while it still carries the owned identity', async () => {
    const { removeOwnedPairingQrPng, statPairingPng } = await import('#/cli/sub/web/pairing');
    writeFileSync(pngPath(), 'png-bytes');
    const identity = await statPairingPng(dir);
    await expect(removeOwnedPairingQrPng({ dataDir: dir, owned: identity })).resolves.toBe(
      true,
    );
    expect(existsSync(pngPath())).toBe(false);
  });

  it('keeps the file when its size or mtime no longer matches (overwritten elsewhere)', async () => {
    const { removeOwnedPairingQrPng, statPairingPng } = await import('#/cli/sub/web/pairing');
    writeFileSync(pngPath(), 'png-bytes');
    const identity = await statPairingPng(dir);

    // Different writer, same size: mtime alone must still disown it.
    writeFileSync(pngPath(), 'xxx-bytes');
    await expect(removeOwnedPairingQrPng({ dataDir: dir, owned: identity })).resolves.toBe(
      false,
    );
    expect(readFileSync(pngPath(), 'utf8')).toBe('xxx-bytes');

    // Same bytes, later mtime (another instance rewrote the same payload).
    writeFileSync(pngPath(), 'png-bytes');
    const later = new Date(Date.now() + 5_000);
    utimesSync(pngPath(), later, later);
    await expect(removeOwnedPairingQrPng({ dataDir: dir, owned: identity })).resolves.toBe(
      false,
    );
    expect(existsSync(pngPath())).toBe(true);
  });

  it('is a no-op without an owned identity, with a missing file, or on stat errors', async () => {
    const { removeOwnedPairingQrPng, statPairingPng } = await import('#/cli/sub/web/pairing');
    await expect(removeOwnedPairingQrPng({ dataDir: dir })).resolves.toBe(false);
    const identity = await statPairingPng(dir);
    await expect(removeOwnedPairingQrPng({ dataDir: dir, owned: identity })).resolves.toBe(
      false,
    );
    expect(existsSync(pngPath())).toBe(false);
  });
});

describe('`kimi web` opens the browser', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetCapabilitiesCache();
  });

  it('opens the Web UI URL with the #token= fragment by default', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner();
    const { stdout, stderr } = makeIo();
    const openUrl = vi.fn();

    await handleWebCommand(
      { port: '58627', open: true },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok-xyz',
        openUrl,
        stdout,
        stderr,
      },
    );

    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:58627/#token=tok-xyz');
  });

  it('opens the plain origin when no token is resolvable', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner();
    const { stdout, stderr } = makeIo();
    const openUrl = vi.fn();

    await handleWebCommand(
      { port: '58627', open: true },
      {
        startServerForeground: runner,
        resolveToken: () => undefined,
        openUrl,
        stdout,
        stderr,
      },
    );

    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:58627');
  });

  it('opens localhost rather than the wildcard bind address', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner('http://0.0.0.0:58627');
    const { stdout, stderr } = makeIo();
    const openUrl = vi.fn();

    await handleWebCommand(
      { host: '0.0.0.0', open: true },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok-xyz',
        openUrl,
        stdout,
        stderr,
      },
    );

    expect(openUrl).toHaveBeenCalledWith('http://localhost:58627/#token=tok-xyz');
  });

  it('opens localhost for a wildcard IPv6 bind', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner('http://:::58627');
    const { stdout, stderr } = makeIo();
    const openUrl = vi.fn();

    await handleWebCommand(
      { host: '::', open: true },
      {
        startServerForeground: runner,
        resolveToken: () => undefined,
        openUrl,
        stdout,
        stderr,
      },
    );

    expect(openUrl).toHaveBeenCalledWith('http://localhost:58627');
  });

  it('does not open the browser when open is false', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner('http://127.0.0.1:9000');
    const { stdout, stderr } = makeIo();
    const openUrl = vi.fn();

    await handleWebCommand(
      { port: '58627', open: false },
      { startServerForeground: runner, openUrl, stdout, stderr },
    );

    expect(openUrl).not.toHaveBeenCalled();
  });

  it('maps --remote-control and --rc to the same option', () => {
    for (const flag of ['--remote-control', '--rc']) {
      const program = makeProgram();
      const web = program.commands.find((command) => command.name() === 'web')!;
      web.parseOptions([flag]);
      expect(web.opts()).toMatchObject({ remoteControl: true });
    }
  });

  it('rejects Remote Control on a non-loopback host', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner();
    const { stdout, stderr } = makeIo();

    await expect(
      handleWebCommand(
        { remoteControl: true, host: '0.0.0.0', open: false },
        { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
      ),
    ).rejects.toThrow('--remote-control requires a loopback host.');
  });

  it('shows --remote-control in help', () => {
    const remoteControlOption = makeProgram()
      .commands.find((command) => command.name() === 'web')!
      .options.find((option) => option.long === '--remote-control');
    expect(remoteControlOption?.hidden).toBeFalsy();
  });
});

describe('kimi rc', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('registers `rc` with the `remote` alias and the web server options, without a --remote-control flag', () => {
    const program = makeProgram();
    const rc = program.commands.find((c) => c.name() === 'rc');
    expect(rc).toBeDefined();
    expect(rc!.alias()).toBe('remote');
    const longs = rc!.options.map((o) => o.long).filter(Boolean);
    expect(longs).toContain('--port');
    expect(longs).toContain('--host');
    expect(longs).toContain('--no-open');
    expect(longs).not.toContain('--remote-control');
  });

  it('shows `rc` in help', () => {
    expect(makeProgram().helpInformation()).toContain('rc|remote');
  });

  it('forces Remote Control for both `rc` and `remote`', async () => {
    for (const name of ['rc', 'remote']) {
      const program = makeProgram();
      let stderr = '';
      const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stderr += String(chunk);
        return true;
      });
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => undefined as never);
      try {
        await program.parseAsync(['node', 'kimi', name, '--host', '0.0.0.0']);
      } finally {
        errSpy.mockRestore();
        exitSpy.mockRestore();
      }
      // The loopback check only runs when remoteControl was forced on.
      expect(stderr).toContain('--remote-control requires a loopback host.');
    }
  });
});

describe('`kimi web` option threading', () => {
  it('threads the CLI flags into the foreground runner options', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner, calls } = makeRunner();
    const { stdout, stderr } = makeIo();

    await handleWebCommand(
      {
        port: '59000',
        host: '0.0.0.0',
        insecureNoTls: true,
        allowedHost: ['.example.com'],
        dangerousBypassAuth: true,
        debugEndpoints: true,
        allowRemoteShutdown: true,
        open: false,
      },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );

    expect(calls.options).toEqual({
      host: '0.0.0.0',
      port: 59000,
      logLevel: 'silent',
      debugEndpoints: true,
      insecureNoTls: true,
      allowRemoteShutdown: true,
      dangerousBypassAuth: true,
      allowedHosts: ['.example.com'],
    });
  });

  it('defaults the host to 127.0.0.1 and insecureNoTls to true', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner, calls } = makeRunner();
    const { stdout, stderr } = makeIo();

    await handleWebCommand(
      { port: '58627', open: false },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );

    expect(calls.options).toMatchObject({
      host: '127.0.0.1',
      insecureNoTls: true,
      logLevel: 'silent',
    });
  });

  it('maps a bare --host to the default LAN host', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner, calls } = makeRunner();
    const { stdout, stderr } = makeIo();

    await handleWebCommand(
      { port: '58627', host: true, open: false },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );

    expect(calls.options).toMatchObject({ host: '0.0.0.0', insecureNoTls: true });
  });

  it('passes --log-level through to the runner', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner, calls } = makeRunner();
    const { stdout, stderr } = makeIo();

    await handleWebCommand(
      { port: '58627', logLevel: 'debug', open: false },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );

    expect(calls.options).toMatchObject({ logLevel: 'debug' });
  });

  it('passes --web-title through to the runner', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner, calls } = makeRunner();
    const { stdout, stderr } = makeIo();

    await handleWebCommand(
      { port: '58627', webTitle: 'My Dev Box', open: false },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );

    expect(calls.options).toMatchObject({ webTitle: 'My Dev Box' });
  });

  it('leaves webTitle undefined when --web-title is not passed', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner, calls } = makeRunner();
    const { stdout, stderr } = makeIo();

    await handleWebCommand(
      { port: '58627', open: false },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );

    expect(calls.options?.webTitle).toBeUndefined();
  });

  it('rejects an invalid --log-level before calling the runner', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const startServerForeground = vi.fn(async () => undefined as never);
    const { stdout, stderr } = makeIo();

    await expect(
      handleWebCommand(
        { logLevel: 'shout', open: false },
        { startServerForeground, openUrl: vi.fn(), stdout, stderr },
      ),
    ).rejects.toThrow(/invalid --log-level/);
    expect(startServerForeground).not.toHaveBeenCalled();
  });

  it('prints the one-line ready line instead of the full banner with a non-default --log-level', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    // A wildcard bind with a usable LAN address would pair on the full banner;
    // the compact line must not even generate (and write) the QR/PNG.
    const { runner } = makeRunner('http://0.0.0.0:58627');
    const { stdout, stderr, readStdout } = makeIo();
    const home = mkdtempSync(join(tmpdir(), 'kimi-web-logline-'));
    vi.stubEnv('KIMI_CODE_HOME', home);
    try {
      await handleWebCommand(
        { port: '58627', host: '0.0.0.0', logLevel: 'info', open: false },
        {
          startServerForeground: runner,
          resolveToken: () => 'tok',
          networkAddresses: [{ address: '192.168.1.5', family: 'IPv4' }],
          hostname: () => 'devbox',
          openUrl: vi.fn(),
          stdout,
          stderr,
        },
      );

      const plain = stripAnsi(readStdout());
      expect(plain).toContain('Kimi server: http://0.0.0.0:58627/#token=tok');
      expect(plain).not.toContain('Kimi server ready');
      expect(plain).not.toContain('Local:');
      expect(plain).not.toContain('Pairing:');
      // K3: a compact run must not mint a single-use pairing code into a PNG
      // it never displays.
      expect(existsSync(join(home, 'pairing-qrcode.png'))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('parses comma-separated --allowed-host values', async () => {
    const { parseAllowedHostArgs } = await import('#/cli/sub/web/shared');
    expect(parseAllowedHostArgs(['.example.com, app.example.com'])).toEqual([
      '.example.com',
      'app.example.com',
    ]);
  });
});

describe('shared parsers stay strict', () => {
  it('rejects out-of-range --port', async () => {
    const { parsePort } = await import('#/cli/sub/web/shared');
    expect(() => parsePort('99999', '--port', 58627)).toThrow(/invalid --port/);
    expect(() => parsePort('-1', '--port', 58627)).toThrow(/invalid --port/);
    expect(parsePort(undefined, '--port', 58627)).toBe(58627);
    expect(parsePort('8080', '--port', 58627)).toBe(8080);
  });

  it('rejects unknown --log-level values', async () => {
    const { parseLogLevel } = await import('#/cli/sub/web/shared');
    expect(() => parseLogLevel('shout')).toThrow(/invalid --log-level/);
    expect(parseLogLevel(undefined)).toBe('info');
    expect(parseLogLevel('debug')).toBe('debug');
  });
});

describe('server web asset directory resolution', () => {
  it('uses extracted SEA web assets when available', async () => {
    const { resolveServerWebAssetsDir } = await import('#/cli/sub/web/run');
    expect(resolveServerWebAssetsDir('/cache/kimi/dist-web')).toBe('/cache/kimi/dist-web');
  });

  it('falls back to package dist-web outside SEA mode', async () => {
    const { resolveServerWebAssetsDir } = await import('#/cli/sub/web/run');
    expect(resolveServerWebAssetsDir(null)).toMatch(/[/\\]dist-web$/);
  });

  it('returns the assets dir when it is built, dev mode or not', async () => {
    const { serverWebAssetsDir } = await import('#/cli/sub/web/run');
    const dir = mkdtempSync(join(tmpdir(), 'kimi-web-assets-'));
    try {
      writeFileSync(join(dir, 'index.html'), '<html></html>');
      expect(serverWebAssetsDir({}, dir)).toBe(dir);
      expect(serverWebAssetsDir({ KIMI_CODE_DEV_SERVER: '1' }, dir)).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires built assets outside dev mode', async () => {
    const { serverWebAssetsDir } = await import('#/cli/sub/web/run');
    const dir = mkdtempSync(join(tmpdir(), 'kimi-web-assets-'));
    try {
      expect(serverWebAssetsDir({}, dir)).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tolerates missing assets in dev mode (API-only server)', async () => {
    const { serverWebAssetsDir } = await import('#/cli/sub/web/run');
    const dir = mkdtempSync(join(tmpdir(), 'kimi-web-assets-'));
    try {
      expect(serverWebAssetsDir({ KIMI_CODE_DEV_SERVER: '1' }, dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function makeLegacyKillDeps(overrides: Partial<LegacyKillDeps> = {}): {
  deps: LegacyKillDeps;
  writes: string[];
  errors: string[];
  signals: Array<{ pid: number; signal: NodeJS.Signals }>;
  state: { shutdownCalls: number; removeCalls: number };
  clock: { t: number };
} {
  const writes: string[] = [];
  const errors: string[] = [];
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const state = { shutdownCalls: 0, removeCalls: 0 };
  const clock = { t: 0 };
  const deps: LegacyKillDeps = {
    readLock: async () => undefined,
    removeLock: async () => {
      state.removeCalls += 1;
    },
    requestShutdown: async () => {
      state.shutdownCalls += 1;
    },
    resolveToken: () => undefined,
    signalPid: (pid, signal) => {
      signals.push({ pid, signal });
      return true;
    },
    pidAlive: () => false,
    sleep: async (ms) => {
      clock.t += ms;
    },
    stdout: {
      write(chunk: string | Uint8Array) {
        writes.push(String(chunk));
        return true;
      },
    },
    stderr: {
      write(chunk: string | Uint8Array) {
        errors.push(String(chunk));
        return true;
      },
    },
    now: () => clock.t,
    ...overrides,
  };
  return { deps, writes, errors, signals, state, clock };
}

describe('`kimi server kill` (deprecated, legacy servers only)', () => {
  const legacyLock = { pid: 1234, host: '127.0.0.1', port: 58627 };

  it('is registered as the only working subcommand of the deprecated `server` command', () => {
    const program = makeProgram();
    const server = program.commands.find((c) => c.name() === 'server');
    expect(server).toBeDefined();
    expect(server?.commands.map((c) => c.name())).toEqual(['kill']);
  });

  it('prints a deprecation notice naming the 0.28.0 cutoff on every run', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    const { deps, errors } = makeLegacyKillDeps();

    await handleLegacyKillCommand(deps);

    const notice = errors.join('');
    expect(notice).toContain('deprecated');
    expect(notice).toContain('0.28.0');
    expect(notice).toContain('Ctrl+C');
  });

  it('prints "No running legacy Kimi server." and sends no signal when no lock exists', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    const { deps, writes, signals } = makeLegacyKillDeps({ readLock: async () => undefined });

    await handleLegacyKillCommand(deps);

    expect(writes.join('')).toContain('No running legacy Kimi server.');
    expect(signals).toEqual([]);
  });

  it('sweeps a stale lock whose pid is already dead', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    const { deps, writes, signals, state } = makeLegacyKillDeps({
      readLock: async () => legacyLock,
      pidAlive: () => false,
    });

    await handleLegacyKillCommand(deps);

    expect(writes.join('')).toContain('No running legacy Kimi server.');
    expect(signals).toEqual([]);
    expect(state.shutdownCalls).toBe(0);
    expect(state.removeCalls).toBe(1);
  });

  it('attempts the API shutdown, then stops after SIGTERM when the pid exits promptly', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    const { deps, writes, signals, state, clock } = makeLegacyKillDeps({
      readLock: async () => legacyLock,
      pidAlive: () => clock.t < 50,
    });

    await handleLegacyKillCommand(deps);

    expect(state.shutdownCalls).toBe(1);
    expect(signals).toEqual([{ pid: 1234, signal: 'SIGTERM' }]);
    expect(writes.join('')).toContain('pid 1234');
    expect(writes.join('')).toContain('stopped.');
    // The lock is removed once the pid is confirmed dead.
    expect(state.removeCalls).toBe(1);
  });

  it('escalates to SIGKILL when the pid survives SIGTERM', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    const { deps, writes, signals, clock } = makeLegacyKillDeps({
      readLock: async () => ({ ...legacyLock, pid: 5678 }),
      // Survives the 3s SIGTERM grace, dies during the 2s SIGKILL grace.
      pidAlive: () => clock.t < 3100,
    });

    await handleLegacyKillCommand(deps);

    expect(signals.map((s) => s.signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(writes.join('')).toContain('pid 5678');
    expect(writes.join('')).toContain('killed.');
  });

  it('throws a permissions error when the pid survives SIGKILL', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    const { deps } = makeLegacyKillDeps({
      readLock: async () => ({ ...legacyLock, pid: 9999 }),
      pidAlive: () => true,
    });

    await expect(handleLegacyKillCommand(deps)).rejects.toThrow(/insufficient permissions/);
  });

  it('skips the API path when the lock records no port', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    const { deps, signals, state, clock } = makeLegacyKillDeps({
      readLock: async () => ({ pid: 1234 }),
      // Alive at the initial check, dead when the SIGTERM grace polls.
      pidAlive: () => clock.t < 50,
    });

    await handleLegacyKillCommand(deps);

    expect(state.shutdownCalls).toBe(0);
    expect(signals).toEqual([{ pid: 1234, signal: 'SIGTERM' }]);
  });

  it('passes the resolved token to requestShutdown', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    let seenToken: string | undefined = 'unset';
    const { deps, clock } = makeLegacyKillDeps({
      readLock: async () => legacyLock,
      resolveToken: () => 'tok-123',
      requestShutdown: async (_origin, token) => {
        seenToken = token;
      },
      pidAlive: () => clock.t < 50,
    });

    await handleLegacyKillCommand(deps);

    expect(seenToken).toBe('tok-123');
  });

  it('passes undefined when the token cannot be read (best-effort)', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    let seenToken: string | undefined = 'unset';
    const { deps, clock } = makeLegacyKillDeps({
      readLock: async () => legacyLock,
      resolveToken: () => undefined,
      requestShutdown: async (_origin, token) => {
        seenToken = token;
      },
      pidAlive: () => clock.t < 50,
    });

    await handleLegacyKillCommand(deps);

    expect(seenToken).toBeUndefined();
  });
});

describe('readLegacyLock', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-legacy-lock-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses a lock written by an old build', async () => {
    const { readLegacyLock } = await import('#/cli/sub/web/legacy-kill');
    const lockPath = join(dir, 'lock');
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 1234, started_at: '2026-01-01T00:00:00.000Z', port: 58627 }),
    );

    await expect(readLegacyLock(lockPath)).resolves.toEqual({
      pid: 1234,
      host: undefined,
      port: 58627,
    });
  });

  it('rejects a corrupt lock whose pid is not a positive integer', async () => {
    const { readLegacyLock } = await import('#/cli/sub/web/legacy-kill');
    const lockPath = join(dir, 'lock');
    // pid 0 / negative pids have process-group semantics on POSIX — the lock
    // must be treated as unusable rather than signaled.
    for (const pid of [0, -1, 1.5, '1234']) {
      writeFileSync(lockPath, JSON.stringify({ pid, port: 58627 }));
      await expect(readLegacyLock(lockPath)).resolves.toBeUndefined();
    }
  });

  it('returns undefined when the lock file is missing or unparseable', async () => {
    const { readLegacyLock } = await import('#/cli/sub/web/legacy-kill');
    await expect(readLegacyLock(join(dir, 'missing'))).resolves.toBeUndefined();
    const lockPath = join(dir, 'lock');
    writeFileSync(lockPath, 'not json');
    await expect(readLegacyLock(lockPath)).resolves.toBeUndefined();
  });
});

describe('resolveServerToken', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-server-token-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the token from <homeDir>/server.token', async () => {
    const { resolveServerToken } = await import('#/cli/sub/web/shared');
    writeFileSync(join(dir, 'server.token'), 'secret-token\n');
    expect(resolveServerToken(dir)).toBe('secret-token');
  });

  it('trims surrounding whitespace', async () => {
    const { resolveServerToken } = await import('#/cli/sub/web/shared');
    writeFileSync(join(dir, 'server.token'), '  tok  \n');
    expect(resolveServerToken(dir)).toBe('tok');
  });

  it('throws a clear error when the token file is missing', async () => {
    const { resolveServerToken } = await import('#/cli/sub/web/shared');
    expect(() => resolveServerToken(dir)).toThrow(/unable to read server token/);
  });
});

describe('authHeaders', () => {
  it('builds a Bearer Authorization header', async () => {
    const { authHeaders } = await import('#/cli/sub/web/shared');
    expect(authHeaders('abc')).toEqual({ Authorization: 'Bearer abc' });
  });
});

describe('buildWebUrl', () => {
  it('carries the token in the URL fragment (not path or query)', async () => {
    const { buildWebUrl } = await import('#/cli/sub/web/run');
    const url = buildWebUrl('http://127.0.0.1:58627', 'abc123');
    expect(url).toBe('http://127.0.0.1:58627/#token=abc123');
    const parsed = new URL(url);
    expect(parsed.hash).toBe('#token=abc123');
    // The token is client-side only: it must NOT appear in the path or query
    // (which WOULD be sent to the server and logged).
    expect(parsed.pathname).not.toContain('abc123');
    expect(parsed.search).not.toContain('abc123');
  });

  it('normalizes a trailing slash', async () => {
    const { buildWebUrl } = await import('#/cli/sub/web/run');
    expect(buildWebUrl('http://127.0.0.1:58627/', 't')).toBe(
      'http://127.0.0.1:58627/#token=t',
    );
  });
});

describe('accessUrlLines', () => {
  it('returns Local + Network lines for a wildcard bind', async () => {
    const { accessUrlLines } = await import('#/cli/sub/web/access-urls');
    const lines = accessUrlLines('0.0.0.0', 58627, 'tok', [
      { address: '192.168.1.5', family: 'IPv4' },
    ]);
    expect(lines).toEqual([
      { label: 'Local:    ', url: 'http://localhost:58627/#token=tok' },
      { label: 'Network:  ', url: 'http://192.168.1.5:58627/#token=tok' },
    ]);
  });

  it('returns a single Local line for a loopback bind', async () => {
    const { accessUrlLines } = await import('#/cli/sub/web/access-urls');
    const lines = accessUrlLines('127.0.0.1', 58627, 'tok');
    expect(lines).toEqual([
      { label: 'Local:    ', url: 'http://127.0.0.1:58627/#token=tok' },
    ]);
  });

  it('returns a single URL line for a specific host (no token)', async () => {
    const { accessUrlLines } = await import('#/cli/sub/web/access-urls');
    const lines = accessUrlLines('192.168.1.5', 58627, undefined);
    expect(lines).toEqual([{ label: 'URL:      ', url: 'http://192.168.1.5:58627/' }]);
  });

  it('splitTokenFragment splits off the #token= fragment', async () => {
    const { splitTokenFragment } = await import('#/cli/sub/web/access-urls');
    expect(splitTokenFragment('http://h:1/#token=abc')).toEqual(['http://h:1/', '#token=abc']);
    expect(splitTokenFragment('http://h:1/')).toEqual(['http://h:1/', '']);
  });
});

describe('browserOpenOrigin', () => {
  it('rewrites wildcard bind hosts to localhost on the same port', async () => {
    const { browserOpenOrigin } = await import('#/cli/sub/web/access-urls');
    expect(browserOpenOrigin('http://0.0.0.0:58627')).toBe('http://localhost:58627');
    expect(browserOpenOrigin('http://:::58627')).toBe('http://localhost:58627');
  });

  it('keeps navigable origins unchanged', async () => {
    const { browserOpenOrigin } = await import('#/cli/sub/web/access-urls');
    expect(browserOpenOrigin('http://127.0.0.1:58627')).toBe('http://127.0.0.1:58627');
    expect(browserOpenOrigin('http://192.168.1.5:58627')).toBe('http://192.168.1.5:58627');
    expect(browserOpenOrigin('http://[::1]:58627')).toBe('http://[::1]:58627');
  });
});

describe('`kimi web rotate-token`', () => {
  let dir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-rotate-'));
    prevHome = process.env['KIMI_CODE_HOME'];
    process.env['KIMI_CODE_HOME'] = dir;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env['KIMI_CODE_HOME'];
    } else {
      process.env['KIMI_CODE_HOME'] = prevHome;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a new token to server.token and prints it', async () => {
    const { registerWebCommand } = await import('#/cli/sub/web');
    const program = new Command('kimi').exitOverride();
    registerWebCommand(program);
    let stdout = '';
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });

    await program.parseAsync(['node', 'kimi', 'web', 'rotate-token']);
    writeSpy.mockRestore();

    const token = readFileSync(join(dir, 'server.token'), 'utf8').trim();
    expect(token.length).toBeGreaterThan(20);
    expect(stdout).toContain('New server token');
    expect(stdout).toContain(token);
  });

  it('re-prints the access links with the new token when a server is running', async () => {
    const { registerWebCommand } = await import('#/cli/sub/web');
    const { mkdirSync, writeFileSync: writeSync } = await import('node:fs');
    // Fake a live instance-registry entry pointing at this (alive) process so
    // getLiveServerInstance() finds the running server and the command can
    // re-print its links.
    mkdirSync(join(dir, 'server', 'instances'), { recursive: true });
    writeSync(
      join(dir, 'server', 'instances', '01JTEST0000000000000000000.json'),
      JSON.stringify({
        server_id: '01JTEST0000000000000000000',
        pid: process.pid,
        host: '127.0.0.1',
        port: 58627,
        started_at: Date.now(),
        heartbeat_at: Date.now(),
      }),
    );

    const program = new Command('kimi').exitOverride();
    registerWebCommand(program);
    let stdout = '';
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });

    await program.parseAsync(['node', 'kimi', 'web', 'rotate-token']);
    writeSpy.mockRestore();

    const token = readFileSync(join(dir, 'server.token'), 'utf8').trim();
    expect(stdout).toContain('New server token');
    expect(stdout).toContain(`http://127.0.0.1:58627/#token=${token}`);
    // Token line sits between the note and the links.
    expect(stdout.indexOf('picks up the new token')).toBeLessThan(
      stdout.indexOf('New server token'),
    );
    expect(stdout.indexOf('New server token')).toBeLessThan(
      stdout.indexOf(`http://127.0.0.1:58627/#token=${token}`),
    );
  });
});

describe('formatHostForUrl', () => {
  it('bracket-wraps IPv6 and leaves IPv4 as-is', async () => {
    const { formatHostForUrl } = await import('#/cli/sub/web/networks');
    expect(formatHostForUrl('192.168.1.5', 'IPv4')).toBe('192.168.1.5');
    expect(formatHostForUrl('fe80::1', 'IPv6')).toBe('[fe80::1]');
  });
});

describe('filterDisplayAddresses', () => {
  it('drops IPv6 link-local, de-duplicates, and orders IPv4 before IPv6', async () => {
    const { filterDisplayAddresses } = await import('#/cli/sub/web/networks');
    const out = filterDisplayAddresses([
      { address: 'fe80::ecf3:c2ff:fe9c:11c3', family: 'IPv6' },
      { address: '192.168.1.5', family: 'IPv4' },
      { address: 'fe80::ecf3:c2ff:fe9c:11c3', family: 'IPv6' },
      { address: '10.0.0.1', family: 'IPv4' },
      { address: 'fe80::1', family: 'IPv6' },
      { address: '2001:db8::1', family: 'IPv6' },
    ]);
    expect(out).toEqual([
      { address: '192.168.1.5', family: 'IPv4' },
      { address: '10.0.0.1', family: 'IPv4' },
      { address: '2001:db8::1', family: 'IPv6' },
    ]);
  });
});
