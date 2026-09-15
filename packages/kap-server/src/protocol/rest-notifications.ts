import { z } from 'zod';

export const notificationsConfigResponseSchema = z.object({
  enabled: z.boolean(),
  flag_enabled: z.boolean(),
  ntfy_url: z.string(),
  topic: z.string().nullable(),
  min_priority: z.number().int().min(1).max(5),
  events: z.array(z.string()),
});

export type NotificationsConfigResponse = z.infer<typeof notificationsConfigResponseSchema>;
