[English](README.md) | 简体中文

# OpenChamber Live TPS

为工作状态面板增加一个 `Live TPS` 小节：当前会话的实时生成速度，外加上一轮均值和首字延迟。

![工作状态面板里的 Live TPS 小节，在 Turn stats 之上显示 25.1 tok/s](docs/work-status.png)

这里的 `tok/s` 是按字符流用启发式估算的——**没有分词器**。详见[口径](#口径)。

## 显示什么

| | |
|---|---|
| `Live TPS` | 本轮进行中的平均速度；模型思考时冻结，工具执行时锁定 |
| `last … (measured)` | 上一轮完成后的平均值——提供商上报了 token 数就是 `measured`，否则是 `estimated` |
| `ttft` | 首字延迟 |
| 曲线 | 最近 30 秒的生成速率，每 1.25 秒一个点 |

## 依赖

- OpenChamber ≥ 2.0.4
- OpenCode v1.2.19+
- `PATH` 里有 Node.js v22+

## 安装

下面统一用 `~/.config/openchamber/extensions/live-tps`，放哪儿都行。

```bash
mkdir -p ~/.config/openchamber/extensions
cd ~/.config/openchamber/extensions
git clone https://gitee.com/pzwzx/openchamber-live-tps.git live-tps
cd live-tps
bun install
bun run build
```

然后启动 OpenChamber，在 **设置 → 扩展** 里允许一次本地服务——每个界面（桌面、浏览器、手机）各问一次，service 重启后再问也正常。

GitHub 快的话用 `https://github.com/wwwzzzxxx/openchamber-live-tps.git`。

## 验证

随便打开一个对话，打开工作状态面板（`Choose sections`），把 `Live TPS` 摆到想要的位置。等模型开始生成，就能看到实时数字。

```bash
npm test   # 70 项断言，约 12 秒
```

## 口径

这里**没有分词器**。真分词器得把各模型家族的词表塞进一个必须在沙箱 guest 里加载的包，而且也帮不上忙——实时值必须在 token 生成出来之前就存在。最诚实的来源是各家提供商返回的 `usage` 块，但它要等消息结束才到，来不及做实时。

所以估算直接用 [`opencode-tps-meter`](https://github.com/ChiR24/opencode-tps-meter) 的启发式，原样搬到 `shared/tokens.ts`：**`Math.ceil(字符数 / 4)`**，通用文本的经验值（按那个项目自己的测算约 75% 准）。它还带 `字符/3`（代码）和 `词数/0.75`（英文散文）两套备选。

`last` 优先用真数：提供商上报了 token 数就覆盖估算值，标 `measured`；启发式只是兜底，标 `estimated`。

实时值还叠加了那个项目 v2 的 **calibrated live rate**：每个完成的 step 拿提供商上报的真 token 数和启发式对一次，把「按模型学习」的修正系数朝真值推（指数平均，夹在 0.25–4 倍）。偏离 `字符/4` 的模型一两轮内就收敛到自己的比例，系数和轮次历史一起落盘，重启后接着之前学到的走。

数的是哪些字符有讲究。事件流里有 `text`、`reasoning` 和工具调用 JSON：

- **文本和推理字符计入。** 它们是模型真实产出，速度指标就该覆盖它们。
- **工具调用 JSON 不计。** 它的大小反映的是参数 schema，不是生成工作量——一个 `input` 很大的工具调用能压过整段回复。每一步里，每个工具部分超出开头 200 字符的内容都被排除。

`ttft` 直接从事件时间戳测出来，是精确值。`last` 优先用提供商上报的 token 数（显示为 `measured`），拿不到才退回字符估算（`estimated`）。

## 架构

只有一个本地 service 持有全部测量状态，面板和工作状态小节都只是它的视图。

```
        全局事件流
OpenChamber server ─────────────▶ service/  （跑在 host 里，持有全部状态）
        │
        │ 托管 + 代理
        ├────────────▶ panel/    （浮动面板，轮询 /rate）
        └────────────▶ status/   （工作状态小节，轮询 /rate）
```

- **`service/`** —— 唯一有状态的地方。读 OpenChamber 的全局事件流，算实时/上轮/首字和曲线，对外提供 `/rate` 和 `/watch`。按 session id 维护一份 per-session 状态表，并把已完成轮次的历史写到磁盘，于是数字能扛住 OpenChamber 重启，两个界面看不同会话时也不会互相抢同一个测量窗口。
- **`panel/`** —— 浮动面板。轮询 `/rate`，负责画。
- **`status/`** —— 工作状态面板里的 `Live TPS` 小节。

两个界面都会自愈：service 重启后，它们发现 `/rate` 里 `sessionId: null` 就会重新 `/watch`，让 host 把 service 拉回来。

service 还会自己探测父进程的回环端口去找 `/api/global/event`，所以 SSH 隧道连到远程 OpenChamber 也能测出真实速度，而不是 `unreachable`。

### UI 密码下怎么读事件流

SDK 刻意不让 service 继承 host 环境——「API key、UI 密码和其他 host 密钥永远不会到 service 手里」——所以 service 没有任何能带凭证访问 server API 的通道。用户没设 UI 密码时 `/api/global/event` 是开放的；一旦设了，所有 `/api/*` 都回 401，这个扩展就瞎了。

所以 service 会从 `$OPENCHAMBER_DATA_DIR/settings.json`（默认 `~/.config/openchamber`）里读 `desktopLocalClientToken`，以 `Authorization: Bearer ...` 发出去——这正是 OpenChamber CLI 自己做本机 API 调用时的鉴权方式。它只是一个回环凭证，只对本机的 OpenChamber 有意义；无界面安装没有这个字段，而那种环境本来也不要求鉴权。也可以用 `OPENCHAMBER_LIVE_TPS_CLIENT_TOKEN` 显式指定。

## 已知边界

- 各家提供商的 `usage` 字段只在映射关系已知时归一化（OpenAI、Anthropic、Gemini、Mistral、OpenRouter）。遇到不认识的 `usage` 结构就当作没有 token，本轮报 `estimated`。
- 一个没有任何可测产出的 step，不贡献时间也不贡献 token——平均值只覆盖真正吐出东西的时段。`reasoning` 的 delta 只在该 step 还没出文本时才算进产出占比。
- 实时值是 `字符/4` 启发式再乘一个「按模型学习」的修正系数，所以没见过的模型头一两轮可能和最终 `measured` 均值有偏差。完全不上报 token 数的提供商会一直用原始启发式，标 `estimated`。

## License

MIT
