// Downloads Spotify audio-analysis for every song in test/fixtures/songs.json through the running client.
// Usage: node scripts/export-fixtures.mjs [slug...]   (existing fixtures are skipped unless named)
//        node scripts/export-fixtures.mjs --corrections
//          turns chords you corrected on the harmony page into fixtures (user-<trackId>.lab + analysis);
//          only corrected ranges are scored, the rest of the track is marked X (unscored).

import { readFile, writeFile, access } from "node:fs/promises";
import { connect } from "./cdp.mjs";
import { loadExtension } from "../test/load.mjs";

const dir = new URL("../test/fixtures/", import.meta.url);
const songs = JSON.parse(await readFile(new URL("songs.json", dir), "utf8"));
const only = process.argv.slice(2);
const MAX_DURATION_DIFF = 5; // seconds; remasters differ slightly in lead-in/fade

const labDuration = async (slug) => {
  const lines = (await readFile(new URL(`${slug}.lab`, dir), "utf8")).trim().split("\n");
  return Number(lines.at(-1).split(/\s+/)[1]);
};
const exists = (url) =>
  access(url).then(
    () => true,
    () => false
  );

// Runs in the Spotify page: search tracks and return compact candidates
const searchExpr = (query) => `(async () => {
  const G = Spicetify.GraphQL;
  const res = await G.Request(G.Definitions.searchModalResults, {
    searchTerm: ${JSON.stringify(query)}, offset: 0, limit: 10, numberOfTopResults: 10,
    includeAudiobooks: false, includeArtistHasConcertsField: false, includePreReleases: false,
    includeLocalConcertsField: false, includeAuthors: false,
  });
  const out = new Map();
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (o.__typename === "Track" && typeof o.uri === "string" && o.name) {
      out.set(o.uri, { id: o.uri.split(":")[2], name: o.name,
        artists: (o.artists?.items ?? []).map((a) => a.profile?.name).join(", ") });
    }
    Object.values(o).forEach(walk);
  };
  walk(res);
  return [...out.values()];
})()`;

// Runs in the Spotify page: fetch analysis and keep only what the chord estimator uses
const analysisExpr = (id) => `(async () => {
  const urls = ["https://spclient.wg.spotify.com/audio-attributes/v1/audio-analysis/${id}?format=json",
                "https://api.spotify.com/v1/audio-analysis/${id}"];
  for (const url of urls) {
    try {
      const d = await Spicetify.CosmosAsync.get(url);
      if (!d?.segments?.length) continue;
      const r = (x) => Math.round(x * 100000) / 100000;
      return {
        track: { duration: d.track.duration, tempo: d.track.tempo, key: d.track.key, mode: d.track.mode,
                 key_confidence: d.track.key_confidence, mode_confidence: d.track.mode_confidence },
        bars: d.bars.map((b) => ({ start: r(b.start), duration: r(b.duration), confidence: b.confidence })),
        beats: d.beats.map((b) => ({ start: r(b.start), duration: r(b.duration), confidence: b.confidence })),
        sections: d.sections.map((s) => ({ start: r(s.start), duration: r(s.duration), key: s.key, mode: s.mode,
                 key_confidence: s.key_confidence, mode_confidence: s.mode_confidence, tempo: s.tempo })),
        segments: d.segments.map((s) => ({ start: r(s.start), duration: r(s.duration), confidence: s.confidence,
                 loudness_max: s.loudness_max, pitches: s.pitches })),
      };
    } catch (e) {}
  }
  return null;
})()`;

const norm = (s) => s.toLowerCase().replace(/ - .*$/, "").replace(/[^a-z0-9]/g, "");

const cdp = await connect();

async function exportCorrections() {
  const all = JSON.parse((await cdp.evaluate(`localStorage.getItem("bpm-key:corrections:v1") ?? "{}"`)) || "{}");
  const { toLab } = loadExtension();
  for (const [id, fixes] of Object.entries(all)) {
    if (!fixes?.length) continue;
    const analysis = await cdp.evaluate(analysisExpr(id));
    if (!analysis) {
      console.warn(`✗ ${id}: no analysis`);
      continue;
    }
    // Corrected ranges keep their chord; everything else is X so it is left out of scoring
    const spans = [];
    let t = 0;
    for (const [s, e, chord] of [...fixes].sort((a, b) => a[0] - b[0])) {
      if (s > t) spans.push([t, s, -2]);
      spans.push([s, e, chord]);
      t = Math.max(t, e);
    }
    if (analysis.track.duration > t) spans.push([t, analysis.track.duration, -2]);
    await writeFile(new URL(`user-${id}.lab`, dir), toLab(spans) + "\n");
    await writeFile(new URL(`user-${id}.analysis.json`, dir), JSON.stringify({ id, name: id, artists: "", analysis }));
    console.log(`✓ user-${id}: ${fixes.length} corrected ranges`);
  }
}

try {
  if (process.argv.includes("--corrections")) {
    await exportCorrections();
    process.exit(0);
  }
  for (const song of songs) {
    const out = new URL(`${song.slug}.analysis.json`, dir);
    if (only.length ? !only.includes(song.slug) : await exists(out)) continue;
    const target = (await labDuration(song.slug)) * 1000;
    const candidates = (await cdp.evaluate(searchExpr(song.query))).filter(
      (c) => norm(c.name) === norm(song.title) && /beatles/i.test(c.artists)
    );
    if (!candidates.length) {
      console.warn(`✗ ${song.slug}: no matching track`);
      continue;
    }
    // Search results don't carry durations, so verify the version via the analysis length instead
    let saved = false;
    for (const pick of candidates) {
      const analysis = await cdp.evaluate(analysisExpr(pick.id));
      const diff = analysis ? analysis.track.duration - target / 1000 : Infinity;
      if (Math.abs(diff) > MAX_DURATION_DIFF) continue;
      await writeFile(out, JSON.stringify({ id: pick.id, name: pick.name, artists: pick.artists, analysis }));
      console.log(`✓ ${song.slug}: ${pick.name} (${pick.id}, ${diff >= 0 ? "+" : ""}${diff.toFixed(1)}s vs lab)`);
      saved = true;
      break;
    }
    if (!saved) console.warn(`✗ ${song.slug}: no candidate within ${MAX_DURATION_DIFF}s of the annotation`);
  }
} finally {
  cdp.close();
}
