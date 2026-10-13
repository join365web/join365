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
