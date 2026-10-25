// Scores the chord estimator against time-aligned reference annotations (Isophonics .lab files).
//
//   node test/eval.mjs                   table for both key settings
//   node test/eval.mjs --key=oracle      only with the annotated key as hint (≈ Mix key in the client)
//   node test/eval.mjs --param x=1 ...   override estimator params (see __bpmKey.params)
//   node test/eval.mjs --json            machine-readable summary
//
// Metrics (frame-based, 10 ms, duration-weighted like MIREX WCSR):
//   majmin  root + major/minor quality must match; N must match N.
//           Reference chords outside maj/min (sus, dim, aug, power chords…) are excluded from scoring.
//   root    root must match (any quality); N must match N.
// Keys (frames inside "Key" annotations; modes map to major/minor, e.g. mixolydian → major):
//   global  the one track key the estimator was given; local  localKeys() regions
// Spotify versions differ from the annotated CDs by a few seconds of lead-in, so each song is scored at
// the best global offset within ±3 s (reported). This makes scores slightly optimistic.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { loadExtension } from "./load.mjs";

const DIR = new URL("./fixtures/", import.meta.url);
const FRAME = 0.01;
const MAX_OFFSET = 3;
const OFFSET_STEP = 0.05;

const args = process.argv.slice(2);
const keyModes = (args.find((a) => a.startsWith("--key="))?.slice(6) ?? "analysis,oracle").split(",");
const asJson = args.includes("--json");
const overrides = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "--param") continue;
  const [k, v] = args[++i].split("=");
  overrides[k] = Number(v);
}

const NAMES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const rootOf = (s) => {
  const m = s.match(/^([A-G])([#b]*)/);
  if (!m) return null;
  let pc = NAMES[m[1]];
  for (const ch of m[2]) pc += ch === "#" ? 1 : -1;
  return (pc + 12) % 12;
};
const MAJOR = new Set(["", "maj", "7", "maj7", "maj6", "9", "maj9", "6", "11", "13"]);
const MINOR = new Set(["min", "min7", "min6", "minmaj7", "min9", "min11", "min13"]);

// → { root, quality: "maj"|"min"|null (outside vocabulary) } or null for N
function parseChord(label) {
  if (label === "N" || label === "X") return label === "N" ? null : { root: null, quality: null };
  const [rootPart, rest = ""] = label.split(":");
  const quality = rest.split("/")[0];
  const root = rootOf(rootPart);
  if (quality.startsWith("(")) return { root, quality: null };
  return { root, quality: MAJOR.has(quality) ? "maj" : MINOR.has(quality) ? "min" : null };
}

const readLab = (file) =>
  readFileSync(new URL(file, DIR), "utf8")
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .map(([s, e, ...label]) => [Number(s), Number(e), label.join(" ")]);

// Some Isophonics key annotations contradict their own chord annotations (Here Comes the Sun as A minor,
// Ob-La-Di in B and Across the Universe in D while the chords are in A, B♭ and D♭); songs.json marks
// them "keyLab": "wrong" and they get no key hint or key score.
const songs = JSON.parse(readFileSync(new URL("songs.json", DIR), "utf8"));
const wrongKeyLab = new Set(songs.filter((s) => s.keyLab === "wrong").map((s) => s.slug));
const keyLabOk = (slug) => !wrongKeyLab.has(slug) && existsSync(new URL(`${slug}.key.lab`, DIR));

// Annotated key with the longest total duration → { tonic, minor }; null without a key annotation
function oracleKey(slug) {
  if (!keyLabOk(slug)) return null;
  const time = new Map();
  for (const [s, e, label] of readLab(`${slug}.key.lab`)) {
    if (!label.startsWith("Key")) continue;
    const name = label.split(/\s+/)[1];
    time.set(name, (time.get(name) ?? 0) + e - s);
  }
  const [name] = [...time].sort((a, b) => b[1] - a[1])[0];
  const [tonicName, mode = "major"] = name.split(":");
  return { tonic: rootOf(tonicName), minor: mode === "minor" || mode === "dorian" || mode === "aeolian", src: "oracle" };
}

// Key annotation → [[start, end, tonic, minor]] (Silence dropped)
const MINOR_MODES = new Set(["minor", "dorian", "aeolian", "phrygian"]);
function refKeys(slug) {
  if (!keyLabOk(slug)) return null;
  return readLab(`${slug}.key.lab`)
    .filter(([, , label]) => label.startsWith("Key"))
    .map(([s, e, label]) => {
      const [tonicName, mode = "major"] = label.split(/\s+/)[1].split(":");
      return [s, e, rootOf(tonicName), MINOR_MODES.has(mode)];
    });
}
// Fraction of annotated key time where the estimated key (tonic + mode) matches
function scoreKeys(ref, est, offset) {
  let total = 0;
  let hit = 0;
  for (const [s, e, tonic, minor] of ref) {
    for (let t = s; t < e; t += 0.1) {
      const k = est.find(([es, ee]) => t >= es + offset && t < ee + offset) ?? est[est.length - 1];
      total++;
      if (k && k[2] === tonic && k[3] === minor) hit++;
    }
  }
  return { total, hit };
}

// Sample a span list at fixed frames: returns Int16Array of chord indexes (-1 = N, -2 = unscored)
function sampleRef(lab, frames) {
  const out = new Int16Array(frames).fill(-1);
  for (const [s, e, label] of lab) {
    const c = parseChord(label);
    const value = c === null ? -1 : c.quality === null || c.root === null ? -2 : c.root * 2 + (c.quality === "min" ? 1 : 0);
    for (let f = Math.max(0, Math.round(s / FRAME)); f < Math.min(frames, Math.round(e / FRAME)); f++) out[f] = value;
  }
  return out;
}
function sampleEst(spans, frames, offset) {
  const out = new Int16Array(frames).fill(-1);
  for (const [s, e, chord] of spans) {
    for (let f = Math.max(0, Math.round((s + offset) / FRAME)); f < Math.min(frames, Math.round((e + offset) / FRAME)); f++) out[f] = chord;
  }
  return out;
}
function score(ref, est) {
  let scored = 0;
  let majmin = 0;
  let root = 0;
  for (let f = 0; f < ref.length; f++) {
    const r = ref[f];
    if (r === -2) continue;
    scored++;
    const e = est[f];
    if (r === e) majmin++;
    if (r === -1 ? e === -1 : e >= 0 && r >> 1 === e >> 1) root++;
  }
  return { scored, majmin, root };
}

const ext = loadExtension();
Object.assign(ext.params ?? {}, overrides);

// "tune" songs were used to choose PARAMS; "holdout" songs were not, so they show how well tuning generalizes.
// "user" fixtures come from your corrections (scripts/export-fixtures.mjs --corrections).
const listed = Object.fromEntries(songs.map((s) => [s.slug, s.split ?? "tune"]));
const splitOf = new Proxy(listed, { get: (o, slug) => o[slug] ?? (String(slug).startsWith("user-") ? "user" : "tune") });
const onlySplit = args.find((a) => a.startsWith("--split="))?.slice(8);
const slugs = readdirSync(DIR)
  .filter((f) => f.endsWith(".analysis.json"))
  .map((f) => f.replace(".analysis.json", ""))
  .filter((slug) => !onlySplit || splitOf[slug] === onlySplit)
  .sort((a, b) => (splitOf[a] ?? "").localeCompare(splitOf[b] ?? "") * -1 || a.localeCompare(b));

const summary = {};
for (const mode of keyModes) {
  const rows = [];
  const totals = {};
  for (const slug of slugs) {
    const { analysis } = JSON.parse(readFileSync(new URL(`${slug}.analysis.json`, DIR), "utf8"));
    const lab = readLab(`${slug}.lab`);
    const res = ext.analyzeChords(analysis, mode === "oracle" ? oracleKey(slug) : null);
    const frames = Math.ceil(lab.at(-1)[1] / FRAME);
    const ref = sampleRef(lab, frames);
    let best = null;
    for (let off = -MAX_OFFSET; off <= MAX_OFFSET + 1e-9; off += OFFSET_STEP) {
      const s = score(ref, sampleEst(res.spans, frames, off));
      if (!best || s.majmin > best.majmin) best = { ...s, offset: off };
    }
    const split = splitOf[slug] ?? "tune";
    const keys = refKeys(slug);
    const global = keys && scoreKeys(keys, [[0, Infinity, res.tonic, res.minor]], 0);
    const local = keys && scoreKeys(keys, ext.keyRegions(res), best.offset);
    for (const key of [split, "all"]) {
      totals[key] ??= { scored: 0, majmin: 0, root: 0, keyTotal: 0, keyGlobal: 0, keyLocal: 0 };
      for (const k of ["scored", "majmin", "root"]) totals[key][k] += best[k];
      if (!keys) continue;
      totals[key].keyTotal += global.total;
      totals[key].keyGlobal += global.hit;
      totals[key].keyLocal += local.hit;
    }
    rows.push({
      slug,
      split,
      majmin: best.majmin / best.scored,
      root: best.root / best.scored,
      offset: best.offset,
      keyGlobal: keys ? global.hit / global.total : null,
      keyLocal: keys ? local.hit / local.total : null,
    });
  }
  const ratio = (t) => ({
    majmin: t.majmin / t.scored,
    root: t.root / t.scored,
    keyGlobal: t.keyGlobal / t.keyTotal,
    keyLocal: t.keyLocal / t.keyTotal,
  });
  summary[mode] = {
    ...ratio(totals.all),
    splits: Object.fromEntries(Object.entries(totals).map(([k, t]) => [k, ratio(t)])),
    songs: rows,
  };
}

if (asJson) {
  console.log(JSON.stringify({ params: ext.params, summary }, null, 2));
} else {
  const pct = (x) => (x == null ? "     –" : `${(x * 100).toFixed(1)}%`.padStart(6));
  const W = 30;
  for (const [mode, { splits, songs }] of Object.entries(summary)) {
    console.log(`\nkey hint: ${mode === "oracle" ? "annotated key (≈ Mix key)" : "Spotify audio-analysis key"}`);
    console.log("song".padEnd(W), "majmin", "  root", "offset", " key:global", "local");
    let prev = null;
    for (const r of songs) {
      if (r.split !== prev) console.log(`[${r.split}]`);
      prev = r.split;
      console.log(`  ${r.slug}`.padEnd(W), pct(r.majmin), pct(r.root), `${r.offset >= 0 ? "+" : ""}${r.offset.toFixed(2)}s`.padStart(6), "    ", pct(r.keyGlobal), pct(r.keyLocal));
    }
    for (const [split, t] of Object.entries(splits)) console.log(`TOTAL ${split}`.padEnd(W), pct(t.majmin), pct(t.root), "      ", "    ", pct(t.keyGlobal), pct(t.keyLocal));
  }
  if (ext.params) console.log("\nparams", JSON.stringify(ext.params));
}
