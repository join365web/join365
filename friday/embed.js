#!/usr/bin/env node
/**
 * embed.js — keeps worker.js in sync with index.html.
 *
 * The Cloudflare Worker must be a single self-contained file (so you can
 * paste it straight into the Dashboard editor or `wrangler deploy` it with
 * zero build config). This script injects index.html into worker.js as a
 * JSON string between the BEGIN/END markers.
 *
 * Run it whenever you edit index.html:
 *   cd friday && node embed.js
 */
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
const workerPath = path.join(dir, "worker.js");
const worker = fs.readFileSync(workerPath, "utf8");

const BEGIN = "// ==== BEGIN EMBEDDED UI";
const END = "// ==== END EMBEDDED UI";
const re = new RegExp(
  "(" + BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[^\\n]*\\n)[\\s\\S]*?(" + END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")"
);

if (!re.test(worker)) {
  console.error("✗ markers not found in worker.js — make sure the BEGIN/END EMBEDDED UI block exists.");
  process.exit(1);
}

const line = `const INDEX_HTML = ${JSON.stringify(html)};`;
// function replacer: the HTML contains "$1"/"$&"/"$'" sequences that would
// otherwise be interpreted as replacement patterns — a function returns literal text.
const next = worker.replace(re, (m, g1, g2) => g1 + line + "\n" + g2);

if (next === worker) {
  console.log("✓ worker.js already up to date");
} else {
  fs.writeFileSync(workerPath, next);
  console.log(`✓ embedded index.html into worker.js (${(html.length / 1024).toFixed(1)} KB of UI)`);
}
