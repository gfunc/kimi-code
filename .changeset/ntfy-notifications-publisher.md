---
"@moonshot-ai/kap-server": minor
---

Add an experimental ntfy push notification publisher for session attention events (approvals, questions, turn completion, agent errors, remote-control state), gated behind the `KIMI_CODE_EXPERIMENTAL_NTFY_NOTIFICATIONS` flag and the `[notifications]` config section, plus a `GET /api/v1/notifications/config` route for paired clients.
