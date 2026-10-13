/**
 * Balance probe for Pong vs VEX.
 *
 *   cd Pong/tests && npm install && node balance.mjs
 *
 * Plays batches of full matches with three kinds of scripted human and prints
 * who wins. Not part of the pass/fail suite — it is here so the difficulty
 * numbers in ../index.html can be tuned against evidence instead of vibes.
 *
 *   rookie   → reacts late, chases the ball, aims sloppily
 *   decent   → quicker, still chases
 *   good     → leads the ball, steady aim
 *   sharp    → near-professional reads
 *   keyboard → leads the ball but can only sweep at 620 px/s
 *   perfect  → paddle welded to the ball (the upper bound)
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const HTML = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

class FakeParam { setValueAtTime() {} linearRampToValueAtTime() {} exponentialRampToValueAtTime() {} }
class FakeAudioContext {
  constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; }
  createOscillator() { return { type: 'square', frequency: new FakeParam(), connect() {}, start() {}, stop() {} }; }
  createGain() { return { gain: new FakeParam(), connect() {} }; }
  resume() {}
}

function boot() {
  const vc = new VirtualConsole();
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously',
    virtualConsole: vc,
    url: 'https://join365.eu.cc/Pong/',
    beforeParse(win) {
      win.HTMLCanvasElement.prototype.getContext = function () {
        const store = {};
        return new Proxy({
          canvas: this,
          createLinearGradient() { return { addColorStop() {} }; },
          measureText() { return { width: 10 }; }
        }, {
          get(t, p) { if (p in t) return t[p]; if (p in store) return store[p]; return function () {}; },
          set(t, p, v) { store[p] = v; return true; }
        });
      };
      win.AudioContext = FakeAudioContext;
      win.requestAnimationFrame = () => 1;
      win.HTMLCanvasElement.prototype.getBoundingClientRect = () =>
        ({ width: 960, height: 600, top: 0, left: 0, right: 960, bottom: 600, x: 0, y: 0, toJSON() {} });
    }
  });
  return dom.window.__PONG__;
}

/* A human-like paddle: reaction latency, aim noise, and — for the better
   presets — leading the ball instead of chasing where it currently is. */
function humanBot(skill) {
  /* latency = reaction time (s), noise = aim sloppiness (px),
     predict = does the player lead the ball, recenter = how hard they
     drift back to the middle between shots, speed = paddle sweep speed. */
  const presets = {
    rookie:  { latency: 0.26, noise: 70, predict: false, recenter: 0.35, speed: 1150 },
    decent:  { latency: 0.18, noise: 42, predict: false, recenter: 0.60, speed: 1150 },
    good:    { latency: 0.13, noise: 30, predict: true,  recenter: 0.85, speed: 1150 },
    sharp:   { latency: 0.08, noise: 14, predict: true,  recenter: 1.00, speed: 1150 },
    keyboard:{ latency: 0.20, noise: 34, predict: true,  recenter: 0.70, speed: 620  },
    perfect: { latency: 0.0,  noise: 0,  predict: true,  recenter: 1.00, speed: 1150 }
  };
  const p = presets[skill];
  let seen = { x: 0, y: 0 };
  const pending = [];

  return function (pong, dt) {
    const b = pong.ball;
    if (b.x !== seen.x || b.y !== seen.y) {
      seen = { x: b.x, y: b.y };
      let aim;
      if (b.vx < 0) {                                   /* coming at us */
        if (p.predict) {
          const plane = pong.player.x + pong.CFG.paddleW + pong.CFG.ballR;
          const t = Math.max(0, (plane - b.x) / b.vx);
          aim = pong.predictY(b.y, b.vy, t);
        } else {
          aim = b.y;                                    /* chase, don't lead */
        }
      } else {
        aim = pong.CFG.H / 2 + (b.y - pong.CFG.H / 2) * (1 - p.recenter);
      }
      aim += (Math.random() * 2 - 1) * p.noise;
      pending.push({ at: pong.state.time + p.latency, y: aim });
    }
    while (pending.length && pending[0].at <= pong.state.time) {
      const next = pending.shift();
      pong.input.pointer = false;
      pong.input.up = false;
      pong.input.down = false;
      pong.input.targetY = next.y;
    }
    if (p.speed < pong.CFG.playerSpeed) {               /* slow keyboard hands */
      const d = pong.input.targetY - pong.player.y;
      const maxStep = p.speed * dt;
      pong.input.targetY = pong.player.y + Math.max(-maxStep, Math.min(maxStep, d));
    }
  };
}

function playMatch(difficulty, skill) {
  const pong = boot();
  pong.setDifficulty(difficulty);
  pong.startMatch();
  const drive = humanBot(skill);
  let steps = 0;
  const limit = Math.round(1800 / pong.CFG.dt);
  while (pong.state.mode !== 'over' && steps < limit) {
    drive(pong, pong.CFG.dt);
    pong.step(pong.CFG.dt);
    steps++;
  }
  return {
    winner: pong.state.winner,
    score: pong.state.scoreYou + '–' + pong.state.scoreVex,
    seconds: steps * pong.CFG.dt,
    rally: pong.state.bestRally,
    speed: pong.state.topSpeed / (pong.CFG.baseSpeed * pong.DIFF[difficulty].serve)
  };
}

const MATCHES = Number(process.argv[2] || 12);
console.log('playing ' + MATCHES + ' matches per cell…\n');
console.log('difficulty   skill      you win   avg score   avg len   best rally   top speed');
for (const diff of ['chill', 'normal', 'savage']) {
  for (const skill of ['rookie', 'decent', 'good', 'sharp', 'keyboard', 'perfect']) {
    let wins = 0, sec = 0, rally = 0, speed = 0, last = '';
    const scores = [];
    for (let i = 0; i < MATCHES; i++) {
      const m = playMatch(diff, skill);
      if (m.winner === 'you') wins++;
      sec += m.seconds; rally = Math.max(rally, m.rally); speed = Math.max(speed, m.speed);
      scores.push(m.score);
      last = m.score;
    }
    const avgYou = scores.reduce((a, s) => a + Number(s.split('–')[0]), 0) / scores.length;
    const avgVex = scores.reduce((a, s) => a + Number(s.split('–')[1]), 0) / scores.length;
    console.log(
      diff.padEnd(12) + skill.padEnd(10) +
      ((wins / MATCHES * 100).toFixed(0) + '%').padStart(6) + '   ' +
      (avgYou.toFixed(1) + '–' + avgVex.toFixed(1)).padStart(9) +
      ((sec / MATCHES).toFixed(0) + 's').padStart(9) +
      String(rally).padStart(12) +
      ('×' + speed.toFixed(2)).padStart(12)
    );
  }
}
