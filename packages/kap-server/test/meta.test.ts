import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IConfigService } from '@moonshot-ai/agent-core-v2';
import { IFeatureManager } from '@moonshot-ai/agent-core-v2/app/feature/featureManager';
import { getFeatureRecipes } from '@moonshot-ai/agent-core-v2/features/featureRegistry';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { metaCapabilitiesSchema } from '../src/protocol/rest-meta';
import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authedFetch } from './helpers/auth';

interface MetaBody {
  code: number;
  data: { experimental_flags?: Record<string, boolean> };
}

describe('/api/v1/meta experimental_flags', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-meta-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
  });

  beforeEach(() => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '0');
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_TOOL_SELECT', undefined);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      home = undefined;
    }
  });

  async function boot(toml?: string): Promise<string> {
    await writeFile(join(home as string, 'config.toml'), toml ?? '', 'utf-8');
    await (server as RunningServer).core.accessor.get(IConfigService).reload();
    return `http://127.0.0.1:${(server as RunningServer).port}`;
  }

  async function getMetaFlags(base: string): Promise<Record<string, boolean>> {
    const res = await authedFetch(server as RunningServer, base, '/api/v1/meta');
    expect(res.status).toBe(200);
    const body = (await res.json()) as MetaBody;
    expect(body.code).toBe(0);
    expect(body.data.experimental_flags).toBeDefined();
    return body.data.experimental_flags as Record<string, boolean>;
  }

  it('reports registered flags as off by default', async () => {
    const base = await boot();
    const flags = await getMetaFlags(base);
    expect(flags['tool-select']).toBe(false);
  });

  it('reports a config-enabled flag from the very first response', async () => {
    const base = await boot('[experimental]\ntool-select = true\n');
    const flags = await getMetaFlags(base);
    expect(flags['tool-select']).toBe(true);
  });

  it('reflects a flag enabled via its KIMI_CODE_EXPERIMENTAL_* env var', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_TOOL_SELECT', '1');
    const base = await boot();
    const flags = await getMetaFlags(base);
    expect(flags['tool-select']).toBe(true);
  });

  it('flips live when the [experimental] config section is written via POST /config', async () => {
    const base = await boot();
    expect((await getMetaFlags(base))['tool-select']).toBe(false);

    const res = await authedFetch(server as RunningServer, base, '/api/v1/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ experimental: { 'tool-select': true } }),
    });
    expect(res.status).toBe(200);

    expect((await getMetaFlags(base))['tool-select']).toBe(true);
  });

  it('keeps an env-forced flag on when the config section disables it', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_TOOL_SELECT', '1');
    const base = await boot();

    const res = await authedFetch(server as RunningServer, base, '/api/v1/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ experimental: { 'tool-select': false } }),
    });
    expect(res.status).toBe(200);

    expect((await getMetaFlags(base))['tool-select']).toBe(true);
  });
});

describe('/api/v1/meta web_title', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      home = undefined;
    }
  });

  async function bootWithWebTitle(
    webTitle?: string,
  ): Promise<{ base: string; body: { data: { web_title?: string } } }> {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-meta-title-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      webTitle,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const res = await authedFetch(server, base, '/api/v1/meta');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: number; data: { web_title?: string } };
    expect(body.code).toBe(0);
    return { base, body };
  }

  it('surfaces the boot-time webTitle as web_title', async () => {
    const { body } = await bootWithWebTitle('My Dev Box');
    expect(body.data.web_title).toBe('My Dev Box');
  });

  it('omits web_title when no webTitle was passed', async () => {
    const { body } = await bootWithWebTitle();
    expect(body.data.web_title).toBeUndefined();
  });
});

describe('/api/v1/meta features', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  interface FeatureWire {
    name: string;
    state: string;
    meta: Record<string, unknown>;
  }

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-meta-features-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      home = undefined;
    }
  });

  async function boot(): Promise<string> {
    return `http://127.0.0.1:${(server as RunningServer).port}`;
  }

  async function getMetaFeatures(base: string): Promise<FeatureWire[]> {
    const res = await authedFetch(server as RunningServer, base, '/api/v1/meta');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: number; data: { features?: FeatureWire[] } };
    expect(body.code).toBe(0);
    expect(body.data.features).toBeDefined();
    return body.data.features as FeatureWire[];
  }

  it('lists every registered built-in feature as Active with an empty meta', async () => {
    const base = await boot();
    const features = await getMetaFeatures(base);
    const expected = getFeatureRecipes()
      .map((recipe) => recipe.name)
      .toSorted();
    expect(features.map((feature) => feature.name).toSorted()).toEqual(expected);
    for (const feature of features) {
      expect(feature.state).toBe('Active');
      expect(feature.meta).toEqual({});
    }
  });

  it('drops a feature from the response after it is unprovided at runtime', async () => {
    const base = await boot();
    const before = await getMetaFeatures(base);
    expect(before.some((feature) => feature.name === 'plan')).toBe(true);

    await (server as RunningServer).core.accessor.get(IFeatureManager).unprovideUnit('plan');

    const after = await getMetaFeatures(base);
    expect(after.some((feature) => feature.name === 'plan')).toBe(false);
    expect(after).toHaveLength(before.length - 1);
  });
});

describe('/api/v1/meta capabilities', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  interface MobileApiCapability {
    pairing_exchange: boolean;
    agent_id_abort: boolean;
    plan_control_clear: boolean;
    notifications_config: boolean;
    device_management?: boolean;
  }

  interface CapabilitiesMetaBody {
    code: number;
    data: {
      capabilities: Record<string, unknown> & { mobile_api?: MobileApiCapability };
      experimental_flags?: Record<string, boolean>;
    };
  }

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-meta-caps-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
  });

  beforeEach(() => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '0');
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_TOOL_SELECT', undefined);
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_NTFY_NOTIFICATIONS', undefined);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      home = undefined;
    }
  });

  async function boot(toml?: string): Promise<string> {
    await writeFile(join(home as string, 'config.toml'), toml ?? '', 'utf-8');
    await (server as RunningServer).core.accessor.get(IConfigService).reload();
    return `http://127.0.0.1:${(server as RunningServer).port}`;
  }

  async function getMetaCapabilities(base: string): Promise<CapabilitiesMetaBody['data']> {
    const res = await authedFetch(server as RunningServer, base, '/api/v1/meta');
    expect(res.status).toBe(200);
    const body = (await res.json()) as CapabilitiesMetaBody;
    expect(body.code).toBe(0);
    return body.data;
  }

  it('keeps the six legacy capabilities as literal true', async () => {
    const base = await boot();
    const capabilities = (await getMetaCapabilities(base)).capabilities;
    expect(capabilities['websocket']).toBe(true);
    expect(capabilities['file_upload']).toBe(true);
    expect(capabilities['fs_query']).toBe(true);
    expect(capabilities['mcp']).toBe(true);
    expect(capabilities['tasks']).toBe(true);
    expect(capabilities['terminal']).toBe(true);
  });

  it('advertises mobile_api with the four stable mobile routes', async () => {
    const base = await boot();
    const mobile = (await getMetaCapabilities(base)).capabilities.mobile_api;
    expect(mobile?.pairing_exchange).toBe(true);
    expect(mobile?.agent_id_abort).toBe(true);
    expect(mobile?.plan_control_clear).toBe(true);
    expect(mobile?.notifications_config).toBe(true);
  });

  it('advertises device_management as server support for the host-only management endpoints, not a device-token grant', async () => {
    const base = await boot();
    const mobile = (await getMetaCapabilities(base)).capabilities.mobile_api;
    expect(mobile).toBeDefined();
    expect(mobile?.device_management).toBe(true);
  });

  it('advertises notifications_config regardless of the ntfy experimental flag', async () => {
    const base = await boot();
    const off = await getMetaCapabilities(base);
    expect(off.experimental_flags?.['ntfy_notifications']).toBe(false);
    expect(off.capabilities.mobile_api?.notifications_config).toBe(true);

    await boot('[experimental]\nntfy_notifications = true\n');
    const on = await getMetaCapabilities(base);
    expect(on.experimental_flags?.['ntfy_notifications']).toBe(true);
    expect(on.capabilities.mobile_api?.notifications_config).toBe(true);
  });

  it('still requires bearer auth', async () => {
    const base = await boot();
    const res = await fetch(`${base}/api/v1/meta`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: number };
    expect(body.code).toBe(40101);
  });

  it('accepts a legacy payload without mobile_api in the capabilities schema', async () => {
    const parsed = metaCapabilitiesSchema.parse({
      websocket: true,
      file_upload: true,
      fs_query: true,
      mcp: true,
      tasks: true,
      terminal: true,
    });
    expect(parsed).not.toHaveProperty('mobile_api');
  });

  it('accepts mobile_api without device_management in the capabilities schema', async () => {
    const parsed = metaCapabilitiesSchema.parse({
      websocket: true,
      file_upload: true,
      fs_query: true,
      mcp: true,
      tasks: true,
      terminal: true,
      mobile_api: {
        pairing_exchange: true,
        agent_id_abort: true,
        plan_control_clear: true,
        notifications_config: true,
      },
    });
    expect(parsed.mobile_api?.pairing_exchange).toBe(true);
    expect(parsed.mobile_api?.device_management).toBeUndefined();
  });
});
