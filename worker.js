/* =====================================================================
 * F.R.I.D.A.Y. // UPLINK WORKER
 * ---------------------------------------------------------------------
 * One Groq model, one key, held as a secret so the browser never sees it.
 * It answers /api/* and passes everything else through to your static
 * site assets, so friday2.dzt399890.workers.dev keeps serving the site
 * AND becomes the brain. No code change needed in FRIDAY/index.html:
 * the page already POSTs to <this origin>/api/chat.
 *
 * ── DEPLOY (option A: wrangler, keeps your assets) ───────────────────
 *   npm i -g wrangler
 *   wrangler login
 *   # wrangler.toml in this folder:
 *   #   name = "friday2"
 *   #   main = "worker.js"
 *   #   compatibility_date = "2026-01-01"
 *   #   [assets]
 *   #   directory = "./"
 *   #   binding = "ASSETS"
 *   wrangler secret put GROQ_API_KEY      # paste your gsk_... key
 *   wrangler deploy
 *
 * ── DEPLOY (option B: Cloudflare dashboard, no npm) ──────────────────
 *   1. Workers & Pages → your worker → Code editor → paste this file → Save
 *      (if the worker has Assets, keep "Assets" pointed at the repo so the
 *       site still loads; /api/* is routed here first).
 *   2. Settings → Variables → add a SECRET TEXT variable named GROQ_API_KEY
 *      with your gsk_... key. Secret text = never sent to the browser.
 *   3. Optional variables (Settings → Variables, plain text):
 *        GROQ_MODEL        default "openai/gpt-oss-120b" — the one model
 *        GROQ_MODELS       comma list the worker will serve (keep it to one)
 *        ACCESS_CODE       if set, requests must send x-friday-code
 *        ALLOW_ORIGIN      default "*"; e.g. https://join365.bond to lock it
 *        MAX_TOKENS_CAP    default 8192 — hard ceiling per reply
 *
 * Then open the site, click CORE ▸ LINK → TEST UPLINK. The header chip
 * should read UPLINK LIVE.
 * ===================================================================== */

const GROQ_BASE = "https://api.groq.com/openai/v1";
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const DEFAULT_CAP = 8192;
const MAX_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 40000;

const CORS_HEADERS = {
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-friday-code",
  "access-control-max-age": "86400",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsFor(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === "/api/health") return health(env, cors);
      if (url.pathname === "/api/models") return models(env, cors);
      if (url.pathname === "/api/chat") {
        if (request.method !== "POST") return err(405, cors, "use POST", "/api/chat takes a POST.");
        return chat(request, env, cors);
      }
    } catch (e) {
      return err(500, cors, "worker fault", String((e && e.message) || e));
    }

    // Not an API route: hand it to your static assets so the site keeps working.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    if (url.pathname === "/") {
      return new Response("F.R.I.D.A.Y. uplink is running. POST /api/chat\n", {
        headers: Object.assign({ "content-type": "text/plain; charset=utf-8" }, cors),
      });
    }
    return err(404, cors, "not found", "no asset binding on this worker, so only /api/* is served.");
  },
};

/* ------------------------------- routes ------------------------------- */

function keyOf(env) {
  return String(env.GROQ_API_KEY || env.GROQ_API || "").trim();
}

function allowedModels(env) {
  const list = String(env.GROQ_MODELS || env.GROQ_MODEL || DEFAULT_MODEL)
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return list.length ? list : [DEFAULT_MODEL];
}

function gate(env) {
  return String(env.ACCESS_CODE || "").trim();
}

function health(env, cors) {
  return json(200, cors, {
    ok: true,
    keyConfigured: !!keyOf(env),
    accessCodeRequired: !!gate(env),
    persistentMemory: false,
    model: allowedModels(env)[0],
    models: allowedModels(env),
    time: new Date().toISOString(),
  });
}

function models(env, cors) {
  // The page no longer needs a roster; this stays for curl/debug convenience.
  const list = allowedModels(env);
  return json(200, cors, {
    count: list.length,
    hidden_non_chat: 0,
    note: "this worker only serves the models listed in GROQ_MODELS",
    data: list.map((id) => ({ id: id })),
  });
}

async function chat(request, env, cors) {
  const key = keyOf(env);
  if (!key) {
    return err(500, cors, "no key on this worker",
      "GROQ_API_KEY is not set as a secret",
      "run: wrangler secret put GROQ_API_KEY, or add secret text in the dashboard, then redeploy.");
  }

  const secret = gate(env);
  if (secret) {
    const got = String(request.headers.get("x-friday-code") || "").trim();
    if (got !== secret) return err(401, cors, "access code required",
      "this worker wants header x-friday-code",
      "open the page as FRIDAY/?code=NNNN \u2014 that is all it takes, or clear ACCESS_CODE on the worker");
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return err(400, cors, "body was not JSON", "send Content-Type: application/json with a JSON body.");
  }

  const allowed = allowedModels(env);
  const model = String(body.model || allowed[0]).trim();
  if (allowed.indexOf(model) < 0) {
    return err(400, cors,
      "model `" + model + "` is not permitted here",
      "this uplink serves " + allowed.join(", "),
      "Change FRIDAY's MODEL constant, or add the id to GROQ_MODELS on this worker.");
  }

  const messages = cleanMessages(body.messages);
  if (!messages.length) return err(400, cors, "no messages", "send a messages array with at least one entry.");

  const cap = clamp(int(body.MAX_TOKENS_CAP, env.MAX_TOKENS_CAP) || DEFAULT_CAP, 256, 32768);
  const out = {
    model: model,
    messages: messages,
    stream: !!body.stream,
    max_completion_tokens: clamp(int(body.max_completion_tokens, body.max_tokens) || 1024, 16, cap),
  };
  copyIfPresent(body, out, ["temperature", "top_p", "reasoning_effort", "service_tier"], isNum);
  copyIfPresent(body, out, ["reasoning_format", "stop"]);
  if (body.response_format && typeof body.response_format === "object") {
    out.response_format = body.response_format;
  }

  let upstream;
  try {
    upstream = await fetch(GROQ_BASE + "/chat/completions", {
      method: "POST",
      headers: {
        "authorization": "Bearer " + key,
        "content-type": "application/json",
        "accept": out.stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(out),
      signal: request.signal,
    });
  } catch (e) {
    return err(502, cors, "could not reach Groq", String((e && e.message) || e));
  }

  if (!upstream.ok) {
    const raw = await upstream.text().catch(() => "");
    let message = raw.slice(0, 400);
    try {
      const j = JSON.parse(raw);
      message = (j.error && j.error.message) || message;
    } catch (e) { /* keep raw */ }
    const fix = upstream.status === 401 || upstream.status === 403
      ? "GROQ_API_KEY on this worker is not valid for this model."
      : upstream.status === 429
        ? "Groq rate limit hit. Wait a few seconds, then send again."
        : "";
    return err(upstream.status, cors, "Groq refused the request", message, fix, model);
  }

  if (out.stream) {
    // Pass the token stream straight through, and tell the page which model served it.
    const headers = Object.assign({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-model-used": model,
    }, cors);
    return new Response(upstream.body, { status: 200, headers: headers });
  }

  const j = await upstream.json();
  return json(200, cors, Object.assign({}, j, { model: j.model || model }), model);
}

/* ------------------------------- helpers ------------------------------- */

function cleanMessages(input) {
  if (!Array.isArray(input)) return [];
  const keep = [];
  for (const m of input.slice(-MAX_MESSAGES)) {
    if (!m || typeof m !== "object") continue;
    const role = String(m.role || "");
    if (role !== "system" && role !== "user" && role !== "assistant") continue;
    const content = typeof m.content === "string" ? m.content : "";
    if (!content) continue;
    keep.push({ role: role, content: content.slice(0, MAX_MESSAGE_CHARS) });
  }
  return keep;
}

function copyIfPresent(from, to, keys, test) {
  for (const k of keys) {
    if (!(k in from)) continue;
    const v = from[k];
    if (test && !test(v)) continue;
    to[k] = v;
  }
}

function isNum(v) { return typeof v === "number" && isFinite(v); }
function int(a, b) { const n = Number(a != null ? a : b); return isFinite(n) ? Math.round(n) : null; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function corsFor(request, env) {
  const allow = String(env.ALLOW_ORIGIN || "").trim() || "*";
  const origin = request.headers.get("origin") || "";
  const list = allow.split(/[,\s]+/).filter(Boolean);
  const out = allow === "*" ? (origin || "*") : (list.indexOf(origin) >= 0 ? origin : list[0] || "*");
  return Object.assign({}, CORS_HEADERS, { "access-control-allow-origin": out });
}

function json(status, cors, obj, model) {
  const headers = Object.assign({ "content-type": "application/json; charset=utf-8" }, cors);
  if (model) headers["x-model-used"] = model;
  return new Response(JSON.stringify(obj), { status: status, headers: headers });
}

/* Shape the page expects: one human sentence in message, the remedy in detail.
   Kept single-sourced so the browser never prints the same text twice. */
function err(status, cors, headline, detail, fix, model) {
  const message = detail ? headline + " \u2014 " + detail : headline;
  return json(status, cors, {
    error: {
      type: "friday_worker_error",
      message: message,
      friday: null,
      detail: fix || null,
    },
  }, model);
}
