# F.R.I.D.A.Y. · Stark AI Interface

Talk to **F.R.I.D.A.Y.** — Tony Stark's suit AI — with every Stark AI as a
switchable persona, full Marvel lore knowledge, and Groq-speed responses.

- `index.html` — the HUD chat app (chat, voice, personas, lore, easter eggs)
- `worker.js` — Cloudflare Worker relay (keeps your `GROQ_API` key server-side)
- `wrangler.toml` — deploy config (worker name: `friday4`)

## Personas

| Persona | Voice |
|---|---|
| F.R.I.D.A.Y. (default — calls you **Boss**) | J.A.R.V.I.S. (**Sir**) |
| KAREN (**Peter**) | E.D.I.T.H. |
| VERONICA (Hulkbuster telemetry) | VISION |
| ULTRON (classified, contained) | |

The Worker serves these at `GET /api/personas` (system prompts included);
the page bundles a fallback copy for offline use.

## Deploy the Worker

```bash
cd FRIDAY
npx wrangler login
npx wrangler secret put GROQ_API    # paste your gsk_... key
npx wrangler deploy                 # → https://friday4.<you>.workers.dev
```

Then open `index.html` → **Settings** → set **Worker URL** to your
`*.workers.dev` address. Default is `https://friday4.dzt399890.workers.dev`.

> No key handy? The page still renders with its bundled model + persona
> lists; sending needs the Worker. You can also paste a fallback `gsk_…`
> key in Settings (stored only in your browser, sent as `x-api-key`).

## Worker endpoints

| Route | What |
|---|---|
| `GET /` | service info |
| `GET /api/health` | `{ ok, hasKey, time }` |
| `GET /api/models` | enriched Groq catalog (live-merged when keyed) |
| `GET /api/personas` | Stark AI personas + system prompts |
| `GET /api/lore?q=` | Marvel lore lookup |
| `POST /api/chat` | OpenAI-compatible chat proxy, streams SSE, auto-fallback across models |
| `POST /api/tts` | Orpheus TTS proxy → audio |
| `POST /api/transcribe` | Whisper STT proxy → `{ text }` |

`/api/chat` injects the persona system prompt server-side when the caller
sent no `system` message of its own, and sets `x-model-used` (+ `x-fallback`
when it had to switch models).

## Suit commands (in the chat box)

`/help` · `/persona <name>` · `/suit` · `/lore <query>` ·
`/protocols` · `/assemble` · `/snap`
