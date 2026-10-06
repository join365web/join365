# F.R.I.D.A.Y. — Iron Man HUD chat, powered by Tavily

*Female Replacement Intelligent Digital Assistant Youth.* One HTML file —
no server, no build step, no deploy. FRIDAY's personality (Irish sass,
"boss", dry wit, boot sequence, voice) runs in the page; her knowledge
comes from the **Tavily** Search & Research APIs.

## Quick start (no worker, no deploy)

1. Open **`friday/index.html`** — double-click it, or host it anywhere
   (this repo → `join365.eu.cc/friday/` works too).
2. On first boot the ⚙ settings panel opens — paste your Tavily key
   (`tvly-…`, free at <https://app.tavily.com>) → **Save & Reconnect**.
   Or tick **KEYLESS** for free rate-limited scans with no key at all.
3. Chat with FRIDAY.

### Three ways to connect (⚙ in the header)

| Mode | What happens | Key lives |
|---|---|---|
| **DIRECT** (default) | The page calls `api.tavily.com` itself | Browser localStorage |
| **KEYLESS** | `X-Tavily-Access-Mode: keyless` — free, rate-limited, Search only | No key needed |
| **WORKER** | Routes through your Cloudflare Worker (`friday/worker.js`) | Server-side secret |

If the page is *served by* the worker, WORKER mode is picked automatically.
If the browser blocks direct calls (CORS), FRIDAY tells you and points you
at the worker route.

## The Tavily models (free plan)

Tavily doesn't host a chat LLM — its "models" are search depths and
research models, all on the free **Researcher** plan (1,000 credits/month):

| Mode in the HUD | Tavily call | Credits |
|---|---|---|
| **QUICK SCAN** | `POST /search` · `search_depth: basic` · `include_answer: advanced` | 1 |
| **DEEP SCAN** | `POST /search` · `search_depth: advanced` | 2 |
| **RESEARCH · MINI** | `POST /research` · `model: mini` (targeted report, ~30s) | 4+ |
| **RESEARCH · PRO** | `POST /research` · `model: pro` (full report, 1–2 min) | 15+ |
| **RESEARCH · AUTO** | `POST /research` · `model: auto` (Tavily picks) | varies |

Topics **GENERAL / NEWS / FINANCE** map to the search `topic` parameter.
Small talk, jokes, easter eggs, math and `status` are answered locally and
cost **0 credits**. The header chip and systems panel track remaining
credits live via `GET /usage`. Research needs a real key (not keyless).

## Optional: the worker (key stays server-side)

`worker.js` is the same HUD plus an API proxy — use it if you'd rather not
put your key in the browser:

- **Dashboard:** your `friday` worker → Edit code → paste all of
  `worker.js` → Deploy. Your existing `TAVILY_API` secret survives
  redeploys, and the page it serves automatically routes through it.
- **CLI:** `cd friday && npx wrangler deploy`

Set the secret once if needed: `npx wrangler secret put TAVILY_API`
(value `tvly-…`), or Dashboard → worker → Settings → Variables & Secrets.

The worker API (also handy for your own projects): `GET /api/health`,
`POST /api/chat`, `POST /api/research`, `GET /api/research/:id`,
`GET /api/usage` — CORS-enabled, rate-limited 40/min per IP.

## Files

| File | What it is |
|---|---|
| `index.html` | **The whole app** — standalone HUD, direct/keyless/worker modes. |
| `worker.js` | Optional Cloudflare Worker: same HUD + secret-keeping proxy. |
| `embed.js` | Re-syncs `index.html` into `worker.js` after UI edits: `node embed.js` |
| `wrangler.toml` | Wrangler config for the optional worker (`name = "friday"`). |
| `preview.js` | **Local preview only** — serves the HUD with fake Tavily data. |

## Personality

Tavily returns facts — FRIDAY supplies the attitude:

- **Boot sequence** — reactor spin-up, J.A.R.V.I.S. preference import,
  sarcasm-module calibration, uplink check (missing / rejected key detected).
- **Voice** — `speechSynthesis`, preferring an Irish (`en-IE`) voice; 🔊 toggle.
  Mic input too (where the browser allows it).
- **Chatter** — acks ("Right away, boss."), scan chatter, research progress,
  HUD blips (♪ toggle).
- **Easter eggs** — *"activate the house party protocol"*, *"who are you"*,
  *"tell me a joke"*, *"suit status"*, *"roll a dice"*…
- **Commands** — `status` (systems + credit report), `help`, `clear`.
- **Memory** — the session transcript persists in localStorage.

## Developing

```bash
node preview.js      # local HUD with fake Tavily data → localhost:8080
# edit index.html, then re-embed it into the worker:
node embed.js        # then npx wrangler deploy (or re-paste into Dashboard)
```
