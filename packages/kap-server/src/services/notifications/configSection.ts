import {
  type ConfigSchema,
  type ConfigStripEnv,
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
} from '@moonshot-ai/agent-core-v2/app/config/config';
import { registerConfigSection } from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

export const NOTIFICATIONS_SECTION = 'notifications';
export const DEFAULT_NTFY_URL = 'https://ntfy.sh';

export const NOTIFICATION_EVENTS = [
  'approval.requested',
  'question.requested',
  'work.finished',
  'agent.error',
  'remote_control.connected',
  'remote_control.disconnected',
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

const notificationEventSchema = z.enum(NOTIFICATION_EVENTS);

export interface NotificationsConfig {
  readonly enabled: boolean;
  readonly ntfyUrl: string;
  readonly topic?: string;
  readonly token?: string;
  readonly minPriority: number;
  readonly events: readonly NotificationEvent[];
}

const DEFAULT_EVENTS: NotificationEvent[] = [...NOTIFICATION_EVENTS];

export const DEFAULT_NOTIFICATIONS_CONFIG: NotificationsConfig = {
  enabled: false,
  ntfyUrl: DEFAULT_NTFY_URL,
  minPriority: 1,
  events: DEFAULT_EVENTS,
};

export const notificationsConfigSchema = z.object({
  enabled: z.boolean().catch(false).default(false),
  ntfyUrl: z.string().catch(DEFAULT_NTFY_URL).default(DEFAULT_NTFY_URL),
  topic: z.string().optional().catch(undefined),
  token: z.string().optional().catch(undefined),
  minPriority: z
    .number()
    .catch(1)
    .default(1)
    .transform((value) => Math.min(5, Math.max(1, Math.round(value)))),
  events: z.array(notificationEventSchema).catch(DEFAULT_EVENTS).default(DEFAULT_EVENTS),
});

const notificationsSchema: ConfigSchema<NotificationsConfig> = {
  parse: (value: unknown): NotificationsConfig => notificationsConfigSchema.parse(value),
};

const on = (raw: string): boolean | undefined => {
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
  return undefined;
};

const parseMinPriority = (raw: string): number | undefined => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return undefined;
  return Math.min(5, Math.max(1, parsed));
};

const parseEvents = (raw: string): readonly NotificationEvent[] | undefined => {
  const parsed = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => (NOTIFICATION_EVENTS as readonly string[]).includes(entry));
  return parsed.length === 0 ? undefined : (parsed as readonly NotificationEvent[]);
};

export const notificationsEnvBindings: EnvBindings<NotificationsConfig> = envBindings(
  notificationsSchema,
  {
    enabled: { env: 'KIMI_CODE_NTFY_ENABLED', parse: on },
    ntfyUrl: 'KIMI_CODE_NTFY_URL',
    topic: 'KIMI_CODE_NTFY_TOPIC',
    token: 'KIMI_CODE_NTFY_TOKEN',
    minPriority: { env: 'KIMI_CODE_NTFY_MIN_PRIORITY', parse: parseMinPriority },
    events: { env: 'KIMI_CODE_NTFY_EVENTS', parse: parseEvents },
  },
);

export const stripNotificationsEnv: ConfigStripEnv<NotificationsConfig> =
  stripEnvBoundFields(notificationsEnvBindings);

registerConfigSection(NOTIFICATIONS_SECTION, notificationsSchema, {
  defaultValue: DEFAULT_NOTIFICATIONS_CONFIG,
  env: notificationsEnvBindings,
  stripEnv: stripNotificationsEnv,
});
