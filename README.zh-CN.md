[English](README.md) | 简体中文

# OpenChamber Live TPS

为工作状态面板增加一个 `Live TPS` 小节：当前会话的实时生成速度，外加上一轮均值和首字延迟。

![工作状态面板里的 Live TPS 小节，在 Turn stats 之上显示 25.1 tok/s](docs/work-status.png)

这里的 `tok/s` 是**字符流每秒除以 1.5**，不是提供商上报的 token 数。详见[口径](#口径)。

## 显示什么

| | |
|---|---|
| `Live TPS` | 本轮进行中的平均速度；模型思考时冻结，工具执行时锁定 |
| `last … (measured)` | 上一轮完成后的平均值——提供商上报了 token 数就是 `measured`，否则是 `estimated` |
| `ttft` | 首字延迟 |
| 曲线 | 最近几轮 |

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

最诚实的来源是各家提供商返回的 `usage` 块，但它来得太晚：要等到消息结束才到，实时值就不可能是实时的。所以这个扩展数的是**字符**，按每个 token 1.5 个字符换算——取常见 1.5–4 区间的下限，因此这个数更接近下界而不是峰值。

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

## 已知边界

- 各家提供商的 `usage` 字段只在映射关系已知时归一化（OpenAI、Anthropic、Gemini、Mistral、OpenRouter）。遇到不认识的 `usage` 结构就当作没有 token，本轮报 `estimated`。
- 一个没有任何可测产出的 step，不贡献时间也不贡献 token——平均值只覆盖真正吐出东西的时段。`reasoning` 的 delta 只在该 step 还没出文本时才算进产出占比。
- 实时值按固定比例换算字符，遇到 token 长度远偏离 1.5 字符的模型，会和最终 `measured` 均值有偏差。提供商完全不上报 token 数时两者反而完全一致。

## License

MIT
