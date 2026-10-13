# F.R.I.D.A.Y. — Female Replacement Intelligent Digital Assistant Youth

The Stark Industries natural-language interface, as a Join365 page: gold HUD, Irish accent,
full protocol registry, and an archive of everything she lived through.

```
Friday/
├── index.html   ← the console (open it directly, or serve it from the Worker)
├── worker.js    ← her inference core + archive + protocol registry (Cloudflare Worker)
└── README.md    ← you are here
```

Page: <https://join365.eu.cc/Friday/> · Worker: <https://friday6.dzt399890.workers.dev>

## Deploying the Worker (2 minutes)

1. Cloudflare dashboard → **Workers & Pages** → `friday6` → **Edit code**.
2. Select everything in the editor, paste **all** of `worker.js`, **Deploy**.
3. **Settings → Functions → Workers AI → Add binding** — variable name **`AI`**.
   That one binding is the difference between a thinking FRIDAY and a reflex-mode FRIDAY.
   (Without it she still answers, from her own archive — she just can't improvise.)
4. Reload the page. The pill at the top right should read **core online · workers-ai**.

Once the binding is in, `GET /` on the Worker also serves the interface, so
`https://friday6.dzt399890.workers.dev/` works as a second address for the same page.

### Optional variables / secrets

| Name | What it does |
| --- | --- |
| `WORKER_KEY` | If set, requests must send `x-api-key: <key>`. The page has a field for it in Settings. |
| `RUNTIME` | Force a core: `auto` (default) · `workers-ai` · `upstream` · `offline`. |
| `MODEL` | Pin a model id, e.g. `@cf/meta/llama-4-scout-17b-16e-instruct`. |
| `UPSTREAM_URL` | Any OpenAI-compatible `/chat/completions` endpoint, if you'd rather not use Workers AI. |
| `UPSTREAM_KEY` | Bearer token for that endpoint. |
| `UPSTREAM_MODEL` | Model name for that endpoint. |
| `ALLOWED_ORIGINS` | Comma list of origins allowed to call `/api/*`. Default `*`. |
| `PAGE_URL` | Where `GET /` pulls the console from. Default `https://join365.eu.cc/Friday/`. |

## API

| Route | Purpose |
| --- | --- |
| `GET /` | Serves the console page. |
| `GET /api/health` | Which core is online, model list, archive size. |
| `GET /api/models` | Model catalogue for this deployment. |
| `GET /api/canon[?kind=person&q=snap]` | The archive: protocols, systems, people, events. |
| `GET /api/canon/:id` | One card. |
| `POST /api/chat` | SSE chat: `{"d":"chunk"}` … `{"done":true,"meta":{…}}`. |
| `POST /api/protocol` | `{"id":"barn-door"}` → the deterministic readout she reads aloud. |

## What she knows

- **Protocols** (19 files on the board): House Party, Clean Slate, Barn Door, Baby Monitor,
  Training Wheels, Theta, Full Eclipse, Silhouette, Odyssey, Protocol ASTA06, Contingency Plan
  Foxhole, Protocol 42, Sunset, Taskmaster, Do Not Disturb, Project Monolith, Mighty Avenger —
  plus the sealed ones (Project Insight, the Red Room) that she will read to you and refuse to run.
- **Systems**: J.A.R.V.I.S., the Vision, Ultron, Karen, E.D.I.T.H., Veronica, the Iron Legion, the
  Nano Gauntlet, the Time-Space GPS, Rescue, B.A.R.F., the Darkhold, the Infinity Stones.
- **People and events**: the Snap, the Blip, the Time Heist, the Battle of Earth, the Battle of
  Sokovia, Tony's death, Morgan, Pepper, Peter, Rhodey, Fury, Shuri and the rest.

Retrieval is done in the Worker: the relevant cards are pulled and handed to the model as
files, alongside a persona sheet that keeps her in voice, honest about what she can't do,
and straight with anyone in real distress. Sealed protocols stay sealed in every mode.

## Voice

Both directions run in the browser. Speech-in uses the Web Speech API (Chrome or Edge);
speech-out prefers an **en-IE** voice — Kerry Condon's accent is the point — and falls back
to en-GB, then any English voice. Toggle it with **voice** in the header or in Settings.

## Adding the Workers AI binding

Workers AI is what makes her *think* rather than *remember*. There is no API key involved —
Cloudflare bills your account directly, so there is nothing secret to paste anywhere.

**Dashboard (the usual route)**

1. <https://dash.cloudflare.com> → **Workers & Pages**.
2. Pick your Worker (`friday6`).
3. **Settings** → **Bindings** → **Add binding** → **Workers AI**.
   *(On older dashboards this lives under Settings → Functions → "Workers AI binding".)*
4. **Variable name: `AI`** — capital A, capital I. The code reads `env.AI`, so the name matters.
5. Save / **Deploy**, then reload the page. The pill should read **core online · workers-ai**.

**Wrangler (if you deploy from the CLI)**

```toml
# wrangler.toml
name = "friday6"
main = "Friday/worker.js"

[ai]
binding = "AI"
```

```bash
npx wrangler deploy
```

Check it worked: `GET /api/health` → `"runtime": "workers-ai"` and `"cores": { "workers-ai": true, … }`.

Using a model costs money per request past the daily free allowance. If you would rather not use
Workers AI at all, see the Bedrock option below.

## Does this file hold an API key?

**No — and that is deliberate.** Nothing in `worker.js` or `index.html` contains an AWS, Bedrock,
OpenAI or Cloudflare key. There is no `BEDROCK_API_KEY` here to leak.

Source files are public text. A key written into one is a key you have published, and Cloudflare
serves it to anyone who asks for it. So the design is:

| Secret | Where it goes |
| --- | --- |
| **Workers AI** | Nowhere. The `AI` binding bills your account — there is nothing to store. |
| **`WORKER_KEY`** (locks this Worker down) | Worker → Settings → **Variables and Secrets** → add as a *Secret*. Or `npx wrangler secret put WORKER_KEY`. |
| **`UPSTREAM_KEY`** (a model gateway) | Same place, as a secret. She sends it as both `Authorization: Bearer` and `x-api-key`, so it suits either gateway style. |

Cloudflare stores secrets encrypted and injects them at runtime as `env.SOMETHING`. This file only
ever reads `env.*`, which is why it is safe to paste into a public dashboard.

`GET /api/health` reports *which* secrets are present, never their values:

```json
"keys": { "in this file": "none — by design", "WORKER_KEY": "not set", "UPSTREAM_KEY": "not set" }
```

## Option B · Run her on your Amazon Bedrock gateway

You already have one: the Worker behind **Laura AI** (`aws.join365-website.workers.dev`), whose
AWS Bedrock keys live in *its* secrets. FRIDAY can borrow that door instead of using Workers AI —
no `AI` binding needed, and still no key in any file.

Set these on the **FRIDAY** Worker (Settings → Variables and Secrets):

| Variable | Value |
| --- | --- |
| `RUNTIME` | `bedrock` |
| `UPSTREAM_MODEL` | *optional* — a Bedrock model id from the gateway's `/api/models`, e.g. `us.anthropic.claude-sonnet-5-5` |
| `UPSTREAM_KEY` | *only if* the gateway has a `WORKER_KEY` secret of its own |

She then posts OpenAI-shaped requests to the gateway's `/api/chat`, streaming the same way Laura
does, and reports `"runtime": "upstream"` with `"cores": { "bedrock-gateway": true }` in health.
A bare origin is fine — `/api/chat` is appended for you. If the gateway throttles, her page shows
the reason rather than stopping quietly.

## If she isn't answering

The page probes `GET /api/health` on every load and classifies whatever comes back, so it
can tell you exactly what is at that URL instead of failing quietly:

| What the endpoint returns | What the page shows |
| --- | --- |
| Her JSON (`"system":"F.R.I.D.A.Y."`) | **core online** (gold) or **reflex mode** (amber), and she thinks or remembers accordingly |
| `Hello World!` or any HTML | **endpoint is not her yet** — still the Worker template. A **wake her up** button appears in the header with the two deploy steps |
| A 404 or an unexpected error | **endpoint answered oddly**, with the status in the readout |
| Nothing at all | **uplink lost · local reflexes** — she answers from the console itself: protocol board, archive, manners, no fresh thinking |

`GET /` on the Worker serves the same kind of status card when it can't reach the console
page (or with `?raw=card`), so visiting the bare Worker URL tells you what is switched on
and what to paste.

## Offline behaviour

If the Worker can't be reached, the page drops to local reflexes rather than going blank:
her protocol board, a short in-character reply, and a note about which piece is missing.
When the Worker is reachable but no model is bound, the Worker itself answers from its
archive — in voice, with an honest line about what's switched off.
