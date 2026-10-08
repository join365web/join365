/**
 * Laura AI · Amazon Bedrock — Cloudflare Worker
 * ---------------------------------------------------------------------------
 * API backend for the Bedrock chat page (Bedrock/index.html, hosted on GitHub
 * Pages). Only /api/* and a health check live here. No SDK, no build step:
 * it signs AWS requests itself (SigV4) and talks to Amazon Bedrock's
 * Converse / ConverseStream API, so one request shape works for every model
 * that Bedrock exposes through Converse. The page's built-in list only holds
 * models verified against their AWS model cards (see CATALOG below); anything
 * else this account can call is picked up live from ListInferenceProfiles.
 *
 * Routes
 *   GET  /              health check (never returns secrets)
 *   GET  /api/models    models this AWS account can call right now
 *   POST /api/chat      streaming chat (OpenAI-style SSE, what the page expects)
 *   POST /api/tts       text -> mp3 via Amazon Polly (neural voices)
 *   GET  /api/test?model=<id>  1-message ping of one model (POST {"model":"<id>"} also works)
 *
 * Worker settings → Variables and Secrets
 *   ACCESS_KEY           (Secret) AWS access key id                 — required
 *   SECRET_ACCESS_KEY    (Secret) AWS secret access key             — required
 *   ARN                  (Secret, optional) an IAM role ARN
 *                        (arn:aws:iam::<acct>:role/<name>) is assumed with the
 *                        keys above. A Bedrock ARN (arn:aws:bedrock:...) sets the
 *                        region and is listed as a model. Anything else is ignored.
 *   REGION / AWS_REGION  (Text, optional) default us-east-1. The us.* cross-region
 *                        profiles only work from US regions.
 *   WORKER_KEY           (Secret, optional) if set, every /api/* call must send
 *                        the header  x-api-key: <WORKER_KEY>
 *   AWS_SESSION_TOKEN    (Secret, optional) only for temporary credentials
 *
 * IAM permissions the keys need (least privilege):
 *   bedrock:InvokeModel, bedrock:InvokeModelWithResponseStream,
 *   bedrock:ListInferenceProfiles, bedrock:ListFoundationModels,
 *   polly:SynthesizeSpeech, and sts:AssumeRole if you use an IAM role ARN.
 * ---------------------------------------------------------------------------
 */

const DEFAULT_REGION = 'us-east-1';
const DEFAULT_MODEL = 'us.anthropic.claude-sonnet-5-5';
const MODEL_CACHE_MS = 10 * 60 * 1000;

// If the requested model fails and the page asked for auto-fallback, these are tried in order.
const FALLBACK_CHAIN = [
  'us.anthropic.claude-haiku-5-5',
  'us.amazon.nova-2-lite-v1:0',
  'us.openai.gpt-6.1-sol',
];

// Amazon Polly neural en-US voices (the page's "speak" voices).
const POLLY_VOICES = ['Joanna', 'Matthew', 'Ivy', 'Joey', 'Justin', 'Kendra', 'Kimberly', 'Salli', 'Kevin', 'Ruth', 'Stephen', 'Danielle', 'Gregory'];

// Used only for auto-discovered models: skip anything that is not a text chat model.
const NON_CHAT = /embed|rerank|image|canvas|reel|stable|diffusion|pegasus|marengo|sonic|guard|transcri|speech|upscale|voxtral|polly|tts|mythos/i;

// Claude models that use adaptive thinking ("effort") rather than a fixed thinking budget.
const ADAPTIVE_CLAUDE = /claude-(opus|sonnet|haiku|fable|mythos)-(4-[6-9]|5)/;

// Curated catalogue: only models verified against their AWS model card. When the
// account's live Bedrock listing works, the dropdown shows what that listing
// contains (curated entries get card labels, other models get AWS's own names).
// This list is used only if the listing is unavailable.
const C = (id, label, family, ctx, maxOut, caps, blurb) => ({ id, label, family, ctx, maxOut, caps, blurb, tier: 'production' });
const CATALOG = [
  // Every entry below was checked against its AWS model card: the model ID or
  // geo inference-profile ID is printed there, and the card lists Converse on
  // bedrock-runtime. Facts in the labels and blurbs come from those cards.
  C('us.anthropic.claude-sonnet-5-5', 'Claude Sonnet 5.5', 'Anthropic', 1000000, 0, { reasoning: true }, 'Launched 2026-09-28. 1M context.'),
  C('us.anthropic.claude-haiku-5-5', 'Claude Haiku 5.5', 'Anthropic', 0, 0, {}, 'Launched 2026-10-07.'),
  C('us.anthropic.claude-opus-5-5', 'Claude Opus 5.5', 'Anthropic', 1000000, 128000, { reasoning: true, vision: true }, 'Launched 2026-09-22. 1M context, 128K output, adaptive reasoning.'),
  C('us.openai.gpt-6.1-sol', 'GPT-6.1 Sol', 'OpenAI', 0, 0, {}, 'Available through Converse and Responses on Bedrock.'),
  C('us.xai.grok-4.7', 'Grok 4.7', 'xAI', 500000, 0, {}, '500K context.'),
  C('us.amazon.nova-2-lite-v1:0', 'Nova 2 Lite', 'Amazon', 1000000, 65536, { vision: true }, 'Text, image and video input (no audio). 1M context, 64K output.'),
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
  'Access-Control-Expose-Headers': 'x-model-used, x-fallback-from',
  'Access-Control-Max-Age': '86400',
};

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ============================ small helpers ============================ */

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data) {
  return hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
}

async function hmac(key, data) {
  const raw = typeof key === 'string' ? enc.encode(key) : key;
  const k = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}

// RFC 3986 encoding, the way AWS wants it.
function uriEncode(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function encodePath(p) {
  return p.split('/').map(uriEncode).join('/');
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function regionOf(env) {
  const explicit = env.REGION || env.AWS_REGION;
  if (explicit) return String(explicit).trim();
  const m = String(env.ARN || '').match(/^arn:aws[a-z-]*:bedrock:([a-z0-9-]+):/);
  return m ? m[1] : DEFAULT_REGION;
}

const isRoleArn = (a) => /^arn:aws[a-z-]*:iam::\d+:role\//.test(String(a || ''));
const isBedrockArn = (a) => /^arn:aws[a-z-]*:bedrock:[a-z0-9-]+:\d*:?(inference-profile|application-inference-profile|foundation-model)\//.test(String(a || ''));

/* ============================ SigV4 signing ============================ */

/**
 * Sign and build an AWS request. `path` must already be URI-encoded (as it goes
 * on the wire). The canonical URI is encoded once more, which is what AWS
 * expects for every service except S3.
 */
export async function signRequest({ method, host, path = '/', query = {}, headers = {}, body = '', service, region, creds, date = new Date() }) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payload = typeof body === 'string' ? enc.encode(body) : body;
  const payloadHash = await sha256Hex(payload);

  const all = { ...headers, host, 'x-amz-date': amzDate };
  if (creds.sessionToken) all['x-amz-security-token'] = creds.sessionToken;
  const lower = {};
  for (const [k, v] of Object.entries(all)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  const names = Object.keys(lower).sort();
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('');
  const signedHeaders = names.join(';');

  const qPairs = Object.entries(query).map(([k, v]) => [uriEncode(k), uriEncode(String(v))]);
  qPairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const canonicalQuery = qPairs.map(([k, v]) => `${k}=${v}`).join('&');

  const canonicalRequest = [method, encodePath(path), canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');

  let k = await hmac('AWS4' + creds.secretAccessKey, dateStamp);
  k = await hmac(k, region);
  k = await hmac(k, service);
  k = await hmac(k, 'aws4_request');
  const signature = hex(await hmac(k, stringToSign));

  const outHeaders = {};
  for (const n of names) if (n !== 'host') outHeaders[n] = lower[n];
  outHeaders.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: `https://${host}${path}${canonicalQuery ? '?' + canonicalQuery : ''}`,
    headers: outHeaders,
    body: payload,
  };
}

let roleCache = { arn: null, exp: 0, creds: null };
let authNote = '';

async function awsFetch(opts) {
  const s = await signRequest(opts);
  return fetch(s.url, {
    method: opts.method,
    headers: s.headers,
    body: opts.method === 'GET' ? undefined : s.body,
    signal: opts.signal,
  });
}

function parseXmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : '';
}

async function assumeRole(base, roleArn) {
  const form = new URLSearchParams({
    Action: 'AssumeRole',
    Version: '2011-06-15',
    RoleArn: roleArn,
    RoleSessionName: 'laura-bedrock',
    DurationSeconds: '3600',
  }).toString();
  const res = await awsFetch({
    method: 'POST',
    host: 'sts.amazonaws.com',
    path: '/',
    service: 'sts',
    region: 'us-east-1',
    creds: base,
    body: form,
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
  });
  const xml = await res.text();
  if (!res.ok) throw new Error(`AssumeRole failed (${res.status}): ${parseXmlTag(xml, 'Message') || xml.slice(0, 200)}`);
  return {
    accessKeyId: parseXmlTag(xml, 'AccessKeyId'),
    secretAccessKey: parseXmlTag(xml, 'SecretAccessKey'),
    sessionToken: parseXmlTag(xml, 'SessionToken'),
    exp: Date.parse(parseXmlTag(xml, 'Expiration')) || Date.now() + 3600e3,
  };
}

async function credentials(env) {
  const base = {
    accessKeyId: env.ACCESS_KEY || env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: env.SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY || '',
    sessionToken: env.AWS_SESSION_TOKEN || '',
  };
  if (!base.accessKeyId || !base.secretAccessKey) {
    throw httpError(500, 'Worker is missing ACCESS_KEY / SECRET_ACCESS_KEY. Add them under Settings → Variables and Secrets.');
  }
  if (!isRoleArn(env.ARN)) {
    authNote = '';
    return base;
  }
  if (roleCache.arn === env.ARN && roleCache.exp - Date.now() > 5 * 60e3) return roleCache.creds;
  try {
    const creds = await assumeRole(base, env.ARN);
    roleCache = { arn: env.ARN, exp: creds.exp, creds };
    authNote = '';
    return creds;
  } catch (e) {
    // Keep working with the base keys, but say why the role was not used.
    authNote = e.message;
    return base;
  }
}

/* ============================ model listing ============================ */

let modelCache = { key: '', at: 0, data: null };

async function getJson(creds, region, path, query) {
  const res = await awsFetch({ method: 'GET', host: `bedrock.${region}.amazonaws.com`, path, query, service: 'bedrock', region, creds });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} failed (${res.status}): ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/** Ask Bedrock what this account can actually call right now. Returns Map<id, info>. */
async function discover(creds, region) {
  const found = new Map();

  // 1) Active cross-region inference profiles (us.*). These are what the curated ids point at.
  let token = '';
  for (let page = 0; page < 10; page++) {
    const q = { typeEquals: 'SYSTEM_DEFINED', maxResults: '1000' };
    if (token) q.nextToken = token;
    const j = await getJson(creds, region, '/inference-profiles', q);
    for (const p of j.inferenceProfileSummaries || []) {
      if (p.status === 'ACTIVE' && /^us\./.test(p.inferenceProfileId)) {
        found.set(p.inferenceProfileId, { name: p.inferenceProfileName || p.inferenceProfileId, provider: '' });
      }
    }
    token = j.nextToken || '';
    if (!token) break;
  }

  // 2) Base text models that can be invoked on demand in this region.
  const base = await getJson(creds, region, '/foundation-models', { byOutputModality: 'TEXT', byInferenceType: 'ON_DEMAND' });
  for (const m of base.modelSummaries || []) {
    if (m.modelLifecycle?.status !== 'ACTIVE') continue;
    if (!(m.inputModalities || []).includes('TEXT')) continue;
    found.set(m.modelId, { name: m.modelName || m.modelId, provider: m.providerName || '' });
  }
  return found;
}

const normId = (id) => id.replace(/^us\./, '');

function publicModel(c, status) {
  return { id: c.id, label: c.label, family: c.family, tier: c.tier, kind: 'chat', ctx: c.ctx, maxOut: c.maxOut, speed: 0, caps: { chat: true, ...c.caps }, blurb: c.blurb, status };
}

function autoModel(id, info) {
  return {
    id,
    label: info.name,
    family: info.provider || 'Discovered',
    tier: 'auto',
    kind: 'chat',
    ctx: 0,
    maxOut: 0,
    speed: 0,
    caps: { chat: true },
    blurb: 'Found on your AWS account. Not in the curated list, so use “Check models” to confirm it answers.',
    status: 'live',
  };
}

async function listModels(env) {
  const region = regionOf(env);
  const key = region + '|' + (env.ARN || '');
  if (modelCache.data && modelCache.key === key && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.data;

  let found = null;
  let note = '';
  try {
    const creds = await credentials(env);
    found = await discover(creds, region);
  } catch (e) {
    note = e.message;
  }
  if (!note && authNote) note = authNote;

  const models = [];
  const seen = new Set();
  if (found) {
    for (const c of CATALOG) {
      if (found.has(c.id) && !seen.has(normId(c.id))) {
        models.push(publicModel(c, 'live'));
        seen.add(normId(c.id));
      }
    }
    for (const [id, info] of found) {
      if (seen.has(normId(id)) || NON_CHAT.test(id)) continue;
      models.push(autoModel(id, info));
      seen.add(normId(id));
    }
  }
  const usingStatic = !found || models.length === 0;
  if (usingStatic) {
    models.length = 0;
    for (const c of CATALOG) models.push(publicModel(c, 'static'));
  }
  if (isBedrockArn(env.ARN)) {
    const label = String(env.ARN).split(/[/:]/).pop() || 'Custom ARN';
    models.unshift({ id: env.ARN, label: 'Your ARN · ' + label, family: 'Custom', tier: 'custom', kind: 'chat', ctx: 0, maxOut: 0, speed: 0, caps: { chat: true }, blurb: 'The Bedrock ARN from your Worker settings.', status: 'live' });
  }
  models.push({
    id: 'polly-neural',
    label: 'Amazon Polly (neural voices)',
    family: 'Amazon Polly',
    tier: 'production',
    kind: 'tts',
    ctx: 3000,
    maxOut: 0,
    speed: 0,
    caps: { chat: false, tts: true, voices: POLLY_VOICES },
    blurb: 'Read answers aloud.',
    status: 'live',
  });

  const data = {
    object: 'list',
    source: usingStatic ? 'static' : 'live',
    region,
    note: usingStatic ? (note || 'Bedrock listing unavailable; showing the built-in catalogue.') : note,
    data: models,
  };
  modelCache = { key, at: Date.now(), data };
  return data;
}

/* ============================ Converse helpers ============================ */

function contentText(c) {
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) text = c.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('\n');
  return text.trim() ? text : '';
}

function convertMessages(body) {
  const system = [];
  const messages = [];
  for (const m of body.messages || []) {
    const text = contentText(m.content);
    if (!text) continue;
    if (m.role === 'system') {
      system.push({ text });
      continue;
    }
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const last = messages[messages.length - 1];
    if (last && last.role === m.role) last.content.push({ text });
    else messages.push({ role: m.role, content: [{ text }] });
  }
  // Converse needs the conversation to open with a user turn.
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length) throw httpError(400, 'Send at least one user message.');
  return { messages, system };
}

/**
 * Ordered request variants for one model. The first one that Bedrock accepts
 * wins. A 400 (ValidationException) moves on to the next variant. Anything
 * else stops the attempt.
 */
function attemptsFor(modelId, body) {
  const effort = ['low', 'medium', 'high'].includes(body.reasoning_effort) ? body.reasoning_effort : '';
  const wantTemp = typeof body.temperature === 'number' && Number.isFinite(body.temperature);
  const variants = [];
  if (effort) {
    const budget = { low: 1024, medium: 4096, high: 8192 }[effort];
    const thinking = { name: 'thinking-' + effort, budget, temp: false, fields: { thinking: { type: 'enabled', budget_tokens: budget } } };
    const adaptive = { name: 'effort-' + effort, budget: 0, temp: false, outputConfig: { effort } };
    if (modelId.includes('anthropic.claude')) variants.push(...(ADAPTIVE_CLAUDE.test(modelId) ? [adaptive, thinking] : [thinking, adaptive]));
    else if (modelId.includes('gpt-oss')) variants.push({ name: 'reasoning-effort', budget: 0, temp: wantTemp, fields: { reasoning_effort: effort } });
    else if (modelId.includes('nova-2')) variants.push({ name: 'reasoning-config', budget: 0, temp: false, fields: { reasoningConfig: { type: 'enabled', maxReasoningEffort: effort } } });
  }
  variants.push({ name: 'default', budget: 0, temp: wantTemp });
  if (wantTemp) variants.push({ name: 'no-temperature', budget: 0, temp: false });
  return variants.filter((v, i, a) => a.findIndex((w) => w.name === v.name) === i);
}

function buildConverse(modelId, body, v) {
  const { messages, system } = convertMessages(body);
  const cat = CATALOG.find((c) => c.id === modelId);
  const cap = cat && cat.maxOut ? cat.maxOut : 0;
  let maxTokens = Math.floor(Number(body.max_completion_tokens || body.max_tokens)) || 4096;
  if (cap) maxTokens = Math.min(maxTokens, cap);
  if (v.budget) maxTokens = Math.max(maxTokens, v.budget + 1024);
  const inferenceConfig = { maxTokens: Math.max(1, maxTokens) };
  if (v.temp) inferenceConfig.temperature = Math.min(1, Math.max(0, body.temperature));
  if (body.response_format && body.response_format.type === 'json_object') {
    system.push({ text: 'Reply with one valid JSON object only. No prose and no code fences.' });
  }
  const p = { messages, inferenceConfig };
  if (system.length) p.system = system;
  if (v.outputConfig) p.outputConfig = v.outputConfig;
  if (v.fields) p.additionalModelRequestFields = v.fields;
  return p;
}

async function readAwsError(res) {
  let message = res.statusText || 'HTTP ' + res.status;
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t);
      message = j.message || j.Message || message;
    } catch {
      if (t) message = t.slice(0, 300);
    }
  } catch {}
  const type = (res.headers.get('x-amzn-errortype') || '').split(':')[0];
  return { ok: false, status: res.status, message: type ? `${type}: ${message}` : message };
}

async function converseStreamModel(env, region, creds, modelId, body, signal) {
  let last = { ok: false, status: 502, message: 'no attempt made' };
  for (const v of attemptsFor(modelId, body)) {
    const res = await awsFetch({
      method: 'POST',
      host: `bedrock-runtime.${region}.amazonaws.com`,
      path: `/model/${uriEncode(modelId)}/converse-stream`,
      service: 'bedrock',
      region,
      creds,
      body: JSON.stringify(buildConverse(modelId, body, v)),
      headers: { 'content-type': 'application/json' },
      signal,
    });
    if (res.ok) return { ok: true, res, variant: v.name };
    last = await readAwsError(res);
    if (res.status !== 400) break;
  }
  return last;
}

/* ============================ event-stream parsing ============================ */

function parseHeaders(bytes) {
  const out = {};
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 0;
  while (i < bytes.length) {
    const nlen = bytes[i];
    i += 1;
    const name = dec.decode(bytes.subarray(i, i + nlen));
    i += nlen;
    const type = bytes[i];
    i += 1;
    let value;
    switch (type) {
      case 0: value = true; break;
      case 1: value = false; break;
      case 2: value = dv.getInt8(i); i += 1; break;
      case 3: value = dv.getInt16(i); i += 2; break;
      case 4: value = dv.getInt32(i); i += 4; break;
      case 5: value = dv.getBigInt64(i); i += 8; break;
      case 6:
      case 7: {
        const len = dv.getUint16(i);
        i += 2;
        const b = bytes.subarray(i, i + len);
        i += len;
        value = type === 7 ? dec.decode(b) : b;
        break;
      }
      case 8: value = dv.getBigInt64(i); i += 8; break;
      case 9: value = bytes.subarray(i, i + 16); i += 16; break;
      default: throw new Error('Unknown event-stream header type ' + type);
    }
    out[name] = value;
  }
  return out;
}

/** Split complete AWS event-stream frames off the front of `buf`. */
export function parseEventStream(buf) {
  const messages = [];
  let off = 0;
  while (buf.length - off >= 16) {
    const dv = new DataView(buf.buffer, buf.byteOffset + off, 12);
    const total = dv.getUint32(0);
    const hlen = dv.getUint32(4);
    if (total < 16) throw new Error('Corrupt event-stream frame');
    if (buf.length - off < total) break;
    const headers = parseHeaders(buf.subarray(off + 12, off + 12 + hlen));
    const payload = buf.subarray(off + 12 + hlen, off + total - 4);
    messages.push({ headers, payload });
    off += total;
  }
  return { messages, rest: buf.subarray(off) };
}

const STOP = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', model_context_window_exceeded: 'length', guardrail_intervened: 'content_filter', content_filtered: 'content_filter', tool_use: 'tool_calls' };

/** Turn one Bedrock event into zero or more OpenAI-style SSE strings. */
function eventToSSE(msg, state, meta) {
  const type = msg.headers[':message-type'];
  const data = msg.payload.length ? JSON.parse(dec.decode(msg.payload)) : {};
  if (type === 'exception' || type === 'error') {
    const kind = msg.headers[':exception-type'] || msg.headers[':error-code'] || 'error';
    throw new Error(`${kind}: ${data.message || data.Message || ''}`.trim());
  }
  const ev = msg.headers[':event-type'];
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: meta.id, object: 'chat.completion.chunk', created: meta.created, model: meta.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  switch (ev) {
    case 'contentBlockDelta': {
      const d = data.delta || {};
      let out = '';
      if (d.reasoningContent && d.reasoningContent.text) out += chunk({ reasoning: d.reasoningContent.text });
      if (d.text) out += chunk({ content: d.text });
      return out;
    }
    case 'messageStop':
      state.finish = STOP[data.stopReason] || 'stop';
      return '';
    case 'metadata':
      if (data.usage) state.usage = data.usage;
      return '';
    case 'internalServerException':
    case 'modelStreamErrorException':
    case 'validationException':
    case 'throttlingException':
    case 'serviceUnavailableException':
      throw new Error(`${ev}: ${data.message || ''}`.trim());
    default:
      return '';
  }
}

function sseFromEventStream(body, modelId) {
  const reader = body.getReader();
  const meta = { id: 'chatcmpl-' + crypto.randomUUID(), created: Math.floor(Date.now() / 1000), model: modelId };
  const state = { finish: null, usage: null };
  let buf = new Uint8Array(0);
  return new ReadableStream({
    async pull(ctrl) {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            let tail = `data: ${JSON.stringify({ id: meta.id, object: 'chat.completion.chunk', created: meta.created, model: modelId, choices: [{ index: 0, delta: {}, finish_reason: state.finish || 'stop' }] })}\n\n`;
            if (state.usage) {
              tail += `data: ${JSON.stringify({ id: meta.id, object: 'chat.completion.chunk', created: meta.created, model: modelId, choices: [], usage: { prompt_tokens: state.usage.inputTokens || 0, completion_tokens: state.usage.outputTokens || 0, total_tokens: state.usage.totalTokens || 0 } })}\n\n`;
            }
            ctrl.enqueue(enc.encode(tail + 'data: [DONE]\n\n'));
            ctrl.close();
            return;
          }
          buf = concat(buf, value);
          const parsed = parseEventStream(buf);
          buf = parsed.rest;
          let out = '';
          for (const m of parsed.messages) out += eventToSSE(m, state, meta);
          if (out) {
            ctrl.enqueue(enc.encode(out));
            return;
          }
        }
      } catch (e) {
        ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ error: { message: String(e.message || e) } })}\n\ndata: [DONE]\n\n`));
        ctrl.close();
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
}

/* ============================ route handlers ============================ */

async function handleChat(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw httpError(400, 'Request body must be JSON.');
  }
  const region = regionOf(env);
  const creds = await credentials(env);
  const requested = body.model || DEFAULT_MODEL;
  const chain = [requested];
  if (body.fallback) for (const m of FALLBACK_CHAIN) if (!chain.includes(m)) chain.push(m);

  const errors = [];
  let status = 502;
  for (const modelId of chain.slice(0, 4)) {
    const r = await converseStreamModel(env, region, creds, modelId, body, request.signal);
    if (r.ok) {
      const headers = { ...CORS, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-model-used': modelId };
      if (modelId !== requested) headers['x-fallback-from'] = requested;
      return new Response(sseFromEventStream(r.res.body, modelId), { headers });
    }
    status = r.status || 502;
    errors.push(`${modelId}: ${r.message}`);
    if (request.signal && request.signal.aborted) break;
  }
  throw httpError(status, errors.length > 1 ? 'All models failed. ' + errors.join(' | ') : errors[0]);
}

async function handleTts(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw httpError(400, 'Request body must be JSON.');
  }
  const text = String(body.input ?? body.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 2900);
  if (!text) throw httpError(400, 'Nothing to read.');
  const voice = POLLY_VOICES.includes(body.voice) ? body.voice : 'Joanna';
  const region = regionOf(env);
  const creds = await credentials(env);
  const res = await awsFetch({
    method: 'POST',
    host: `polly.${region}.amazonaws.com`,
    path: '/v1/speech',
    service: 'polly',
    region,
    creds,
    body: JSON.stringify({ Engine: 'neural', OutputFormat: 'mp3', Text: text, TextType: 'text', VoiceId: voice }),
    headers: { 'content-type': 'application/json' },
  });
  if (!res.ok) {
    const e = await readAwsError(res);
    throw httpError(e.status || 502, e.message);
  }
  return new Response(res.body, { headers: { ...CORS, 'content-type': 'audio/mpeg', 'cache-control': 'no-store' } });
}

async function handleTest(request, env) {
  let modelId;
  if (request.method === 'GET') {
    modelId = new URL(request.url).searchParams.get('model') || '';
  } else {
    let body;
    try {
      body = await request.json();
    } catch {
      throw httpError(400, 'Request body must be JSON.');
    }
    modelId = String(body.model || '');
  }
  if (!modelId) throw httpError(400, 'Send ?model=<id> (GET) or {"model": "<id>"} (POST).');
  const region = regionOf(env);
  const creds = await credentials(env);
  const t0 = Date.now();
  const r = await converseStreamModel(env, region, creds, modelId, {
    messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
    max_completion_tokens: 512,
    temperature: 0,
  });
  const ms = Date.now() - t0;
  if (!r.ok) return json({ model: modelId, ok: false, status: r.status, ms, error: r.message });
  let reply = '';
  let reasoning = false;
  const reader = r.res.body.getReader();
  let buf = new Uint8Array(0);
  let err = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf = concat(buf, value);
      const parsed = parseEventStream(buf);
      buf = parsed.rest;
      for (const m of parsed.messages) {
        const type = m.headers[':message-type'];
        const data = m.payload.length ? JSON.parse(dec.decode(m.payload)) : {};
        if (type === 'exception' || type === 'error') err = `${m.headers[':exception-type'] || 'error'}: ${data.message || ''}`;
        else if (m.headers[':event-type'] === 'contentBlockDelta') {
          if (data.delta?.text) reply += data.delta.text;
          if (data.delta?.reasoningContent) reasoning = true;
        }
      }
    }
  } catch (e) {
    err = String(e.message || e);
  }
  if (err) return json({ model: modelId, ok: false, status: 502, ms: Date.now() - t0, error: err });
  return json({ model: modelId, ok: true, ms: Date.now() - t0, reply: reply.trim().slice(0, 120), reasoning, variant: r.variant });
}

function healthInfo(env) {
  return {
    ok: true,
    service: 'Laura · Amazon Bedrock worker',
    region: regionOf(env),
    credentials: env.ACCESS_KEY || env.AWS_ACCESS_KEY_ID ? 'set' : 'missing',
    workerKey: env.WORKER_KEY ? 'required' : 'open',
    roleArn: isRoleArn(env.ARN) ? 'set' : 'not set',
    routes: ['GET /api/models', 'POST /api/chat', 'POST /api/tts', 'GET|POST /api/test'],
  };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      if (path === '/') return json(healthInfo(env));

      if (path.startsWith('/api/')) {
        if (env.WORKER_KEY && request.headers.get('x-api-key') !== env.WORKER_KEY) {
          throw httpError(401, 'Missing or wrong x-api-key header.');
        }
      }
      if (path === '/api/models' && request.method === 'GET') return json(await listModels(env));
      if (path === '/api/chat' && request.method === 'POST') return await handleChat(request, env);
      if (path === '/api/tts' && request.method === 'POST') return await handleTts(request, env);
      if (path === '/api/test' && (request.method === 'GET' || request.method === 'POST')) return await handleTest(request, env);
      return json({ error: { message: 'Not found' } }, 404);
    } catch (e) {
      return json({ error: { message: e.message || String(e) } }, e.status || 500);
    }
  },
};
