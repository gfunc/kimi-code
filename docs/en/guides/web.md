# Using Kimi Code in the browser

Kimi Code Web is the browser-based graphical interface built into Kimi Code CLI: run `kimi web` in a terminal, and you can start sessions, chat, handle approvals, and review file changes in a browser — a friendlier interface, while sessions and data still live entirely on your machine.

![Kimi Code Web UI](../../media/kimi-web-ui.jpg)

## Getting started

<div class="step">
<span class="step-num">1</span> <strong>Install Kimi Code CLI and log in</strong>

`kimi web` is a built-in CLI command — it isn't available without the CLI. See [Getting started](./getting-started.md) for installation and login.
</div>

<div class="step">
<span class="step-num">2</span> <strong>Run <code>kimi web</code> in a terminal</strong>

If you're already in the CLI, you can also type `/web` to hand the current session off to the browser.
</div>

<div class="step">
<span class="step-num">3</span> <strong>The web UI opens in your default browser once ready</strong>

The startup banner prints the access URL — if the browser doesn't open by itself, copy this URL and open it manually:

```text
Local:   http://127.0.0.1:58627/#token=...
Token:   ...
Stop:    Ctrl+C
```

::: warning
The `#token=` fragment is the access credential — don't share it. Stop the server with `Ctrl+C` in the terminal.
:::
</div>

### Startup options

| Option | Description |
| --- | --- |
| `--port <port>` | Bind port; defaults to `58627`, auto-increments when taken |
| `--host [host]` | Let phones, tablets, or other computers on the same LAN access the web address; you can also specify an IP, e.g. `--host 192.168.1.10` |
| `--no-open` | Don't open the browser when ready |
| `--log-level <level>` | Enable server logs at the given level; off by default |

### Common slash commands

| Slash command | Description |
| --- | --- |
| `/new` | Start a new session |
| `/goal` | Enter Goal mode and keep working toward the same objective across turns |
| `/compact` | Compact the current session's context |
| `/tower` | Tower multi-agent collaboration (experimental); `/tower <base-branch>` sets the base branch |
| `/export` | Export the session content and troubleshooting logs as a ZIP |
| `/remote-control` | Enable remote control to access the local web session remotely |

## Relationship with the CLI

The web UI and the CLI share the same login state, configuration (`config.toml`), and session data.

The web UI supports only a subset of the CLI's slash commands — see [Common slash commands](#common-slash-commands) above. Everything else usually has a point-and-click equivalent in the UI (the settings page, the model picker, the account menu, the task panel).

How the two sides compare:

<div class="feature-compare-table">

| Feature | CLI | Web | Notes |
| --- | --- | --- | --- |
| Streaming chat | ✓ | ✓ | Web renders rich formats incrementally (tables, code highlighting, diffs, tool cards) |
| Session management | ✓ | ✓ | Web lets you archive less-used sessions away; the archive page sorts them by time and you can restore them anytime; the Open / Done / Workspaces tabs are a Lab experiment (off by default) — enable them on the settings Lab page |
| Approvals | ✓ | ✓ | Web handles them with clicks in the UI — no commands needed |
| Background tasks | ✓ | ✓ | Web shows live progress in the task panel |
| Files and changes | ✓ | ✓ | Web has a changed-files summary card and per-file diffs |
| Settings | ✓ | ✓ | Web adds a settings UI (providers, account & usage, Lab experiments) |
| Global search | — | ✓ | Web searches across sessions and workspaces |
| Mobile layout | — | ✓ | With LAN sharing on (`--host`), it works in phone browsers on the same network |

</div>

## Pair the Kimi mobile app over LAN

When the server is started with `--host`, the ready banner also prints a pairing QR: scanning it with the Kimi mobile app connects the phone to this server without typing the address and token. The QR encodes a `kimi://pair?…` payload — the machine's LAN address and port, a one-time pairing code, and the machine's name — plus a PNG fallback written to the data directory (the `QR PNG:` path in the banner) for terminals where the QR itself does not scan.

The pairing code is deliberately short-lived: it expires 60 seconds after the banner is printed and works exactly once, so a second device or a second attempt needs a fresh one. To print a new QR without restarting the server, run the command shown on the banner's `Reprint:` line (`kill -USR2 <pid>`). The hint only appears on macOS and Linux — Windows has no equivalent signal — and the QR itself is only printed on the full startup banner: keep server logs off (the default), and note that `--remote-control` mode and `--dangerous-bypass-auth` never print one.

Pairing survives restarts. A successful scan exchanges the code for a device token that the phone reuses on every later connection; the server stores only its SHA-256 hash, in `~/.kimi-code/server/auth/device-tokens.json` (a `0600` file in a `0700` directory). Neither a server restart nor `kimi web rotate-token` invalidates it — to unpair every device, delete that file and restart the server.

::: warning
Everything runs over plain HTTP on the LAN — there is no TLS unless you put your own TLS-terminating reverse proxy in front of the server. Anyone who scans the QR within its 60-second window can pair a device, and a local eavesdropper can read the traffic exchanged afterwards. Pair only on networks you trust. `KIMI_CODE_PASSWORD` is an alternative bearer credential, not a second gate for pairing.
:::

## Push notifications with ntfy (experimental)

The server can publish attention events — approval requested, question asked, turn finished, agent error, remote control connected/disconnected — to an [ntfy](https://ntfy.sh) topic (a push-notification publish/subscribe service), so a paired phone learns about a pending approval even when the app is in the background. The feature is experimental and off by default: set `KIMI_CODE_EXPERIMENTAL_NTFY_NOTIFICATIONS=1` (or `KIMI_CODE_EXPERIMENTAL_FLAG=1`) to enable it.

Settings live in the `[notifications]` table of `config.toml` — not to be confused with the `[notifications]` table of `tui.toml`, which controls desktop notifications:

| Field | Type | Description |
| --- | --- | --- |
| `enabled` | `boolean` | Master switch; push is active only when the experimental flag is also on and `topic` is set |
| `ntfy_url` | `string` | ntfy server URL; defaults to `https://ntfy.sh` |
| `topic` | `string` | Topic name to publish to; required for push to activate |
| `token` | `string` | ntfy access token the server publishes with; read from config only, never exposed through the API |
| `subscription_token` | `string` | ntfy access token for subscribing clients (such as the phone); served only through `GET /api/v1/notifications/config` |
| `min_priority` | `integer` | Minimum ntfy priority (1–5) to publish; defaults to `1` |
| `events` | `string[]` | Events to publish; defaults to all of them |

```toml
# ~/.kimi-code/config.toml
[notifications]
enabled = true
topic = "a-hard-to-guess-topic"
subscription_token = "ntfy access token for your phone"
```

Every field has a same-named environment variable override (`KIMI_CODE_NTFY_ENABLED`, `KIMI_CODE_NTFY_URL`, `KIMI_CODE_NTFY_TOPIC`, `KIMI_CODE_NTFY_TOKEN`, `KIMI_CODE_NTFY_SUBSCRIPTION_TOKEN`, `KIMI_CODE_NTFY_MIN_PRIORITY`, `KIMI_CODE_NTFY_EVENTS`) — see [Environment variables](../configuration/env-vars.md). Subscribing clients read the topic and `subscription_token` from the authenticated `GET /api/v1/notifications/config` endpoint; the server's own publish `token` is never part of the response. When using the public ntfy server, pick a topic name that is hard to guess — anyone who knows it can subscribe.

## Security notes

- **Set a parallel credential**: when binding a LAN address, also set the `KIMI_CODE_PASSWORD` environment variable; the server then rate-limits authentication failures automatically.
- **Assume LAN traffic is readable**: binds beyond loopback serve plain HTTP — the pairing exchange and all subsequent traffic can be observed by anyone on the same network (see [Pair the Kimi mobile app over LAN](#pair-the-kimi-mobile-app-over-lan)).
- **Don't disable authentication entirely**: `--dangerous-bypass-auth` turns off all authentication — anyone who can reach the port can control your sessions, file system, and shell. Only use it on trusted networks or behind your own authenticating proxy. See the [kimi command reference](../reference/kimi-command.md#kimi-web).

## FAQ

### The port is already taken

Nothing to do. `kimi web` automatically retries with the next port (58628, 58629, …) — just use the address printed in the startup banner.

### The URL won't open in the browser

First check the server is still running in the terminal (it runs in the foreground there). Copy the full URL including the `#token=` part; opening only `http://127.0.0.1:58627` lands on a token input page, where pasting the `Token` value from the banner also works.

### How to recover from an invalid token

Run `kimi web rotate-token` to generate a new token, then open the new banner URL. All running instances switch to the new token automatically — no restart needed.

### Other devices on the same Wi-Fi can't connect

Make sure you started with `--host` (bare is fine), and use the LAN URL from the banner (like `http://192.168.x.x:58627/#token=...`). If it still fails, check that the machine's firewall allows the port, and that both devices are really on the same network segment — guest Wi-Fi, VPNs, and switching to a 4G/5G hotspot all isolate devices.

### The mobile app rejects the pairing code

Pairing codes expire 60 seconds after the banner is printed and are single-use, so an old QR (or a second scan of the same one) is rejected. Print a fresh banner with the `Reprint:` command (`kill -USR2 <pid>`) and scan the new QR. A phone that was paired before keeps working across restarts and `kimi web rotate-token` — re-pairing is only needed after `server/auth/device-tokens.json` was deleted.

## Next steps

- [Server API](../reference/server-api.md) — REST / WebSocket APIs for scripts and third-party integrations (experimental)
- [kimi command](../reference/kimi-command.md#kimi-web) — all `kimi web` command-line options
- [Remote Control](./remote-control.md) — remotely view and take over local sessions from any device over the public internet
