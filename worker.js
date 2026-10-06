/**
 * Friday · Groq model gateway
 *
 * Cloudflare Worker module. Add these secrets in the Worker dashboard or with
 * Wrangler (the values never go to the browser):
 *
 *   GROQ_API_KEY   required
 *   TAVILY_API     optional (TAVILY_API_KEY is also accepted)
 *   APP_TOKEN      optional; if set, the HTML client must send it
 *   ALLOWED_ORIGIN optional; defaults to *
 *
 * Routes:
 *   GET  /              health/configuration check
 *   GET  /models        live list of chat-capable Groq models
 *   GET  /v1/models     alias for /models
 *   POST /chat          chat completion, with optional Tavily web context
 *   POST /v1/chat/completions  OpenAI-compatible alias
 */

const GROQ_API = "https://api.groq.com/openai/v1";
const TAVILY_API = "https://api.tavily.com/search";
const MAX_BODY_BYTES = 2_000_000;
const MAX_MESSAGES = 60;
const CHAT_MODEL_EXCLUSIONS = /whisper|orpheus|prompt[-_ ]?guard|audio|tts|speech/i;

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/" && request.method === "GET") {
      return json({
        ok: true,
        service: "friday-groq-gateway",
        models: "/models",
        chat: "/chat",
        tavily: Boolean(getTavilyKey(env)),
        auth: Boolean(env.APP_TOKEN),
      }, 200, cors);
    }

    if (path === "/models" || path === "/v1/models") {
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, cors);
      const authError = requireAppToken(request, env, cors);
      if (authError) return authError;
      return listModels(env, cors);
    }

    if (path === "/chat" || path === "/v1/chat/completions") {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);
      const authError = requireAppToken(request, env, cors);
      if (authError) return authError;
      return chat(request, env, ctx, cors);
    }

    return json({ error: "Not found" }, 404, cors);
  },
};

async function listModels(env, cors) {
  if (!env.GROQ_API_KEY) {
    return json({ error: "GROQ_API_KEY is not configured on this Worker." }, 500, cors);
  }

  try {
    const response = await fetch(`${GROQ_API}/models`, {
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    });
    const payload = await readJson(response);
    if (!response.ok) {
      return json({ error: groqError(payload, response.status) }, response.status, cors);
    }

    // Groq's model catalogue is the source of truth. Filter out speech and
    // safety models because they cannot answer a normal chat completion.
    const data = Array.isArray(payload?.data)
      ? payload.data
          .filter((model) => model && typeof model.id === "string")
          .filter((model) => model.active !== false)
          .filter((model) => !CHAT_MODEL_EXCLUSIONS.test(model.id))
          .sort((a, b) => modelSortScore(b) - modelSortScore(a) || a.id.localeCompare(b.id))
      : [];

    return json({ object: "list", data, source: "groq", fetched_at: new Date().toISOString() }, 200, cors);
  } catch (error) {
    return json({ error: `Could not reach Groq: ${error.message}` }, 502, cors);
  }
}

async function chat(request, env, ctx, cors) {
  if (!env.GROQ_API_KEY) {
    return json({ error: "GROQ_API_KEY is not configured on this Worker." }, 500, cors);
  }

  let body;
  try {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_BODY_BYTES) {
      return json({ error: "Request is too large." }, 413, cors);
    }
    body = await request.json();
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400, cors);
  }

  const model = typeof body?.model === "string" ? body.model.trim() : "";
  if (!model || model.length > 200) {
    return json({ error: "A valid Groq model is required." }, 400, cors);
  }

  const messages = normalizeMessages(body?.messages);
  if (!messages.length) {
    return json({ error: "At least one message is required." }, 400, cors);
  }

  let finalMessages = messages;
  let sources = [];
  let searchWarning = "";

  if (body.web_search === true || body.webSearch === true) {
    const query = cleanSearchQuery(body.search_query || body.searchQuery || lastUserMessage(messages));
    if (query) {
      const search = await tavilySearch(query, env);
      sources = search.sources;
      searchWarning = search.warning;
      if (search.context) {
        finalMessages = [
          {
            role: "system",
            content:
              "You have access to the web research below. Use it only when it helps answer the user's request. " +
              "Cite factual claims with the source markers exactly as [1], [2], etc. If the sources are inconclusive, say so.\n\n" +
              search.context,
          },
          ...messages,
        ];
      }
    }
  }

  const requestedMax = Number(body.max_tokens ?? body.max_completion_tokens ?? 2048);
  const maxTokens = Number.isFinite(requestedMax)
    ? Math.max(64, Math.min(Math.floor(requestedMax), 65_536))
    : 2048;
  const requestedTemperature = Number(body.temperature ?? 0.7);
  const temperature = Number.isFinite(requestedTemperature)
    ? Math.max(0, Math.min(requestedTemperature, 2))
    : 0.7;
  const stream = body.stream !== false;

  const groqBody = {
    model,
    messages: finalMessages,
    temperature,
    max_tokens: maxTokens,
    stream,
  };

  // Only forward parameters that are useful and supported by Groq's
  // OpenAI-compatible endpoint. This keeps browser input from becoming a
  // general-purpose proxy for arbitrary upstream requests.
  if (typeof body.top_p === "number") groqBody.top_p = Math.max(0, Math.min(body.top_p, 1));
  if (typeof body.seed === "number" && Number.isInteger(body.seed)) groqBody.seed = body.seed;

  let response;
  try {
    response = await fetch(`${GROQ_API}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(groqBody),
    });
  } catch (error) {
    return json({ error: `Could not reach Groq: ${error.message}` }, 502, cors);
  }

  if (!response.ok) {
    const upstream = await readJson(response);
    return json({ error: groqError(upstream, response.status) }, response.status, cors);
  }

  if (!stream || !response.body || !sources.length && !searchWarning) {
    const headers = new Headers(cors);
    copySafeContentHeaders(response, headers);
    if (sources.length) headers.set("X-Web-Sources", encodeHeaderJson(sources));
    if (searchWarning) headers.set("X-Web-Warning", searchWarning.slice(0, 300));
    return new Response(response.body, { status: response.status, headers });
  }

  // When web research is enabled, send a small metadata SSE event before the
  // upstream stream so the browser can render source links without exposing
  // the Tavily key.
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const metadata = JSON.stringify({ sources, warning: searchWarning || undefined });
  ctx.waitUntil((async () => {
    try {
      await writer.write(encoder.encode(`event: meta\ndata: ${metadata}\n\n`));
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
    } catch (error) {
      try {
        await writer.write(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`));
      } catch { /* stream already closed */ }
    } finally {
      try { await writer.close(); } catch { /* stream already closed */ }
    }
  })());

  const headers = new Headers(cors);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("Connection", "keep-alive");
  return new Response(readable, { status: response.status, headers });
}

async function tavilySearch(query, env) {
  const apiKey = getTavilyKey(env);
  if (!apiKey) {
    return { sources: [], context: "", warning: "Web search is not configured (add TAVILY_API to the Worker)." };
  }

  try {
    const response = await fetch(TAVILY_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query: query.slice(0, 500),
        search_depth: "basic",
        topic: "general",
        max_results: 5,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
    });
    const payload = await readJson(response);
    if (!response.ok) {
      return { sources: [], context: "", warning: `Tavily search failed (${response.status}).` };
    }

    const results = Array.isArray(payload?.results) ? payload.results : [];
    const sources = results.slice(0, 5).map((result, index) => ({
      index: index + 1,
      title: String(result.title || result.url || `Source ${index + 1}`).slice(0, 240),
      url: String(result.url || ""),
      snippet: String(result.content || "").slice(0, 900),
    })).filter((source) => /^https?:\/\//i.test(source.url));

    const context = sources.map((source) => `[${source.index}] ${source.title}\nURL: ${source.url}\n${source.snippet}`).join("\n\n");
    return { sources, context, warning: sources.length ? "" : "No web sources were found." };
  } catch (error) {
    return { sources: [], context: "", warning: `Tavily search unavailable: ${error.message}` };
  }
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => message && ["system", "user", "assistant"].includes(message.role))
    .map((message) => ({
      role: message.role,
      content: typeof message.content === "string" ? message.content.slice(0, 30_000) : "",
    }))
    .filter((message) => message.content.trim())
    .slice(-MAX_MESSAGES);
}

function lastUserMessage(messages) {
  return [...messages].reverse().find((message) => message.role === "user")?.content || "";
}

function cleanSearchQuery(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function getTavilyKey(env) {
  return env.TAVILY_API || env.TAVILY_API_KEY || "";
}

function requireAppToken(request, env, cors) {
  if (!env.APP_TOKEN) return null;
  const supplied = request.headers.get("X-App-Token") || request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!supplied || supplied !== env.APP_TOKEN) {
    return json({ error: "This gateway requires an app token." }, 401, cors);
  }
  return null;
}

function modelSortScore(model) {
  const id = String(model.id || "").toLowerCase();
  let score = 0;
  if (id.includes("gpt-oss")) score += 30;
  if (id.includes("llama")) score += 20;
  if (id.includes("versatile") || id.includes("instruct")) score += 10;
  if (model.active !== false) score += 5;
  return score;
}

function groqError(payload, status) {
  const message = payload?.error?.message || payload?.error || payload?.message;
  return message ? String(message) : `Groq returned HTTP ${status}.`;
}

async function readJson(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { error: text.slice(0, 1000) }; }
}

function encodeHeaderJson(value) {
  // Header-safe base64 for small source lists. Sources are also sent as an SSE
  // metadata event for streamed completions.
  return btoa(unescape(encodeURIComponent(JSON.stringify(value))));
}

function copySafeContentHeaders(from, to) {
  for (const name of ["Content-Type", "Cache-Control", "Content-Encoding"]) {
    const value = from.headers.get(name);
    if (value) to.set(name, value);
  }
}

function corsHeaders(request, env) {
  const configured = env.ALLOWED_ORIGIN || "*";
  const origin = request.headers.get("Origin");
  const allowOrigin = configured === "*" ? "*" : (origin === configured ? origin : configured);
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-App-Token",
    "Access-Control-Expose-Headers": "X-Web-Sources, X-Web-Warning",
    "Vary": "Origin",
  };
}

function json(value, status, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}
