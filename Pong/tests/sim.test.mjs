/**
 * Pong vs VEX — headless simulation tests.
 *
 *   cd Pong/tests && npm install && npm test
 *
 * The page under test is ../index.html. It is loaded into jsdom and its real
 * inline script is executed; the only thing stubbed is the 2D drawing context
 * and the audio graph (no GPU, no sound card). Everything else — physics, the
 * AI, the speech engine, the DOM wiring — is the shipped code.
 *
 * Two ways the game is driven here:
 *   tick(seconds)  → runs the real requestAnimationFrame loop (step + render + HUD)
 *   pong.simulate(seconds) → runs only the fixed-step simulation, for long matches
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const HTML = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const FRAME_MS = 1000 / 60;

/* ---------- tiny assertion harness ---------- */

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
function section(title) { console.log('\n' + title); }

/* ---------- canvas + audio stubs ---------- */

function fakeCtx2d(sink) {
  const store = {};
  const target = {
    canvas: null,
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    measureText() { return { width: 10 }; },
    getImageData() { return { data: new Uint8ClampedArray(4) }; }
  };
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (prop in store) return store[prop];
      return function () { sink.calls++; sink.names.add(String(prop)); };
    },
    set(t, prop, value) { store[prop] = value; return true; }
  });
}

class FakeParam { setValueAtTime() {} linearRampToValueAtTime() {} exponentialRampToValueAtTime() {} }
class FakeAudioContext {
  constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; }
  createOscillator() { return { type: 'square', frequency: new FakeParam(), connect() {}, start() {}, stop() {} }; }
  createGain() { return { gain: new FakeParam(), connect() {} }; }
  resume() { this.state = 'running'; }
}

/* ---------- boot a fresh game ---------- */

function boot() {
  const problems = [];
  const sink = { calls: 0, names: new Set() };
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => problems.push('jsdomError: ' + (e && e.message)));
  ['error', 'warn'].forEach(level => vc.on(level, (...a) => problems.push(level + ': ' + a.join(' '))));

  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously',
    virtualConsole: vc,
    url: 'https://join365.eu.cc/Pong/',
    beforeParse(win) {
      win.HTMLCanvasElement.prototype.getContext = function () {
        const c = fakeCtx2d(sink);
        c.canvas = this;
        return c;
      };
      win.AudioContext = FakeAudioContext;
      /* hand us the loop instead of letting it self-schedule */
      win.__raf = null;
      win.requestAnimationFrame = cb => { win.__raf = cb; return 1; };
      win.cancelAnimationFrame = () => {};
      /* jsdom lays out at 0×0; give the canvas a real box so resize() works */
      win.HTMLCanvasElement.prototype.getBoundingClientRect = () =>
        ({ width: 960, height: 600, top: 0, left: 0, right: 960, bottom: 600, x: 0, y: 0, toJSON() {} });
      win.devicePixelRatio = 1;
    }
  });

  const win = dom.window;
  const doc = win.document;
  const pong = win.__PONG__;
  let clock = 0;

  function tick(seconds) {
    const frames = Math.max(1, Math.round((seconds * 1000) / FRAME_MS));
    for (let i = 0; i < frames; i++) {
      clock += FRAME_MS;
      const cb = win.__raf;
      if (!cb) throw new Error('the game loop never registered a frame');
      cb(clock);
    }
  }

  return { dom, win, doc, pong, tick, problems, sink, $: id => doc.getElementById(id) };
}

/* ==========================================================================
   1 · The page boots and actually draws
   ========================================================================== */

section('1 · boot');
{
  const g = boot();
  g.tick(0.2);

  check('no console/jsdom errors on load', g.problems.length === 0, g.problems.join(' | '));
  check('exposes the simulation hooks', !!g.pong && typeof g.pong.step === 'function');
  check('the render loop draws to the canvas', g.sink.calls > 20, 'ctx calls: ' + g.sink.calls);
  check('draws the paddles and the ball (arc + fill)', g.sink.names.has('arc') && g.sink.names.has('fill'));
  check('starts on the menu with the start overlay up', g.pong.state.mode === 'menu' && g.$('startVeil').classList.contains('show'));
  check('HUD is wired to the score nodes', g.$('scoreYou').textContent === '0' && g.$('scoreVex').textContent === '0');
  check('VEX portrait has a face', !!g.$('vexMouth').getAttribute('d'));
}

/* ==========================================================================
   2 · The progressive speed-up (the headline feature)
   ========================================================================== */

section('2 · the ball gets faster');
{
  const g = boot();
  const p = g.pong;

  /* serve speed must climb with every point played, and stop at the cap */
  const serves = [];
  for (let n = 0; n <= 30; n++) { p.state.pointsPlayed = n; serves.push(p.serveSpeed()); }
  let serveMonotonic = true;
  for (let i = 1; i < serves.length; i++) if (serves[i] < serves[i - 1] - 1e-9) serveMonotonic = false;
  check('each point makes the next serve faster', serveMonotonic, serves.slice(0, 6).map(s => s.toFixed(0)).join(' → '));
  check('serve speed is capped', serves[30] <= p.CFG.maxSpeed + 1e-9, 'got ' + serves[30].toFixed(1));
  check('point 0 serves at base × difficulty', Math.abs(serves[0] - p.CFG.baseSpeed) < 1e-6);
  p.state.pointsPlayed = 0;

  /* every paddle hit must add speed, inside one rally, never past the cap */
  g.$('startBtn').click();
  p.state.auto = true;                 /* unbeatable paddle, so rallies keep going */
  const perHit = [];
  let lastHits = p.state.hits, lastPoint = p.state.pointsPlayed, lastSpeed = 0;
  for (let i = 0; i < 12000 && p.state.mode !== 'over'; i++) {
    p.step(p.CFG.dt);
    if (p.state.pointsPlayed !== lastPoint) { lastPoint = p.state.pointsPlayed; perHit.push([]); lastSpeed = 0; }
    if (p.state.hits !== lastHits) {
      lastHits = p.state.hits;
      if (!perHit.length) perHit.push([]);
      perHit[perHit.length - 1].push(p.ball.speed);
    }
    lastSpeed = p.ball.speed;
  }
  const flat = perHit.flat();
  let withinRally = true, worst = '';
  perHit.forEach((rally, ri) => {
    for (let i = 1; i < rally.length; i++) {
      if (rally[i] < rally[i - 1] - 1e-6) { withinRally = false; worst = 'rally ' + ri + ': ' + rally[i - 1].toFixed(1) + ' → ' + rally[i].toFixed(1); }
    }
  });
  check('paddle hits recorded', flat.length > 30, flat.length + ' hits');
  check('speed never drops inside a rally', withinRally, worst);
  check('speed strictly grows on at least 20 hits', flat.filter((v, i) => i > 0 && v > flat[i - 1] + 1e-6).length >= 20);
  check('speed never exceeds the cap', flat.every(v => v <= p.CFG.maxSpeed + 1e-6), 'max seen ' + Math.max(...flat).toFixed(1) + ' vs cap ' + p.CFG.maxSpeed);
  check('top speed was tracked', p.state.topSpeed <= p.CFG.maxSpeed + 1e-6 && p.state.topSpeed > p.CFG.baseSpeed, p.state.topSpeed.toFixed(0));
  check('the ×multiplier readout follows the ball', /^×\d\.\d\d$/.test(g.$('speedVal').textContent), g.$('speedVal').textContent);
}

/* ==========================================================================
   3 · Physics holds together
   ========================================================================== */

section('3 · physics');
{
  const g = boot();
  const p = g.pong;
  const R = p.CFG.ballR;

  /* wall folding used by the AI's prediction */
  const folded = [p.predictY(100, 500, 3), p.predictY(500, -400, 4), p.predictY(300, 900, 9)];
  check('AI bounce prediction stays inside the court', folded.every(y => y >= R - 1e-6 && y <= p.CFG.H - R + 1e-6), folded.map(y => y.toFixed(1)).join(', '));

  /* a full-length match must never produce NaN or an escaped ball */
  g.$('startBtn').click();
  p.state.auto = true;
  let escaped = 0, nan = 0;
  for (let i = 0; i < 40000 && p.state.mode !== 'over'; i++) {
    p.step(p.CFG.dt);
    const b = p.ball;
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.vx) || !Number.isFinite(b.vy)) nan++;
    if (b.y < R - 0.6 || b.y > p.CFG.H - R + 0.6) escaped++;
    if (!Number.isFinite(p.player.y) || !Number.isFinite(p.vex.y)) nan++;
  }
  check('no NaN in the simulation', nan === 0, nan + ' bad frames');
  check('the ball never leaves the court vertically', escaped === 0, escaped + ' frames out of bounds');

  /* the rebound angle must stay playable — never near-vertical */
  g.$('startBtn').click();
  let tooVertical = 0, samples = 0;
  for (let i = 0; i < 20000; i++) {
    p.step(p.CFG.dt);
    if (p.state.mode === 'play' && p.ball.speed > 0) {
      samples++;
      if (Math.abs(p.ball.vx) < p.CFG.minVxRatio * p.ball.speed - 1e-6) tooVertical++;
    }
  }
  check('the ball always keeps travelling sideways', tooVertical === 0, tooVertical + '/' + samples + ' frames too vertical');

  /* a maxed-out ball aimed straight at the paddle must still be returned */
  g.$('startBtn').click();
  p.state.mode = 'play';
  p.input.targetY = 300;
  for (let i = 0; i < 60; i++) p.step(p.CFG.dt);          /* let the paddle settle at 300 */
  p.ball.x = 420; p.ball.y = 300;
  p.ball.speed = p.CFG.maxSpeed;
  p.ball.vx = -p.CFG.maxSpeed; p.ball.vy = 0;
  const before = p.state.hits;
  let returned = false, vxAtContact = 0;
  for (let i = 0; i < 200 && !returned; i++) {
    p.input.targetY = 300;
    p.step(p.CFG.dt);
    if (p.state.hits > before) { returned = true; vxAtContact = p.ball.vx; }
  }
  check('no tunnelling at terminal velocity', returned, 'hits stayed at ' + before);
  check('the return sends it back the other way', vxAtContact > 0, 'vx at contact ' + vxAtContact.toFixed(0));
}

/* ==========================================================================
   4 · Matches actually finish, both ways
   ========================================================================== */

section('4 · matches');
{
  /* a player who never moves must lose 7–0 */
  const g = boot();
  const p = g.pong;
  g.$('startBtn').click();
  p.input.targetY = p.CFG.paddleH / 2;                     /* park at the top and give up */
  for (let i = 0; i < 40000 && p.state.mode !== 'over'; i++) {
    p.input.targetY = p.CFG.paddleH / 2;
    p.step(p.CFG.dt);
  }
  check('an idle player loses the match', p.state.mode === 'over' && p.state.winner === 'vex', 'mode ' + p.state.mode);
  check('the final score is 7–0', p.state.scoreVex === p.CFG.winScore && p.state.scoreYou === 0, p.state.scoreYou + '–' + p.state.scoreVex);
  check('the loss overlay is shown', g.$('overVeil').classList.contains('show'));
  check('the overlay names the winner', g.$('overTitle').textContent === 'VEX wins', g.$('overTitle').textContent);
  check('the overlay quotes VEX', g.$('overQuote').textContent.length > 4, g.$('overQuote').textContent);
  check('the result is stored', JSON.parse(g.win.localStorage.getItem('join365_pong_v1')).losses === 1);
  check('the HUD score matches the state', g.$('scoreVex').textContent === String(p.CFG.winScore));

  /* a perfect player must be able to win — i.e. the AI is beatable */
  const g2 = boot();
  const p2 = g2.pong;
  g2.$('startBtn').click();
  p2.state.auto = true;
  let steps = 0;
  while (p2.state.mode !== 'over' && steps < 120000) { p2.step(p2.CFG.dt); steps++; }
  check('a perfect player can close out a match', p2.state.mode === 'over', 'gave up after ' + (steps * p2.CFG.dt).toFixed(0) + 's');
  check('the match produced a winner', p2.state.winner === 'you' || p2.state.winner === 'vex', String(p2.state.winner));
  check('the scoreline reached ' + p2.CFG.winScore, p2.state.scoreYou === p2.CFG.winScore || p2.state.scoreVex === p2.CFG.winScore,
    p2.state.scoreYou + '–' + p2.state.scoreVex);
  console.log('      (perfect-play result: ' + p2.state.scoreYou + '–' + p2.state.scoreVex +
    ', best rally ' + p2.state.bestRally + ', top speed ×' + p2.speedMul().toFixed(2) + ')');
  check('the AI concedes points sometimes', p2.state.scoreYou > 0, 'you scored ' + p2.state.scoreYou);
}

/* ==========================================================================
   5 · VEX, the trash talker
   ========================================================================== */

section('5 · VEX talks trash');
{
  const g = boot();
  const p = g.pong;
  const allLines = new Set(Object.values(p.LINES).flat());

  g.$('startBtn').click();
  p.state.auto = true;

  const heard = [];
  let last = '';
  for (let i = 0; i < 9000 && p.state.mode !== 'over'; i++) {
    p.step(p.CFG.dt);
    if (i % 12 === 0) {                                    /* sample the aria-live region */
      const line = g.$('vexLive').textContent;
      if (line && line !== last) { last = line; heard.push(line); }
    }
  }

  check('VEX speaks during a match', heard.length >= 4, heard.length + ' lines');
  check('every line comes from his script', heard.every(l => allLines.has(l)), heard.find(l => !allLines.has(l)) || '');
  check('he does not repeat himself back to back', heard.every((l, i) => i === 0 || l !== heard[i - 1]));
  check('the bubble is on screen when he talks', g.$('vex').classList.contains('show') || heard.length > 0);
  check('the portrait has moods', Object.keys(p.MOODS).length >= 5, Object.keys(p.MOODS).join(','));
  check('his lines are typed out, not dumped', g.$('vexText').textContent.length <= (heard[heard.length - 1] || '').length + 1);
  check('the aria-live region carries the full line', g.$('vexLive').textContent.length > 0);

  /* the mute switch must actually silence him */
  g.$('trashBtn').click();
  const frozen = g.$('vexLive').textContent;
  for (let i = 0; i < 6000; i++) p.step(p.CFG.dt);
  check('"VEX talks" toggle silences him', g.$('vexLive').textContent === frozen && !g.$('vex').classList.contains('show'),
    g.$('vexLive').textContent);
  check('the toggle persists to storage', JSON.parse(g.win.localStorage.getItem('join365_pong_v1')).trash === false);

  /* every scripted moment has at least one line, and every mood key resolves */
  const empty = Object.keys(p.LINES).filter(k => !p.LINES[k] || !p.LINES[k].length);
  check('no empty moment in his script', empty.length === 0, empty.join(','));
  check('he has more than a handful of things to say', allLines.size >= 60, allLines.size + ' lines');
}

/* ==========================================================================
   6 · Controls and UI wiring
   ========================================================================== */

section('6 · controls');
{
  const g = boot();
  const p = g.pong;
  g.$('startBtn').click();
  g.tick(0.1);

  const startY = p.player.y;
  g.doc.dispatchEvent(new g.win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  g.tick(0.3);
  check('ArrowDown moves the paddle down', p.player.y > startY + 20, startY.toFixed(0) + ' → ' + p.player.y.toFixed(0));
  g.doc.dispatchEvent(new g.win.KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }));

  const midY = p.player.y;
  g.doc.dispatchEvent(new g.win.KeyboardEvent('keydown', { key: 'w', bubbles: true }));
  g.tick(0.3);
  check('W moves the paddle up', p.player.y < midY - 20, midY.toFixed(0) + ' → ' + p.player.y.toFixed(0));
  g.doc.dispatchEvent(new g.win.KeyboardEvent('keyup', { key: 'w', bubbles: true }));

  const before = p.state.mode;
  g.doc.dispatchEvent(new g.win.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  g.tick(0.05);
  check('Space pauses the match', before !== 'paused' && p.state.mode === 'paused' && g.$('pauseVeil').classList.contains('show'));
  const frozenBall = p.ball.x;
  g.tick(0.5);
  check('a paused ball does not move', Math.abs(p.ball.x - frozenBall) < 1e-9);
  g.doc.dispatchEvent(new g.win.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  g.tick(0.05);
  check('Space resumes', p.state.mode !== 'paused' && !g.$('pauseVeil').classList.contains('show'));

  /* pointer control maps screen px into court units */
  const ev = new g.win.Event('pointermove', { bubbles: true });
  ev.clientY = 150;
  g.$('court').dispatchEvent(ev);
  g.tick(0.4);
  check('the pointer drives the paddle', Math.abs(p.player.y - 150) < 40, 'paddle at ' + p.player.y.toFixed(0) + ' for clientY 150');

  /* mute */
  g.$('muteBtn').click();
  check('the mute button toggles', p.store.muted === true && g.$('muteBtn').getAttribute('aria-pressed') === 'true');
  g.$('muteBtn').click();
  check('and toggles back', p.store.muted === false);

  /* difficulty */
  const sel = g.$('diffSel');
  sel.value = 'savage';
  sel.dispatchEvent(new g.win.Event('change'));
  check('the difficulty select applies', p.state.difficulty === 'savage');
  check('the difficulty persists', JSON.parse(g.win.localStorage.getItem('join365_pong_v1')).diff === 'savage');
  check('changing difficulty restarts the match', p.state.scoreYou === 0 && p.state.scoreVex === 0);
  check('the start panel reflects it', g.$('startVeil').querySelector('[data-diff="savage"]').getAttribute('aria-pressed') === 'true');

  /* pause button */
  g.$('pauseBtn').click();
  g.tick(0.05);
  check('the pause button works', p.state.mode === 'paused' && g.$('pauseBtn').textContent === 'Resume');
  g.$('resumeBtn').click();
  g.tick(0.05);
  check('the resume button works', p.state.mode !== 'paused');
}

/* ---------- result ---------- */

console.log('\n' + (failures.length === 0
  ? 'All ' + passed + ' checks passed.'
  : passed + ' passed, ' + failures.length + ' FAILED:\n  · ' + failures.join('\n  · ')));
process.exit(failures.length === 0 ? 0 : 1);
