import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IConfigService } from '@moonshot-ai/agent-core-v2';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  notificationsConfigResponseSchema,
  type NotificationsConfigResponse,
} from '../src/protocol/rest-notifications';
import { type RunningServer, startServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

describe('server-v2 /api/v1/notifications/config', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  const env: Record<string, string | undefined> = {};

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-notifications-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      env,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as never);
      home = undefined;
    }
  });

  afterEach(() => {
    for (const key of Object.keys(env)) delete env[key];
  });

  async function boot(toml?: string): Promise<void> {
    await writeFile(join(home as string, 'config.toml'), toml ?? '', 'utf-8');
    await (server as RunningServer).core.accessor.get(IConfigService).reload();
  }

  async function getNotifications(): Promise<NotificationsConfigResponse> {
    const res = await authedFetch(server as RunningServer, base, '/api/v1/notifications/config');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<NotificationsConfigResponse>;
    expect(body.code).toBe(0);
    expect(body.request_id).toBeTypeOf('string');
    return notificationsConfigResponseSchema.parse(body.data);
  }

  it('defaults the experimental flag off even with the section enabled', async () => {
    await boot('[notifications]\nenabled = true\ntopic = "kc-topic"\n');
    const data = await getNotifications();
    expect(data.enabled).toBe(false);
    expect(data.flag_enabled).toBe(false);
    expect(data.topic).toBe('kc-topic');
    expect(data.ntfy_url).toBe('https://ntfy.sh');
    expect(data.min_priority).toBe(1);
    expect(data.events).toContain('approval.requested');
  });

  it('parses [notifications] values from the config file', async () => {
    await boot(
      [
        '[notifications]',
        'enabled = true',
        'topic = "kc-file-topic"',
        'ntfy_url = "https://ntfy.example.test"',
        'min_priority = 4',
        'events = ["approval.requested", "question.requested"]',
        '',
      ].join('\n'),
    );
    const data = await getNotifications();
    expect(data.ntfy_url).toBe('https://ntfy.example.test');
    expect(data.topic).toBe('kc-file-topic');
    expect(data.min_priority).toBe(4);
    expect(data.events).toEqual(['approval.requested', 'question.requested']);
  });

  it('applies KIMI_CODE_NTFY_* env bindings over the file values', async () => {
    await boot('[notifications]\nenabled = false\ntopic = "kc-file-topic"\n');
    env['KIMI_CODE_NTFY_URL'] = 'https://env.example.test';
    env['KIMI_CODE_NTFY_TOPIC'] = 'kc-env-topic';
    env['KIMI_CODE_NTFY_ENABLED'] = '1';
    env['KIMI_CODE_NTFY_MIN_PRIORITY'] = '3';
    env['KIMI_CODE_NTFY_EVENTS'] = 'approval.requested,agent.error';

    const data = await getNotifications();
    expect(data.ntfy_url).toBe('https://env.example.test');
    expect(data.topic).toBe('kc-env-topic');
    expect(data.min_priority).toBe(3);
    expect(data.events).toEqual(['approval.requested', 'agent.error']);
    expect(data.enabled).toBe(false);
  });

  it('reports enabled once the experimental flag env is set', async () => {
    await boot('[notifications]\nenabled = true\ntopic = "kc-topic"\n');
    env['KIMI_CODE_EXPERIMENTAL_NTFY_NOTIFICATIONS'] = '1';

    const data = await getNotifications();
    expect(data.flag_enabled).toBe(true);
    expect(data.enabled).toBe(true);
  });

  it('reports no topic by default', async () => {
    await boot('');
    const data = await getNotifications();
    expect(data.enabled).toBe(false);
    expect(data.topic).toBeNull();
  });

  it('requires bearer auth', async () => {
    const res = await fetch(`${base}/api/v1/notifications/config`);
    expect(res.status).toBe(401);
  });
});
