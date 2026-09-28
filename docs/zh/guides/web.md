# 在网页中使用

Kimi Code Web 是 Kimi Code CLI 内置的浏览器图形界面：在终端运行 `kimi web`，就能在浏览器里新建会话、对话、处理审批、查看文件改动——界面更易读，会话和数据仍全部保存在你的本机。

![Kimi Code Web 界面](../../media/kimi-web-ui.jpg)

## 开始使用

<div class="step">
<span class="step-num">1</span> <strong>安装并登录 Kimi Code CLI</strong>

`kimi web` 是 CLI 的内置命令，未安装 CLI 时不可用。安装与登录见 [开始使用](./getting-started.md)。
</div>

<div class="step">
<span class="step-num">2</span> <strong>在终端运行 <code>kimi web</code></strong>

如果你已经在 CLI 里，也可以输入 `/web`，把当前会话交接到浏览器。
</div>

<div class="step">
<span class="step-num">3</span> <strong>服务就绪后自动用默认浏览器打开 Web 界面</strong>

启动横幅会打印访问地址，浏览器没有自动打开时，手动复制这行地址打开即可：

```text
Local:   http://127.0.0.1:58627/#token=...
Token:   ...
Stop:    Ctrl+C
```

::: warning 注意
地址里的 `#token=` 是访问凭证，请勿外发，停止服务在终端按 `Ctrl+C`。
:::
</div>

### 启动选项

| 选项 | 说明 |
| --- | --- |
| `--port <port>` | 绑定端口；默认 `58627`，被占用时自动 +1 重试 |
| `--host [host]` | 实现同一局域网下的手机、平板或其他电脑都能用 web 地址访问，也可指定 IP，如 `--host 192.168.1.10` |
| `--no-open` | 就绪后不自动打开浏览器 |
| `--log-level <level>` | 按所选级别开启服务日志；默认不输出 |

### 常用斜杠命令

| 斜杠命令 | 说明 |
| --- | --- |
| `/new` | 新开会话 |
| `/goal` | 进入目标模式，跨轮次持续推进同一目标 |
| `/compact` | 压缩当前会话上下文 |
| `/tower` | Tower 多 Agent 协作（实验功能），`/tower <base-branch>` 指定基准分支 |
| `/export` | 导出会话内容与故障排查日志为 ZIP |
| `/remote-control` | 开启远程控制，从远程访问本地 Web 会话 |


## 与 CLI 的关系

Web 界面和 CLI 共享同一份登录态、配置（`config.toml`）和会话数据。

Web 支持的斜杠命令见上文 [常用斜杠命令](#常用斜杠命令)，与 CLI 不完全一致；部分 CLI 指令在 Web 里有对应的图形入口（设置页、模型选择器、账户菜单、任务面板）。

两端能力对照如下：

<div class="feature-compare-table">

| 功能 | CLI | Web | 说明 |
| --- | --- | --- | --- |
| 流式对话 | ✓ | ✓ | Web 为富格式增量渲染（表格、代码高亮、diff、工具卡片） |
| 会话管理 | ✓ | ✓ | Web 可把不常用的会话归档收起，在已归档页按时间排序、随时恢复；Open / Done / Workspaces 标签页为 Lab 实验特性，默认关闭，需在设置的 Lab 页开启 |
| 审批处理 | ✓ | ✓ | Web 可在图形页面中点击处理，无需指令 |
| 后台任务 | ✓ | ✓ | Web 为任务面板实时展示进度 |
| 文件与改动 | ✓ | ✓ | Web 有改动文件摘要卡与逐文件 diff |
| 设置 | ✓ | ✓ | Web 另有图形化设置页（供应商、账号与用量、Lab 实验特性） |
| 全局搜索 | — | ✓ | Web 可实现跨会话、跨工作区搜索 |
| 移动端适配 | — | ✓ | `--host` 开启局域网共享后，可实现在同一局域网下的手机浏览器中使用 |

</div>

## 与 Kimi 手机 App 局域网配对

使用 `--host` 启动服务后，启动横幅还会打印一张配对二维码：用 Kimi 手机 App 扫码，即可免输地址和 token 直接连上这台服务器。二维码编码的是 `kimi://pair?…` 载荷——本机的局域网地址与端口、一次性配对码和机器名——并会在数据目录写入一张 PNG 备用图（横幅中的 `QR PNG:` 路径），终端里二维码扫不出来时可以打开这张图。上一次运行遗留的 PNG 会在下次启动时被清理，但要等它远超配对窗口期之后——清理阈值是两个配对窗口期（两分钟），仍可能有效的配对码绝不会被清理——且文件可删除时才会真正删除；清理是尽力而为的，没有保证的时限。

配对码刻意设计得很短命：横幅打印 60 秒后过期，且只能使用一次，第二台设备或第二次尝试都需要新的配对码。想不重启服务就换一张二维码，用横幅 `Reprint:` 一行给出的触发方式——macOS 和 Linux 上执行 `kill -USR2 <pid>`；Windows 交互式终端里按 `R`。Windows 没有交互式终端时没有重打印触发方式，横幅会改为提示 `restart kimi web`。该提示只随完整启动横幅出现：保持服务日志关闭（默认即关闭），并注意 `--remote-control` 模式与 `--dangerous-bypass-auth` 下不会打印。

配对可以跨重启保留。扫码成功后，App 会用配对码换到一枚设备 token，之后每次连接都复用它；服务端只保存它的 SHA-256 哈希，位于 `~/.kimi-code/server/auth/device-tokens.json`（`0700` 目录下的 `0600` 文件）。每次配对都会得到一个设备 id，宿主机可以通过设备管理 API 列出已配对设备或撤销某一台（见 [服务 API：设备管理](../reference/server-api.md#设备管理)）——被撤销的设备下一次请求就会收到 HTTP 401，其活动连接也会被关闭。服务重启和 `kimi web rotate-token` 都不会使设备 token 失效——想让所有设备一次性解除配对，删除该文件即可：新请求立即失败，活动连接会在约半分钟内的复核中被关闭。旧版本写入的文件（裸哈希列表）会在启动时自动迁移为按设备记录的格式。

::: warning 注意
所有流量在局域网上都以明文 HTTP 传输——除非你在服务前面自建 TLS 卸载反向代理，否则没有 TLS。任何在 60 秒窗口内扫到二维码的人都能配对一台设备，同一网络中的窃听者也能读到之后的通信内容。请只在可信网络中配对。若所用 App 版本支持手动输入 HTTPS/WSS 地址，也可以在 App 里手动输入反代地址，穿过这样的代理完成配对——二维码本身编码的始终是局域网明文地址。这种情况下，手机系统必须信任代理的证书（任意的自签证书不行），且代理转发的 `Host` 头必须通过服务端 `--allowed-host` 检查。`KIMI_CODE_PASSWORD` 是另一种 bearer 凭证，并非配对时的第二道门槛。
:::

## ntfy 推送通知（实验功能）

服务可以把需要关注的事件——审批请求、提问、轮次结束、Agent 出错、远程控制连接/断开——发布到 [ntfy](https://ntfy.sh) 主题（topic，一种推送通知的发布/订阅服务），这样手机 App 退到后台也能收到审批提醒。该功能是实验性的，默认关闭：设置 `KIMI_CODE_EXPERIMENTAL_NTFY_NOTIFICATIONS=1`（或 `KIMI_CODE_EXPERIMENTAL_FLAG=1`）启用。

配置位于 `config.toml` 的 `[notifications]` 表——注意别与 `tui.toml` 里控制桌面通知的 `[notifications]` 表混淆：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `enabled` | `boolean` | 总开关；实验开关同时打开且 `topic` 已设置时推送才会激活 |
| `ntfy_url` | `string` | ntfy 服务器 URL；默认 `https://ntfy.sh` |
| `topic` | `string` | 发布目标主题名；推送激活的必要条件 |
| `token` | `string` | 服务端发布时使用的 ntfy 访问令牌；只从配置读取，绝不通过 API 暴露 |
| `subscription_token` | `string` | 给订阅方客户端（如手机）使用的 ntfy 访问令牌；仅通过 `GET /api/v1/notifications/config` 提供 |
| `min_priority` | `integer` | 发布的最低 ntfy 优先级（1–5）；默认 `1` |
| `events` | `string[]` | 要发布的事件；默认全部 |

```toml
# ~/.kimi-code/config.toml
[notifications]
enabled = true
topic = "a-hard-to-guess-topic"
subscription_token = "ntfy access token for your phone"
```

每个字段都有同名的环境变量覆盖（`KIMI_CODE_NTFY_ENABLED`、`KIMI_CODE_NTFY_URL`、`KIMI_CODE_NTFY_TOPIC`、`KIMI_CODE_NTFY_TOKEN`、`KIMI_CODE_NTFY_SUBSCRIPTION_TOKEN`、`KIMI_CODE_NTFY_MIN_PRIORITY`、`KIMI_CODE_NTFY_EVENTS`）——见 [环境变量](../configuration/env-vars.md)。订阅方客户端从需要鉴权的 `GET /api/v1/notifications/config` 端点读取主题与 `subscription_token`；服务端自己的发布 `token` 既不会出现在该响应里，也不会出现在通用配置响应里。使用公共 ntfy 服务器时，请选一个难以猜中的主题名——任何知道主题名的人都能订阅。发布失败（ntfy 服务器不可达、token 被拒等）只会记录在服务日志里——启动服务时加上 `--log-level info` 才能看到。

## 安全注意

- **建议设置并列凭证**：绑定局域网地址后，额外设置 `KIMI_CODE_PASSWORD` 环境变量，服务端会对鉴权失败自动限流。
- **默认局域网流量可被窃听**：绑定到非本机地址后服务以明文 HTTP 运行——配对交换和之后的全部流量都能被同一网络中的任何人观察到（见[与 Kimi 手机 App 局域网配对](#与-kimi-手机-app-局域网配对)）。
- **不要彻底关闭鉴权**：`--dangerous-bypass-auth` 会关闭所有鉴权，任何能访问该端口的人都能控制你的会话、文件系统和 shell。仅在可信网络或自有鉴权代理之后使用，详见 [kimi 命令参考](../reference/kimi-command.md#kimi-web)。


## 常见问题

### 端口被占用了怎么办

不用处理。`kimi web` 会自动用下一个端口重试（58628、58629……），以启动横幅里实际打印的地址为准。

### 浏览器打不开地址

先确认终端里的服务还在运行（它前台挂在这个终端上）。地址必须完整复制，包含 `#token=` 部分；只输 `http://127.0.0.1:58627` 会停在输入 token 的页面，手动粘贴横幅里的 `Token` 值也可以进入。

### token 失效了怎么恢复

运行 `kimi web rotate-token` 生成新 token，然后用启动横幅里的新地址重新打开。所有运行中的实例会自动换用新 token，无需重启。

### 同一 WiFi 下其他设备访问不到

确认启动时带了 `--host`（裸写即可），并用横幅中局域网地址（形如 `http://192.168.x.x:58627/#token=...`）访问。仍不通时检查电脑防火墙是否放行了该端口，以及两台设备是否真的在同一网段（访客 WiFi、VPN、4G/5G 热点切换都会造成隔离）。

### 手机 App 提示配对码无效

配对码在横幅打印 60 秒后过期，且只能使用一次，所以旧二维码（或同一张码扫第二次）会被拒绝。用 `Reprint:` 触发方式重新打印横幅（macOS 和 Linux 上执行 `kill -USR2 <pid>`，Windows 交互式终端里按 `R`），再扫新的二维码。之前配对成功的手机在服务重启和 `kimi web rotate-token` 之后依然可用——只有 `server/auth/device-tokens.json` 被删除，或该设备经 API 被撤销后，才需要重新配对。

## 下一步

- [服务 API](../reference/server-api.md) — 面向脚本与第三方集成的 REST / WebSocket 接口（实验性）
- [kimi 命令](../reference/kimi-command.md#kimi-web) — `kimi web` 的全部命令行选项
- [远程控制](./remote-control.md) — 从公网任意设备远程查看和接管本机会话
