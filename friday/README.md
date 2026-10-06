# F.R.I.D.A.Y. — Stark Industries assistant on Cloudflare Workers

*Female Replacement Intelligent Digital Assistant Youth.* An Iron Man–style
HUD chat that talks to the live web through **Tavily**, deployed on your
existing worker (`friday.dzt399890.workers.dev`) with your **`TAVILY_API`**
secret. FRIDAY's personality (Irish sass, "boss", dry wit, boot sequence,
voice) runs in the page; her knowledge comes from Tavily.

## Files

| File | What it is |
|---|---|
| `worker.js` | **The deployable worker** — serves the HUD and proxies Tavily. Single self-contained file. |
| `index.html` | The HUD itself (same UI that's embedded inside `worker.js`). Standalone-hostable. |
| `embed.js` | Re-syncs `index.html` into `worker.js` after you edit the UI: `node embed.js` |
| `wrangler.toml` | Wrangler config (`name = "friday"`, matches your existing worker). |
| `preview.js` | **Local preview only** — serves the HUD with fake Tavily data. Never deployed. |

## Deploy (2 minutes)

**Option A — Cloudflare Dashboard (no tools needed):**
1. Dashboard → Workers & Pages → your **friday** worker → **Edit code**.
2. Delete what's there, paste **all of `worker.js`**, hit **Deploy**.
3. Your `TAVILY_API` secret survives redeploys — done. Open
   `https://friday.dzt399890.workers.dev/`.

**Option B — Wrangler CLI:**
```bash
cd friday
npx wrangler deploy          # updates the existing "friday" worker
```

**If the secret isn't set yet** (one time only):
```bash
npx wrangler secret put TAVILY_API     # paste your tvly-... key
```
or Dashboard → worker → Settings → Variables & Secrets → Add →
Type: **Secret**, Name: `TAVILY_API`, Value: `tvly-…` → redeploy.
Get a free key at <https://app.tavily.com> (1,000 credits/month, no card).

## The Tavily models (free plan)

Tavily doesn't host a chat LLM — its "models" are search depths and research
models, all available on the free **Researcher** plan. FRIDAY wires them up:

| Mode in the HUD | Tavily call | Credits |
|---|---|---|
| **QUICK SCAN** | `POST /search` · `search_depth: basic` · `include_answer: advanced` | 1 |
| **DEEP SCAN** | `POST /search` · `search_depth: advanced` | 2 |
| **RESEARCH · MINI** | `POST /research` · `model: mini` (targeted report, ~30s) | 4+ |
| **RESEARCH · PRO** | `POST /research` · `model: pro` (full report, 1–2 min) | 15+ |
| **RESEARCH · AUTO** | `POST /research` · `model: auto` (Tavily picks) | varies |

Topics **GENERAL / NEWS / FINANCE** map to the search `topic` parameter.
Small talk, jokes, easter eggs, math and `status` are answered locally and
cost **0 credits**. The header chip and systems panel track your remaining
credits live via `GET /usage`.

## How the personality works

Tavily returns facts — FRIDAY supplies the attitude. The UI layer adds:

- **Boot sequence** — reactor spin-up, J.A.R.V.I.S. preference import,
  sarcasm-module calibration, uplink check (detects missing/rejected key).
- **Voice** — `speechSynthesis`, preferring an Irish (`en-IE`) voice.
  Toggle 🔊 in the header. Mic input too (where the browser allows it).
- **Chatter** — acks ("Right away, boss."), scan chatter, research
  progress updates, HUD blips (♪ toggle).
- **Easter eggs** — try *"activate the house party protocol"*, *"who are
  you"*, *"tell me a joke"*, *"suit status"*, *"roll a dice"*…
- **Commands** — `status` (systems + credit report), `help`, `clear`.

## Hosting the HTML separately (optional)

`index.html` is standalone: open it locally or host it anywhere (e.g. this
repo → `join365.eu.cc/friday/`) and it calls the worker cross-origin —
CORS is enabled on the API. Point it at a different worker by editing
`WORKER_URL` at the top of its script.

## Developing

```bash
node preview.js      # local HUD with fake Tavily data → localhost:8080
# edit index.html, then re-embed into the worker:
node embed.js        # then npx wrangler deploy (or re-paste into Dashboard)
```

## API the worker exposes

| Endpoint | Purpose |
|---|---|
| `GET /` | The HUD |
| `GET /api/health` | Is the secret set & key valid? |
| `POST /api/chat` | `{message, depth, topic}` → answer + sources + usage |
| `POST /api/research` | `{input, model}` → `{request_id, status}` |
| `GET /api/research/:id` | Poll → `{status, content, sources, usage}` |
| `GET /api/usage` | Credit usage / plan |

The API is unauthenticated but rate-limited (40 calls/min per IP, best
effort) — anyone with the URL could burn your free credits, so keep the
worker URL to yourself if that matters.
