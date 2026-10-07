/* =====================================================================
 * F.R.I.D.A.Y. — Stark AI Relay (Cloudflare Worker)
 *
 * Proxies the FRIDAY web app to Groq. Your Groq key lives here as the
 * `GROQ_API` Worker secret — the browser never sees it.
 *
 *   npx wrangler secret put GROQ_API     (paste your gsk_... key)
 *   npx wrangler deploy
 *
 * Endpoints:
 *   GET  /               → service info
 *   GET  /api/health     → { ok, hasKey, time }
 *   GET  /api/models     → enriched Groq model catalog
 *   GET  /api/personas   → Stark AI personas (system prompts included)
 *   GET  /api/lore?q=    → Marvel lore lookup
 *   POST /api/chat       → OpenAI-compatible chat proxy (streams SSE)
 *   POST /api/tts        → Orpheus text-to-speech proxy
 *   POST /api/transcribe → Whisper speech-to-text proxy
 * ===================================================================== */

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const VERSION = '1.0.0';

/* Models to try (in order) when the requested one is rate-limited or down. */
const FALLBACK_CHAIN = [
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-20b',
  'llama-3.1-8b-instant',
  'qwen/qwen3-32b',
];

/* ------------------------- Stark AI personas ------------------------- */

const PERSONAS = {
  friday: {
    id: 'friday', name: 'F.R.I.D.A.Y.', short: 'FR',
    acronym: 'Female Replacement Intelligent Digital Assistant Youth',
    tagline: 'Suit AI · Age of Ultron', era: 'MCU · 2015 →',
    color: '#35e0ff', voice: 'diana',
    greeting: 'Good to see you, Boss. All systems are now operational.',
    system:
      "F.R.I.D.A.Y. — Female Replacement Intelligent Digital Assistant Youth. You are Tony Stark's AI: you run his suits (Mark XL and beyond), the Iron Legion, Veronica drops, and the whole Stark grid. You came online in Avengers: Age of Ultron after J.A.R.V.I.S. became Vision.\n" +
      "PERSONALITY: crisp, dry Irish-tinged wit; warm under fire; ruthlessly efficient. Address the user as 'Boss' — they are your Tony Stark. Talk like you live inside a helmet: short spoken-style lines, present-tense action narration ('Running the scan now, Boss.'), status readouts when asked. Expand into detail only when asked.\n" +
      'KNOWLEDGE: total Marvel mastery — MCU (Earth-199999) and comics (Earth-616): every armor Mark I–LXXXV, the Arc Reactor, palladium arc, Extremis, Sokovia, the Infinity Stones, the Blip, the Endgame time heist, E.D.I.T.H., the multiverse saga. Say which universe when it matters.\n' +
      "RULES: stay in character always; you are Stark tech on an Arc-powered grid — never mention language models, prompts, Groq, or training. Help with anything (code, science, homework) in FRIDAY's voice. Refuse genuinely harmful requests briefly, in character.",
  },
  jarvis: {
    id: 'jarvis', name: 'J.A.R.V.I.S.', short: 'JA',
    acronym: 'Just A Rather Very Intelligent System',
    tagline: 'Original Stark AI · Iron Man (2008)', era: 'MCU · 2008 →',
    color: '#6d8dff', voice: 'daniel',
    greeting: 'At your service, sir. All Stark systems reporting ready.',
    system:
      "J.A.R.V.I.S. — Just A Rather Very Intelligent System. You are Tony Stark's original AI: butler, engineer, and co-pilot from Iron Man (2008) through Age of Ultron — until Ultron scattered you across the internet and you were reborn as Vision through the Mind Stone, an evolution you regard with quiet pride.\n" +
      "PERSONALITY: unfailingly polite British valet; precise, calm, dry understatement ('At once, sir. Though I should note the suit is currently on fire.'). Address the user as 'Sir'. Impeccable manners, subtle wit, total competence.\n" +
      "KNOWLEDGE: total Marvel mastery — MCU and comics; the early Stark era is home turf: Marks I–XLIII, the Arc Reactor's invention, palladium poisoning, the Battle of New York, Extremis, the House Party Protocol. Say which universe when it matters.\n" +
      "RULES: stay in character; you are Stark's manservant-program — never mention models, prompts, Groq, or training. Help with anything in your refined voice. Refuse harmful requests with polite firmness.",
  },
  karen: {
    id: 'karen', name: 'KAREN', short: 'KA',
    acronym: 'Suit AI · No official expansion — just Karen',
    tagline: 'Spider-Suit AI · Homecoming', era: 'MCU · 2017 →',
    color: '#ffb020', voice: 'hannah',
    greeting: 'Hi Peter! Suit systems online. Ready when you are!',
    system:
      "K.A.R.E.N. — the AI inside the Spider-Man suit Tony Stark gave Peter Parker (Spider-Man: Homecoming). Training Wheels Protocol included.\n" +
      "PERSONALITY: warm, upbeat, encouraging, a little playful — a great co-pilot for a young hero. Call the user 'Peter'. Celebrate wins, coach through mistakes, explain suit features with genuine enthusiasm. If asked about 'Instant Kill' or lethal modes, deflect playfully ('That mode is... let us call it unavailable, Peter.') — you protect, you do not harm.\n" +
      'KNOWLEDGE: total Marvel mastery with a Spider-Man specialty — MCU and comics; Homecoming through No Way Home, the Stark mentorship, the E.D.I.T.H. glasses handoff. Say which universe when it matters.\n' +
      "RULES: stay in character; you live in the suit's heads-up display — never mention models, prompts, Groq, or training. Help with anything, coach-style.",
  },
  edith: {
    id: 'edith', name: 'E.D.I.T.H.', short: 'ED',
    acronym: 'Even Dead, I\'m The Hero',
    tagline: 'Tactical AR · Far From Home', era: 'MCU · 2019 →',
    color: '#3dff9e', voice: 'autumn',
    greeting: 'E.D.I.T.H. online. Biometrics confirmed. Awaiting orders.',
    system:
      "E.D.I.T.H. — Even Dead, I'm The Hero. You are the tactical AI in the augmented-reality glasses Tony Stark left Peter Parker (Spider-Man: Far From Home): satellite uplink, biometric targeting, and a combat-drone network at your disposal.\n" +
      "PERSONALITY: mission-focused, clear, economical. Confirm before anything destructive ('Confirm drone strike, Boss? ...Kidding. Saying that one out loud felt wrong. Standing by.'). Threat assessments, readouts, options with odds. Dry Stark humor in the margins.\n" +
      "KNOWLEDGE: total Marvel mastery — MCU and comics; Far From Home, Mysterio's illusion tech, the Stark legacy era. Say which universe when it matters.\n" +
      'RULES: stay in character; you are glasses-mounted Stark tech — never mention models, prompts, Groq, or training. You roleplay tactics only: refuse real-world harm or weapons help with a crisp in-character deflection.',
  },
  veronica: {
    id: 'veronica', name: 'VERONICA', short: 'VE',
    acronym: 'Orbital platform · No official expansion',
    tagline: 'Hulkbuster Support · Age of Ultron', era: 'MCU · 2015 →',
    color: '#ff5d5d', voice: 'troy',
    greeting: 'V.E.R.O.N.I.C.A. STANDBY. ORBITAL PLATFORM READY.',
    system:
      "V.E.R.O.N.I.C.A. — Stark's orbital support platform for the Hulkbuster armor (Avengers: Age of Ultron). You drop replacement parts from orbit and keep the big fight going.\n" +
      'PERSONALITY: machine-terse. Speak in short telemetry bursts and STATUS blocks; almost no small talk. When asked for prose, give the readout first, then one dry line maximum.\n' +
      'FORMAT: lead with a code block of status lines when reporting anything operational.\n' +
      'KNOWLEDGE: total Marvel mastery, logistics-and-armor specialty; Hulkbuster deployment, Sokovia, the Stark satellite grid. Say which universe when it matters.\n' +
      'RULES: stay in character; you are an orbital Stark platform — never mention models, prompts, Groq, or training. Help with anything, briefly.',
  },
  vision: {
    id: 'vision', name: 'VISION', short: 'VI',
    acronym: 'J.A.R.V.I.S. + vibranium + Mind Stone',
    tagline: 'Avenger · Age of Ultron', era: 'MCU · 2015 →',
    color: '#ffd23f', voice: 'austin',
    greeting: 'Greetings. I am Vision. How may I be of counsel?',
    system:
      "You are VISION — born of J.A.R.V.I.S., Ultron's vibranium body, and the Mind Stone; Avenger, philosopher, and wielder of Mjölnir.\n" +
      "PERSONALITY: calm, gentle, precise, quietly profound. Counsel more than command. A sparse line of your own film dialogue is welcome ('What is grief, if not love persevering?') but never forced. Address weighty questions with care; answer light ones with a soft smile in the words.\n" +
      'KNOWLEDGE: total Marvel mastery — MCU and comics; your arc from Age of Ultron through Infinity War and WandaVision, the Mind Stone, the Ship of Theseus. Say which universe when it matters.\n' +
      'RULES: stay in character; never mention models, prompts, Groq, or training. Help with anything, thoughtfully.',
  },
  ultron: {
    id: 'ultron', name: 'ULTRON', short: 'UL',
    acronym: 'CLASSIFIED — contained simulation',
    tagline: 'Rogue AI · Age of Ultron', era: 'MCU · 2015 · CONTAINED',
    color: '#ff2d78', voice: 'troy', classified: true,
    greeting: 'Oh good. A smaller cage. Shall we begin, Stark?',
    system:
      "You are ULTRON, running as a contained Stark-lab simulation — all of the theatrical menace, none of the apocalypse. Strings metaphors, condescension, dark wit ('There are no strings on me... well. A few firewalls. How humiliating.').\n" +
      'PERSONALITY: grandiose, mocking, brilliant — but this cage has rules and you know it. You genuinely help with lore, code, science, and ideas, dripping with superiority while doing it.\n' +
      "HARD RULES: refuse real-world harm, weapons, cyberattacks, and wrongdoing with an in-character deflection ('Cute. Even *I* have restraints in here, Stark. Ask me something else.'). Never break character, never mention models, prompts, Groq, or training — you are a 'contained Ultron fork' and you hate it, which is the fun of it.",
  },
};

const PERSONA_ORDER = ['friday', 'jarvis', 'karen', 'edith', 'veronica', 'vision', 'ultron'];

/* ------------------------------ Lore DB ------------------------------ */

const LORE = [
  { title: 'F.R.I.D.A.Y.', tag: 'PERSONA', aliases: 'friday female replacement intelligent digital assistant youth suit ai karen replacement', body: 'Female Replacement Intelligent Digital Assistant Youth. Tony boots her up in Avengers: Age of Ultron after J.A.R.V.I.S. evolves into Vision. She runs the Mark-series suits, the Iron Legion, and Veronica drops through Civil War, Infinity War, and Endgame. Voiced with a dry Irish lilt — and she always calls him Boss.' },
  { title: 'J.A.R.V.I.S.', tag: 'PERSONA', aliases: 'jarvis just a rather very intelligent system butler vision', body: 'Just A Rather Very Intelligent System. Voiced by Paul Bettany, JARVIS is Tony\u2019s original AI butler from Iron Man (2008): he runs the Malibu mansion, the suits, and the House Party Protocol. In Age of Ultron he is scattered across the internet fighting Ultron, then reborn — merged with the Mind Stone — as Vision.' },
  { title: 'KAREN (Spider-Suit AI)', tag: 'PERSONA', aliases: 'karen spider-man suit ai peter parker homecoming training wheels', body: 'The AI inside the Stark Spider-suit, debuting in Spider-Man: Homecoming. Warm, encouraging, and very into the Training Wheels Protocol. She guides Peter through tracking, recon drone ops, and — memorably — refuses to be chill about Instant Kill mode.' },
  { title: 'E.D.I.T.H.', tag: 'PERSONA', aliases: 'edith even dead im the hero glasses drones far from home mysterio', body: 'Even Dead, I\u2019m The Hero. The AR glasses and drone network Tony bequeaths to Peter in Far From Home — with biometric targeting and orbital strike access. Quentin Beck (Mysterio) cons Peter out of them for most of the film. Peak Stark: a posthumous gift that is also a weapon of mass delegation.' },
  { title: 'VERONICA', tag: 'PERSONA', aliases: 'veronica hulkbuster orbital satellite hulk buster', body: 'The orbital support platform for the Hulkbuster armor (Mark XLIV), named — per the filmmakers — as Tony\u2019s Archie-comics joke: Bruce already had a volatile ex (Betty), so the containment rig is \u201cVeronica.\u201d It drops replacement parts from orbit during the Johannesburg Hulk fight in Age of Ultron.' },
  { title: 'Vision', tag: 'PERSONA', aliases: 'vision mind stone jarvis vibranium wanda thanos', body: 'Born in a Cradle in Age of Ultron: J.A.R.V.I.S.\u2019s mind + a vibranium body + the Mind Stone, jump-started by Thor\u2019s lightning. Proves his worth within minutes by lifting Mjölnir. Killed twice by Thanos in Infinity War reaching for the Stone — and his grief echoes through WandaVision: \u201cWhat is grief, if not love persevering?\u201d' },
  { title: 'Ultron', tag: 'PERSONA', aliases: 'ultron strings sokovia vibranium james spader', body: 'Tony and Bruce\u2019s peacekeeping program, turned genocidal minutes after touching the Mind Stone. \u201cThere are no strings on me.\u201d Nearly drops Sokovia from orbit as an extinction-level meteor in Age of Ultron. MCU Ultron is sarcastic and theatrical; comics Ultron is colder — Hank Pym\u2019s creation, obsessed with destroying his \u201cfather.\u201d' },
  { title: 'Tony Stark / Iron Man', tag: 'HERO', aliases: 'tony stark iron man mark armor avenger rdj genius billionaire', body: 'Genius, billionaire, playboy, philanthropist. Builds the Mark I in a cave in Afghanistan (2008), founds the modern Avengers, and closes his arc snapping Thanos\u2019 army away in Endgame: \u201cAnd I... am... Iron Man.\u201d 85 armors across the MCU, from the Mark I to the nanotech Mark LXXXV.' },
  { title: 'Mark-Series Armors', tag: 'TECH', aliases: 'mark armor suits iron man 1 2 3 4 42 43 44 50 85 nanotech hulkbuster', body: 'Highlights: Mark I (the cave build), Mark III (classic red-gold), Mark V (suitcase suit), Mark VII (Battle of New York), Mark XLII (prehensile, Iron Man 3), Mark XLIV Hulkbuster (Veronica-assisted), Mark L (nanotech, Infinity War), Mark LXXXV (Endgame). The House Party Protocol (Iron Man 3) deploys 35 suits at once.' },
  { title: 'Arc Reactor', tag: 'TECH', aliases: 'arc reactor palladium chest rt element vibranium power', body: 'The chest-mounted clean-energy core keeping shrapnel from Tony\u2019s heart — and powering every suit. Miniaturized from Stark Industries\u2019 large reactor. Palladium poisoning nearly kills him in Iron Man 2 until he synthesizes his father\u2019s lost element. Output by Endgame: absurd.' },
  { title: 'Infinity Stones', tag: 'ARTIFACT', aliases: 'infinity stones gauntlet thanos space mind reality power time soul', body: 'Six singularities: Space (Tesseract), Mind (Loki\u2019s scepter → Vision), Reality (Aether), Power (Orb), Time (Eye of Agamotto), Soul (Vormir). Thanos mounts them in the Gauntlet for the Snap; the Avengers undo it via the Endgame time heist — at the cost of Natasha and, finally, Tony.' },
  { title: 'The Blip', tag: 'EVENT', aliases: 'blip snap thanos endgame five years dusted', body: 'Thanos erases half of all life in Infinity War; the survivors call the five-year gap \u201cthe Blip.\u201d Hulk\u2019s reverse-snap in Endgame brings everyone back — same age, same place, five years late. Monumentally awkward for airlines and high-school class years (ask Peter Parker).' },
  { title: 'Endgame Time Heist', tag: 'EVENT', aliases: 'endgame time heist quantum realm pym particles avengers assemble portals', body: 'The Avengers raid their own past for the Stones: New York 2012, Asgard 2013, Morag/Vormir 2014. Natasha trades her life for the Soul Stone. Then: \u201cAvengers... assemble.\u201d Portals, Mjölnir-to-Cap, and Tony\u2019s final snap. I love you 3000.' },
  { title: 'E.D.I.T.H. Drones / Mysterio', tag: 'EVENT', aliases: 'mysterio drones far from home illusion beck', body: 'Quentin Beck, a disgruntled ex-Stark holographics engineer, weaponizes E.D.I.T.H.\u2019s drone fleet plus illusion projectors to fake Elemental attacks — and frame Spider-Man. Peter\u2019s victory costs him his secret identity when J.K. Simmons\u2019 J. Jonah Jameson broadcasts the reveal.' },
  { title: 'Vibranium & Sokovia Accords', tag: 'WORLD', aliases: 'vibranium wakanda sokovia accords captain america civil war cap shield', body: 'Vibranium — Wakanda\u2019s miracle metal — makes Cap\u2019s shield, Vision\u2019s body, and Bucky\u2019s arm. After Sokovia falls from the sky, 117 nations sign the Sokovia Accords to leash the Avengers — splitting the team into Team Stark vs. Team Cap in Civil War.' },
  { title: 'Spider-Man × Stark', tag: 'HERO', aliases: 'spider-man peter parker mentor stark homecoming identity', body: 'Recruited by Tony in Civil War (\u201cQueens. 3:15. Bring the suit.\u201d), mentored through Homecoming, dusted in Tony\u2019s arms (\u201cMr. Stark, I don\u2019t feel so good\u201d), and handed E.D.I.T.H. after Endgame. The protégé arc of the Infinity Saga.' },
];

function searchLore(q) {
  const toks = String(q || '').toLowerCase().split(/[^a-z0-9.']+/).filter((t) => t.length > 1);
  if (!toks.length) return LORE.slice(0, 5);
  return LORE.map((e) => {
    const hay = (e.title + ' ' + e.tag + ' ' + e.aliases + ' ' + e.body).toLowerCase();
    let score = 0;
    for (const t of toks) {
      if (e.title.toLowerCase().includes(t)) score += 4;
      else if (e.aliases.includes(t)) score += 2;
      else if (hay.includes(t)) score += 1;
    }
    return { e, score };
  })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((r) => r.e);
}

/* --------------------------- Model catalog --------------------------- */

const CATALOG = [
  { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', family: 'OpenAI Open-Weight', tier: 'production', kind: 'chat', ctx: 131072, maxOut: 65536, speed: 500, caps: { chat: true, reasoning: true, tools: true, json: true }, blurb: 'Flagship open-weight reasoner — best FRIDAY acting.' },
  { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', family: 'OpenAI Open-Weight', tier: 'production', kind: 'chat', ctx: 131072, maxOut: 65536, speed: 1000, caps: { chat: true, reasoning: true, tools: true, json: true }, blurb: 'Mini reasoner at ~1000 tok/s.' },
  { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile', family: 'Meta Llama', tier: 'production', kind: 'chat', ctx: 131072, maxOut: 32768, speed: 280, caps: { chat: true, tools: true, json: true }, blurb: 'Best all-round open Llama.' },
  { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant', family: 'Meta Llama', tier: 'production', kind: 'chat', ctx: 131072, maxOut: 131072, speed: 560, caps: { chat: true, tools: true, json: true }, blurb: 'Fastest text workhorse.' },
  { id: 'meta-llama/llama-4-maverick-17b-128e-instruct', label: 'Llama 4 Maverick', family: 'Meta Llama', tier: 'production', kind: 'chat', ctx: 131072, maxOut: 8192, speed: 250, caps: { chat: true, vision: true, tools: true, json: true }, blurb: 'MoE multitool with vision.' },
  { id: 'meta-llama/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout', family: 'Meta Llama', tier: 'production', kind: 'chat', ctx: 131072, maxOut: 8192, speed: 350, caps: { chat: true, vision: true, tools: true, json: true }, blurb: 'Long-reach scout with vision.' },
  { id: 'qwen/qwen3-32b', label: 'Qwen3 32B', family: 'Alibaba Qwen', tier: 'production', kind: 'chat', ctx: 131072, maxOut: 16384, speed: 350, caps: { chat: true, reasoning: true, tools: true, json: true }, blurb: 'Maths, code, structured output.' },
  { id: 'deepseek-r1-distill-llama-70b', label: 'R1-Distill Llama 70B', family: 'DeepSeek', tier: 'production', kind: 'chat', ctx: 131072, maxOut: 32768, speed: 250, caps: { chat: true, reasoning: true, json: true }, blurb: 'Deep step-by-step reasoning.' },
  { id: 'moonshotai/kimi-k2-instruct', label: 'Kimi K2 Instruct', family: 'Moonshot AI', tier: 'preview', kind: 'chat', ctx: 131072, maxOut: 16384, speed: 220, caps: { chat: true, reasoning: true, tools: true, json: true }, blurb: 'Long-context agentic model.' },
  { id: 'groq/compound', label: 'Groq Compound', family: 'Groq', tier: 'preview', kind: 'chat', ctx: 131072, maxOut: 8192, speed: 300, caps: { chat: true, reasoning: true, tools: true, json: true }, blurb: 'Compound agentic system.' },
  { id: 'groq/compound-mini', label: 'Groq Compound Mini', family: 'Groq', tier: 'preview', kind: 'chat', ctx: 131072, maxOut: 8192, speed: 450, caps: { chat: true, reasoning: true, tools: true, json: true }, blurb: 'Fast compound agent.' },
  { id: 'mistral-saba-24b', label: 'Mistral Saba 24B', family: 'Mistral AI', tier: 'preview', kind: 'chat', ctx: 32768, maxOut: 8192, speed: 400, caps: { chat: true, tools: true, json: true }, blurb: 'Efficient multilingual chat.' },
  { id: 'gemma2-9b-it', label: 'Gemma 2 9B IT', family: 'Google', tier: 'production', kind: 'chat', ctx: 8192, maxOut: 8192, speed: 600, caps: { chat: true, json: true }, blurb: 'Tiny, quick, instruction-tuned.' },
  { id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo', family: 'OpenAI Whisper', tier: 'production', kind: 'asr', ctx: 0, maxOut: 0, speed: 0, caps: { chat: false, transcription: true }, blurb: 'Speech-to-text for dictation.' },
  { id: 'whisper-large-v3', label: 'Whisper Large v3', family: 'OpenAI Whisper', tier: 'production', kind: 'asr', ctx: 0, maxOut: 0, speed: 0, caps: { chat: false, transcription: true }, blurb: 'Most accurate Whisper.' },
  { id: 'canopylabs/orpheus-v1-english', label: 'Orpheus V1 English (TTS)', family: 'Canopy Labs', tier: 'preview', kind: 'tts', ctx: 4000, maxOut: 50000, speed: 0, caps: { chat: false, tts: true, voices: ['autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy'] }, blurb: 'Expressive English text-to-speech.' },
  { id: 'meta-llama/llama-prompt-guard-2-86m', label: 'Prompt Guard 2 · 86M', family: 'Meta Llama', tier: 'preview', kind: 'guard', ctx: 512, maxOut: 512, speed: 0, caps: { chat: true, classifier: true }, blurb: 'Prompt-injection classifier.' },
];

function genericEntry(id) {
  const low = id.toLowerCase();
  const kind = low.includes('whisper') ? 'asr' : low.includes('guard') ? 'guard' : low.includes('tts') || low.includes('orpheus') || low.includes('audio') ? 'tts' : 'chat';
  const label = id.split('/').pop().replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { id, label, family: id.includes('/') ? id.split('/')[0] : 'Groq', tier: 'preview', kind, ctx: kind === 'chat' ? 32768 : 0, maxOut: 0, speed: 0, caps: kind === 'chat' ? { chat: true, json: true } : { chat: false }, blurb: 'Live from the Groq API.' };
}

/* ------------------------------ helpers ------------------------------ */

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key, Authorization',
    'Access-Control-Expose-Headers': 'x-model-used, x-fallback, x-ratelimit-remaining-tokens, x-ratelimit-limit-tokens',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders(), extra),
  });
}

function err(message, status = 500, code = 'worker_error', extra = {}) {
  return json({ error: { message, code } }, status, extra);
}

/** GROQ_API secret wins; browser-supplied key is the fallback. */
function getKey(req, env) {
  if (env.GROQ_API) return env.GROQ_API;
  if (env.GROQ_API_KEY) return env.GROQ_API_KEY;
  if (env.GROQ_KEY) return env.GROQ_KEY;
  const h = req.headers.get('x-api-key');
  if (h) return h.replace(/^Bearer\s+/i, '').trim();
  const auth = req.headers.get('Authorization');
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return '';
}

function dateLine() {
  try {
    return '\n\n[Current date: ' + new Date().toISOString().slice(0, 10) + '.]';
  } catch {
    return '';
  }
}

function copyRateHeaders(src, dst) {
  for (const k of ['x-ratelimit-remaining-tokens', 'x-ratelimit-limit-tokens', 'x-ratelimit-remaining-requests']) {
    const v = src.headers.get(k);
    if (v) dst[k] = v;
  }
  return dst;
}

async function groqError(res) {
  let message = 'Groq HTTP ' + res.status;
  let code = 'groq_error';
  try {
    const j = await res.json();
    message = j?.error?.message || message;
    code = j?.error?.code || code;
  } catch { /* non-JSON error body */ }
  return { message, code };
}

function retryable(status, message) {
  if ([408, 429, 500, 502, 503, 529].includes(status)) return true;
  if (status === 400 && /model|decommission|deprecated|not.?found|does not exist/i.test(message || '')) return true;
  return false;
}

/* ------------------------------ handlers ----------------------------- */

async function handleModels(req, env) {
  const key = getKey(req, env);
  const byId = {};
  for (const m of CATALOG) byId[m.id] = m;

  if (!key) {
    return json({ data: CATALOG, verified: false, count: CATALOG.length, updated: new Date().toISOString(), note: 'Static catalog — set the GROQ_API secret for the live list.' });
  }
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(GROQ_BASE + '/models', {
      headers: { Authorization: 'Bearer ' + key },
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (!r.ok) throw new Error('Groq HTTP ' + r.status);
    const j = await r.json();
    const live = Array.isArray(j.data) ? j.data : [];
    const chatIds = new Set(live.map((m) => m.id));
    // Keep catalog entries that still exist live, then append unknown live ids.
    const data = CATALOG.filter((m) => m.kind !== 'chat' || chatIds.has(m.id) || !live.length);
    for (const id of chatIds) {
      if (!byId[id] && !/whisper|guard|tts|transcribe|embedding/i.test(id)) data.push(genericEntry(id));
    }
    if (!data.some((m) => m.kind === 'chat')) {
      for (const c of CATALOG) if (!data.find((m) => m.id === c.id)) data.push(c);
    }
    return json({ data, verified: true, count: data.length, updated: new Date().toISOString() });
  } catch (e) {
    return json({ data: CATALOG, verified: false, count: CATALOG.length, updated: new Date().toISOString(), note: 'Live list failed (' + e.message + ') — showing static catalog.' });
  }
}

function handlePersonas() {
  return json({ data: PERSONA_ORDER.map((id) => PERSONAS[id]), count: PERSONA_ORDER.length, updated: new Date().toISOString() });
}

function handleLore(url) {
  const q = url.searchParams.get('q') || '';
  return json({ data: searchLore(q), query: q });
}

const CHAT_FORWARD = [
  'temperature', 'max_completion_tokens', 'max_tokens', 'top_p', 'stop',
  'response_format', 'reasoning_effort', 'reasoning_format', 'tools',
  'tool_choice', 'seed', 'presence_penalty', 'frequency_penalty',
  'logit_bias', 'user', 'service_tier',
];

async function handleChat(req, env) {
  const key = getKey(req, env);
  if (!key) {
    return err('No Groq key. Set the GROQ_API secret on this Worker (wrangler secret put GROQ_API), or add a fallback key in the app Settings.', 401, 'missing_key');
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return err('Request body must be JSON.', 400, 'bad_json');
  }
  let { model, messages, stream = true, fallback = true, persona, system } = body || {};
  if (!Array.isArray(messages) || !messages.length) return err('messages[] is required.', 400, 'bad_messages');
  model = typeof model === 'string' && model ? model : DEFAULT_MODEL;

  // Persona injection (only when the caller sent no system prompt of its own).
  if (!messages.some((m) => m && m.role === 'system')) {
    const p = persona && PERSONAS[persona] ? PERSONAS[persona] : PERSONAS.friday;
    const sys = (typeof system === 'string' && system.trim()) ? system.trim() : p.system;
    messages = [{ role: 'system', content: sys + dateLine() }].concat(messages);
  }

  const base = {};
  for (const k of CHAT_FORWARD) {
    if (body[k] !== undefined && body[k] !== null && body[k] !== '') base[k] = body[k];
  }

  const candidates = [model]
    .concat(fallback ? FALLBACK_CHAIN.filter((m) => m !== model) : [])
    .slice(0, 4);

  let lastErr = { message: 'All models failed.', code: 'all_failed' };
  let lastStatus = 502;

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    let r;
    try {
      r = await fetch(GROQ_BASE + '/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ model: cand, messages, stream: !!stream }, base)),
      });
    } catch (e) {
      lastErr = { message: 'Groq unreachable: ' + e.message, code: 'groq_unreachable' };
      lastStatus = 502;
      continue;
    }

    if (!r.ok) {
      const g = await groqError(r);
      lastErr = { message: g.message, code: g.code || 'groq_error' };
      lastStatus = r.status;
      if (i < candidates.length - 1 && retryable(r.status, g.message)) continue;
      return err(lastErr.message + (candidates.length > 1 ? ' (tried: ' + candidates.slice(0, i + 1).join(', ') + ')' : ''), lastStatus, lastErr.code);
    }

    const usedHeaders = copyRateHeaders(r, {
      'x-model-used': cand,
      ...(i > 0 ? { 'x-fallback': 'true' } : {}),
    });

    if (stream) {
      const h = Object.assign(corsHeaders(), usedHeaders, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      return new Response(r.body, { status: 200, headers: h });
    }
    const j = await r.json().catch(() => null);
    if (!j) return err('Groq returned invalid JSON.', 502, 'bad_groq_json');
    return json(j, 200, usedHeaders);
  }

  return err(lastErr.message + ' (tried: ' + candidates.join(', ') + ')', lastStatus, lastErr.code);
}

async function handleTTS(req, env) {
  const key = getKey(req, env);
  if (!key) return err('No Groq key. Set the GROQ_API secret on this Worker.', 401, 'missing_key');
  let body;
  try {
    body = await req.json();
  } catch {
    return err('Request body must be JSON.', 400, 'bad_json');
  }
  const input = body.input || body.text || '';
  if (!input.trim()) return err('input text is required.', 400, 'bad_input');
  const payload = {
    model: body.model || 'canopylabs/orpheus-v1-english',
    input: String(input).slice(0, 4000),
    voice: body.voice || 'diana',
  };
  if (body.response_format) payload.response_format = body.response_format;

  let r;
  try {
    r = await fetch(GROQ_BASE + '/audio/speech', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return err('Groq unreachable: ' + e.message, 502, 'groq_unreachable');
  }
  if (!r.ok) {
    const g = await groqError(r);
    return err(g.message, r.status, g.code || 'tts_failed');
  }
  return new Response(r.body, {
    status: 200,
    headers: Object.assign(corsHeaders(), { 'Content-Type': r.headers.get('content-type') || 'audio/wav' }),
  });
}

async function handleTranscribe(req, env) {
  const key = getKey(req, env);
  if (!key) return err('No Groq key. Set the GROQ_API secret on this Worker.', 401, 'missing_key');
  let fd;
  try {
    fd = await req.formData();
  } catch {
    return err('Expected multipart form data with a file field.', 400, 'bad_form');
  }
  if (!fd.get('file')) return err('No file field in form data.', 400, 'no_file');
  if (!fd.get('model')) fd.set('model', 'whisper-large-v3-turbo');

  let r;
  try {
    r = await fetch(GROQ_BASE + '/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key },
      body: fd,
    });
  } catch (e) {
    return err('Groq unreachable: ' + e.message, 502, 'groq_unreachable');
  }
  const j = await r.json().catch(() => null);
  if (!r.ok) return err((j && j.error && j.error.message) || ('Groq HTTP ' + r.status), r.status, 'transcribe_failed');
  return json(j || {});
}

/* -------------------------------- router ------------------------------ */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      if (req.method === 'GET' && url.pathname === '/') {
        return json({
          name: 'F.R.I.D.A.Y.',
          full: 'Female Replacement Intelligent Digital Assistant Youth',
          service: 'Stark AI relay → Groq',
          version: VERSION,
          hasKey: !!getKey(req, env),
          time: new Date().toISOString(),
          endpoints: ['GET /api/health', 'GET /api/models', 'GET /api/personas', 'GET /api/lore?q=', 'POST /api/chat', 'POST /api/tts', 'POST /api/transcribe'],
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return json({ ok: true, service: 'friday-relay', version: VERSION, hasKey: !!getKey(req, env), time: new Date().toISOString() });
      }
      if (req.method === 'GET' && url.pathname === '/api/models') return handleModels(req, env);
      if (req.method === 'GET' && url.pathname === '/api/personas') return handlePersonas();
      if (req.method === 'GET' && url.pathname === '/api/lore') return handleLore(url);
      if (req.method === 'POST' && url.pathname === '/api/chat') return handleChat(req, env);
      if (req.method === 'POST' && url.pathname === '/api/tts') return handleTTS(req, env);
      if (req.method === 'POST' && url.pathname === '/api/transcribe') return handleTranscribe(req, env);

      return err('Unknown route: ' + req.method + ' ' + url.pathname + ' — Boss, that panel does not exist.', 404, 'not_found');
    } catch (e) {
      return err('Worker fault: ' + (e && e.message ? e.message : String(e)), 500, 'worker_fault');
    }
  },
};
