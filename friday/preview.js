#!/usr/bin/env node
/**
 * preview.js — LOCAL PREVIEW ONLY (never deployed).
 *
 * Serves friday/index.html and fakes the /api/* endpoints with canned
 * Tavily-shaped data so you can try the F.R.I.D.A.Y. HUD without burning
 * credits or deploying anything.
 *
 *   cd friday && node preview.js     →  http://localhost:8080
 *
 * The real thing is worker.js → Cloudflare Workers.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8080;
const HTML = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const tasks = new Map(); // request_id → startedAt

const send = (res, status, body, type = "application/json; charset=utf-8") => {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...CORS });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

const DEMO_RESULTS = [
  { title: "Tavily Docs — Search API", url: "https://docs.tavily.com/documentation/api-reference/endpoint/search",
    content: "Tavily Search executes a real-time web search optimized for AI agents. The include_answer parameter returns an LLM-generated, conversational answer alongside ranked sources.",
    score: 0.98, favicon: "https://docs.tavily.com/favicon.ico", published_date: "2026-09-28" },
  { title: "Tavily Docs — Research API", url: "https://docs.tavily.com/documentation/api-reference/endpoint/research",
    content: "Tavily Research conducts multiple searches, analyzes sources, and generates a cited report. Models: mini (targeted), pro (comprehensive), auto (complexity-based).",
    score: 0.93, favicon: "https://docs.tavily.com/favicon.ico", published_date: "2026-09-28" },
  { title: "Tavily — Credits & Pricing", url: "https://docs.tavily.com/documentation/api-credits",
    content: "Free Researcher plan: 1,000 API credits per month, no credit card required. Basic search costs 1 credit, advanced 2, research starts at 4 (mini) or 15 (pro).",
    score: 0.88, favicon: "https://docs.tavily.com/favicon.ico", published_date: "2026-09-28" },
  { title: "F.R.I.D.A.Y. — Marvel Database", url: "https://marvel.fandom.com/wiki/F.R.I.D.A.Y._(Earth-616)",
    content: "F.R.I.D.A.Y. (Female Replacement Intelligent Digital Assistant Youth) is the AI that succeeded J.A.R.V.I.S. as Tony Stark's assistant, with an Irish-accented voice and dry wit.",
    score: 0.81, favicon: "https://marvel.fandom.com/favicon.ico", published_date: "2026-08-14" },
];

const DEMO_REPORT = (q) => `# Research Report — ${q}

## Executive Summary

This is a **demo report** from the local preview server, boss — generated from canned data so you can see how Tavily's Research models (mini / pro / auto) render inside the HUD.

In production, your Cloudflare Worker forwards this question to Tavily's \`/research\` endpoint [1], which runs a multi-source research sweep: it searches the live web, reads the strongest sources, and synthesises this report with numbered citations [2].

## How the pipeline works

1. Your message goes from this page to **your worker** (\`POST /api/research\`).
2. The worker calls \`https://api.tavily.com/research\` with your \`TAVILY_API\` secret — the key never touches the browser.
3. Tavily's research model (**mini**, **pro**, or **auto**) runs the sweep — typically 30–120 seconds.
4. The page polls \`/api/research/:id\` until the status flips to \`completed\`, then renders the report here.

## Credit costs on the free plan

| Operation | Credits |
| --- | --- |
| Quick scan (search, basic depth) | 1 |
| Deep scan (search, advanced depth) | 2 |
| Research — mini model | 4+ |
| Research — pro model | 15+ |

> With 1,000 free credits a month, that's a lot of questions, sir.

## Sources
[1] Tavily Research API — docs.tavily.com
[2] Tavily Credits & Pricing — docs.tavily.com`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "OPTIONS") return send(res, 204, "");

  if (req.method === "GET" && ["/", "/index.html", "/friday"].includes(url.pathname)) {
    return send(res, 200, HTML, "text/html; charset=utf-8");
  }

  if (url.pathname.startsWith("/api/")) {
    // read body
    let body = "";
    for await (const chunk of req) body += chunk;
    let json = {}; try { json = body ? JSON.parse(body) : {}; } catch {}

    if (url.pathname === "/api/health") return send(res, 200, { ok: true, demo: true });
    if (url.pathname === "/api/usage") {
      return send(res, 200, {
        key: { usage: 58, limit: 1000, search_usage: 46, research_usage: 12 },
        account: { current_plan: "Researcher (demo)", plan_usage: 58, plan_limit: 1000 },
      });
    }
    if (url.pathname === "/api/chat" && req.method === "POST") {
      const q = String(json.message || "").slice(0, 120);
      await new Promise(r => setTimeout(r, 1400 + Math.random() * 900)); // fake latency
      const depth = json.depth === "advanced" ? 2 : 1;
      return send(res, 200, {
        ok: true,
        answer:
          `Demo mode, boss — this preview runs on canned data, so I haven't actually scanned anything.\n\n` +
          `When **worker.js** is deployed with your \`TAVILY_API\` secret, a question like “${q}” gets a live, web-grounded answer here — ` +
          `synthesised by Tavily's search API (\`include_answer: advanced\`, \`${json.depth || "basic"}\` depth, topic: ${json.topic || "general"}) and backed by the source dossiers below.\n\n` +
          `Everything else — boot sequence, voice, scan chatter, credit telemetry — is exactly what ships.`,
        results: DEMO_RESULTS,
        response_time: (1.4 + Math.random()).toFixed(2),
        usage: { credits: depth },
      });
    }
    if (url.pathname === "/api/research" && req.method === "POST") {
      const id = "demo-" + Math.random().toString(36).slice(2, 10);
      tasks.set(id, Date.now());
      return send(res, 200, { request_id: id, status: "in_progress" });
    }
    const m = url.pathname.match(/^\/api\/research\/([A-Za-z0-9-]+)$/);
    if (m && req.method === "GET") {
      const started = tasks.get(m[1]);
      if (!started) return send(res, 404, { detail: { error: "Research task not found" } });
      const elapsed = (Date.now() - started) / 1000;
      if (elapsed < 12) return send(res, 200, { request_id: m[1], status: "in_progress", response_time: elapsed });
      return send(res, 200, {
        request_id: m[1], created_at: new Date(started).toISOString(), status: "completed",
        content: DEMO_REPORT(String(json.input || "your question")),
        sources: DEMO_RESULTS.slice(0, 3),
        response_time: Math.round(elapsed), usage: { credits: 7 },
      });
    }
    return send(res, 404, { error: "not_found" });
  }

  send(res, 404, "404 · demo server", "text/plain");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`F.R.I.D.A.Y. preview (demo data) → http://localhost:${PORT}`);
  console.log("Real deployment: cd friday && npx wrangler deploy   (worker.js)");
});
