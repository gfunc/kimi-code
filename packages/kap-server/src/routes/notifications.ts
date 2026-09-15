import { IConfigService, IFlagService, type Scope } from '@moonshot-ai/agent-core-v2';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { notificationsConfigResponseSchema } from '../protocol/rest-notifications';
import type { NotificationsConfigResponse } from '../protocol/rest-notifications';
import {
  NOTIFICATIONS_SECTION,
  type NotificationsConfig,
} from '../services/notifications/configSection';
import { NOTIFICATIONS_FLAG_ID } from '../services/notifications/flag';

interface RouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerNotificationsRoutes(app: RouteHost, core: Scope): void {
  const route = defineRoute(
    {
      method: 'GET',
      path: '/notifications/config',
      success: { data: notificationsConfigResponseSchema },
      description: 'Get the ntfy push notification coordinates for paired clients (experimental)',
      tags: ['notifications'],
    },
    async (req, reply) => {
      const config = core.accessor.get(IConfigService);
      await config.ready;
      const section = config.get<NotificationsConfig>(NOTIFICATIONS_SECTION);
      const flagEnabled = core.accessor.get(IFlagService).enabled(NOTIFICATIONS_FLAG_ID);
      const topic = section.topic;
      const data: NotificationsConfigResponse = {
        enabled: flagEnabled && section.enabled && topic !== undefined && topic.length > 0,
        flag_enabled: flagEnabled,
        ntfy_url: section.ntfyUrl,
        topic: topic ?? null,
        min_priority: section.minPriority,
        events: [...section.events],
      };
      reply.send(okEnvelope(data, req.id));
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<RouteHost['get']>[2]);
}
