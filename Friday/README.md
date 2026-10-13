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

## Deploy her (2 minutes)

1. Cloudflare dashboard → **Workers & Pages** → `friday6` → **Edit code**.
2. Select everything in the editor, paste **all** of `worker.js`, **Deploy**.
3. Give her something to think with — pick **one** of the three routes below.
4. Reload the page. The pill at the top right turns gold when she's live.

Once deployed, `GET /` on the Worker also serves the interface, so
`https://friday6.dzt399890.workers.dev/` works as a second address for the same page.

---

## The three ways to give her a brain

| Route | What you need | Cost |
| --- | --- | --- |
| **A · Bedrock with a saved key** | a secret on this Worker | your AWS Bedrock usage |
| **B · Workers AI binding** | one binding, no key | Cloudflare's per-request pricing |
| **C · Borrow your Bedrock gateway** | the gateway URL | whatever the gateway already costs |

Default `auto` precedence is **A → B → C → reflexes**. Force one any time with the `RUNTIME`
variable: `bedrock` · `workers-ai` · `upstream` · `offline`.

---

## Option A · Bedrock using a key already saved on this Worker

If you saved the Bedrock key as a secret on the **FRIDAY** Worker, she will find it — no config
needed, because the code asks for it *by name*. The names it checks, in order:

`BEDROCK_API_KEY` · `BEDROCK_KEY` · `AWS_BEDROCK_API_KEY` · `AWS_BEARER_TOKEN_BEDROCK` ·
`BEDROCK_TOKEN` · `BEDROCK_API`

```js
// worker.js — this is the whole "code part"
const key = bedrockKey(env);   // → env.BEDROCK_API_KEY, or whichever alias you saved
```

She calls **Bedrock Runtime's Converse API** — `POST /model/<id>/converse-stream`, with
`/converse` as a non-streaming fallback and reflexes under that — so one request shape covers
Claude, Nova, Llama and the rest, and the page still types instead of sitting blank.

Optional variables, if the defaults don't suit:

| Variable | Default | Notes |
| --- | --- | --- |
| `BEDROCK_REGION` | `us-east-1` | `AWS_REGION` is read too. |
| `BEDROCK_MODEL` | `us.anthropic.claude-sonnet-4-20250514-v1:0` | A model **or inference-profile** id this account can call. |

Check it landed: `GET /api/health` → `"runtime": "bedrock"` and
`"cores": { "bedrock": true, … }`. The page's model menu switches to Bedrock ids automatically.

> **Secrets are per-Worker.** A key saved on a *different* Worker cannot be read from here.
> If your Bedrock key lives on the gateway (Option C), use that instead — she'll borrow its door.

## Option B · Workers AI binding (no key at all)

Workers AI bills your Cloudflare account directly, so there is nothing to store and nothing to
paste anywhere.

**Dashboard:** Workers & Pages → `friday6` → **Settings → Bindings → Add binding → Workers AI**.
Variable name **`AI`** — capitals matter. Save, reload, pill turns gold.
*(On older dashboards: Settings → Functions → "Workers AI binding".)*

**Wrangler:**

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

### "What do I do for the code part of the AI binding?"

**Nothing.** There is no code to add, edit or paste — the binding is configuration only. The name
you type in the dashboard becomes a variable on `env`, and the code already reads it:

```js
if (env.AI) return 'workers-ai';            // picks the core
const upstream = await env.AI.run(model, {  // runs the model
  messages, stream: true, max_tokens, temperature,
});
```

That is why the binding must be called exactly `AI`: if you name it `WORKERS_AI`, `env.AI` is
undefined, she reports `"workers-ai": false` in `/api/health`, and the page keeps saying
**reflex mode**. If the pill stays amber after binding, check the spelling first.

## Option C · Borrow your existing Bedrock gateway

Use this when the Bedrock key sits on the gateway Worker (`aws.join365-website`, the one behind
Laura AI) rather than on FRIDAY's.

| Variable (on FRIDAY's Worker) | Value |
| --- | --- |
| `RUNTIME` | `bedrock` |
| `BEDROCK_GATEWAY` | gateway origin, e.g. `https://aws.join365-website.workers.dev` |
| `UPSTREAM_MODEL` | *optional* — a model id from that gateway's `/api/models` |
| `UPSTREAM_KEY` | *only if* the gateway has its own `WORKER_KEY` secret |

She posts OpenAI-shaped requests to the gateway's `/api/chat`, streaming the way Laura does, and
reports `"runtime": "upstream"` with `"cores": { "bedrock-gateway": true }`. A bare origin is fine —
`/api/chat` is appended for you.

---

## Does this file hold an API key?

**No — it *references* secrets; it never *contains* one.** Source files are public text, and a key
written into one is a published key. Instead the file asks the runtime by name:

| Secret (Worker → Settings → Variables and Secrets) | Purpose |
| --- | --- |
| `BEDROCK_API_KEY` (or an alias above) | Option A |
| `BEDROCK_REGION`, `BEDROCK_MODEL` | optional tuning for Option A |
| `WORKER_KEY` | optional — locks this Worker so requests need `x-api-key` |
| `UPSTREAM_KEY` | optional — only for a gateway that wants its own key |

Cloudflare stores each secret encrypted and injects it into `env` at runtime, so the same file is
safe to paste in public whether or not any keys are configured. `/api/health` reports **which**
secrets are present, never their values:

```json
"keys": { "in this file": "none — by design", "bedrock secret": "BEDROCK_API_KEY (set on the Worker)", … }
```

---

## API

| Route | Purpose |
| --- | --- |
| `GET /` | The console page, or a live status card if it can't reach one. |
| `GET /api/health` | Core in use, secrets present, archive size. |
| `GET /api/models` | Model catalogue for whichever core is wired up. |
| `GET /api/canon[?kind=person&q=snap]` | The archive: protocols, systems, people, events. |
| `GET /api/canon/:id` | One card. |
| `POST /api/chat` | SSE chat: `{"d":"chunk"}` … `{"done":true,"meta":{…}}`. |
| `POST /api/protocol` | `{"id":"barn-door"}` → her readout. |

## What she knows

- **Protocols** (19 on the board): House Party, Clean Slate, Barn Door, Baby Monitor, Training
  Wheels, Theta, Full Eclipse, Silhouette, Odyssey, Protocol ASTA06, Contingency Plan Foxhole,
  Protocol 42, Sunset, Taskmaster, Do Not Disturb, Project Monolith, Mighty Avenger — plus sealed
  files (Project Insight, the Red Room) she reads and refuses to run.
- **Systems**: J.A.R.V.I.S., the Vision, Ultron, Karen, E.D.I.T.H., Veronica, the Iron Legion, the
  Nano Gauntlet, the Time-Space GPS, Rescue, B.A.R.F., the Darkhold, the Infinity Stones.
- **People and events**: the Snap, the Blip, the Time Heist, the Battle of Earth, Sokovia, Tony's
  death, Morgan, Pepper, Peter, Rhodey, Fury, Shuri and the rest — 62 cards, retrieved per request.

## Voice

Both directions run in the browser. Speech-in uses the Web Speech API (Chrome or Edge); speech-out
prefers an **en-IE** voice — Kerry Condon's accent is the point — then en-GB, then any English
voice. Toggle with **voice** in the header or in Settings.

## If she isn't answering

The page probes `GET /api/health` on every load and classifies whatever comes back:

| What the endpoint returns | What the page shows |
| --- | --- |
| Her JSON (`"system":"F.R.I.D.A.Y."`) | **core online** (gold) or **reflex mode** (amber) |
| `Hello World!` or any HTML | **endpoint is not her yet** — a **wake her up** button appears with the deploy steps |
| A 404 / unexpected error | **endpoint answered oddly**, with the status in the readout |
| Nothing at all | **uplink lost · local reflexes** — she answers from the console itself |

Model errors surface in the transcript rather than going quiet — including which knob to turn
(`BEDROCK_MODEL`, the region, or the key value). When she can't reason at all, she still talks:
protocols, archive, manners, no fresh thinking — with an honest line about what's switched off.
