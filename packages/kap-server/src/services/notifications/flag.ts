import { registerFlagDefinition } from '@moonshot-ai/agent-core-v2';

export const NOTIFICATIONS_FLAG_ID = 'ntfy_notifications';
export const NOTIFICATIONS_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_NTFY_NOTIFICATIONS';

registerFlagDefinition({
  id: NOTIFICATIONS_FLAG_ID,
  title: 'ntfy notifications',
  description:
    'Publish session attention events (approvals, questions, turn completion, main-agent errors, remote-control state) to an ntfy topic.',
  env: NOTIFICATIONS_FLAG_ENV,
  default: false,
  surface: 'core',
});
