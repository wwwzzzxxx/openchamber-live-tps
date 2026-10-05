English | [简体中文](README.zh-CN.md)

# OpenChamber Live TPS

A `Live TPS` section for the Work Status panel: live generation speed for the open
session, plus the last turn's average and time to first token.

![The Work Status panel with the Live TPS section showing 25.1 tok/s above Turn stats](docs/work-status.png)

`tok/s` here is estimated from streamed characters with a heuristic — there is
no tokenizer. See [Counting](#counting).

## What it shows

| | |
|---|---|
| `Live TPS` | the running turn's average speed, frozen while the model thinks and locked while a tool runs |
| `last … (measured)` | the finished turn's average — `measured` when the provider reported token counts, `estimated` otherwise |
| `ttft` | time to first token |
| Sparkline | recent turns |

## Requirements

- OpenChamber ≥ 2.0.4
- OpenCode v1.2.19+
- Node.js v22+ on `PATH`

## Install

`~/.config/openchamber/extensions/live-tps` is used throughout; any directory works.

```bash
mkdir -p ~/.config/openchamber/extensions
cd ~/.config/openchamber/extensions
git clone https://github.com/wwwzzzxxx/openchamber-live-tps.git live-tps
cd live-tps
bun install
bun run build
```

Then start OpenChamber and approve the local service once in **Settings →
Extensions** — every surface (desktop, browser, mobile) asks separately, and
asking again after the service restarts is normal.

A Gitee mirror is at `https://gitee.com/pzwzx/openchamber-live-tps` if GitHub is
slow.

## Verify

Open any session, then open the Work Status panel (`Choose sections`) and place
`Live TPS` where you want it. Once the model generates, you should see the
running number above.

```bash
npm test   # 70 assertions, ~12s
```

## Counting

No tokenizer runs here. A real one would ship a vocabulary per model family into
a bundle that has to load inside a sandboxed guest — and it would not help
anyway, because the live number has to exist before the tokens do. The honest
source would be the `usage` block each provider returns, but that arrives with
the message end, too late to be live.

So the estimate is the heuristic from
[`opencode-tps-meter`](https://github.com/ChiR24/opencode-tps-meter), ported
verbatim into `shared/tokens.ts`: **`Math.ceil(characters / 4)`**, the figure
for general text (that project measures it at ~75% accurate). It also ships
`chars/3` for code and `words/0.75` for English prose, should the default ever
prove wrong for some model.

`last` prefers the real thing: provider-reported token counts replace the
estimate when they arrive, and the value is then labelled `measured`. The
heuristic is only the fallback, labelled `estimated`.

It matters what those characters are. The stream carries `text` parts, `reasoning`
parts, and tool-call JSON:

- **Text and reasoning characters count.** They are real model output, and they
  are what a speed number should cover.
- **Tool-call JSON does not.** Its size reflects an argument schema, not
  generation work — one tool with a large `input` can outweigh the entire reply.
  Per step, anything past the first 200 characters of each tool part is excluded.

`ttft` is measured directly from event timestamps, and is exact. For `last`,
provider-reported token counts are preferred when they arrive (these will show as
`measured`), falling back to the character estimate above (`estimated`).

## Architecture

One local service owns all measurement state; the panel and the Work Status
section are thin views of it.

```
        global event stream
OpenChamber server ─────────────▶ service/  (runs in the host, owns all state)
        │
        │ hosts and proxies
        ├────────────▶ panel/    (floating panel, polls /rate)
        └────────────▶ status/   (Work Status section, polls /rate)
```

- **`service/`** — the only place with state. Reads OpenChamber's global event
  stream, computes live/last-turn/TTFT and the sparkline curve, serves `/rate`
  and `/watch`. Keeps a per-session state map keyed by session id and persists
  the finished-turn history to disk, so the numbers survive an OpenChamber
  restart and two surfaces on different sessions stop fighting over one
  measurement.
- **`panel/`** — the floating panel. Polls `/rate`, draws everything.
- **`status/`** — the `Live TPS` section in the Work Status panel.

Both guests self-heal: if the service was restarted they notice `sessionId: null`
in a `/rate` answer and re-assert `/watch`, which lets the host bring the service
back.

The service also discovers its own event-stream origin by probing the parent
process's loopback ports for `/api/global/event`, so an SSH tunnel to a remote
OpenChamber reports real numbers instead of `unreachable`.

## Limitations

- Per-provider `usage` fields are normalised where the mapping is known (OpenAI,
  Anthropic, Gemini, Mistral, OpenRouter). An unknown `usage` shape counts as no
  tokens and the turn reports `estimated`.
- A step that produced no measurable output contributes no time and no tokens —
  the average only covers spans where something was actually produced. A
  `reasoning` delta is only a share of output while the step has produced no text.
- The live number is the `chars/4` heuristic, so it can sit away from the final
  `measured` average — roughly a quarter off, by the source project's own
  measurement. A provider that never reports token counts stays on the estimate,
  labelled `estimated`.

## License

MIT
