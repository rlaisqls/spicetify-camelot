import { test } from "node:test";
import assert from "node:assert/strict";
import { loadExtension } from "./load.mjs";

const k = loadExtension();
// Values from the extension live in another VM realm; compare them as plain data
const plain = (x) => JSON.parse(JSON.stringify(x));
// Chord index = root * 2 + (minor ? 1 : 0)
const maj = (root) => root * 2;
const min = (root) => root * 2 + 1;
const [C, D, E, F, G, A, B] = [0, 2, 4, 5, 7, 9, 11];

// Billie Jean-like loop: F♯m G♯m A G♯m over an F♯ pedal, with random noise, 117 BPM
function syntheticAnalysis({ loudness = -8 } = {}) {
  let seed = 1;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const prog = [[6, 9, 1], [8, 11, 3], [9, 1, 4], [8, 11, 3]];
  const bar = (60 / 117) * 4;
  const bars = [];
  const segments = [];
  for (let b = 0; b < 32; b++) {
    bars.push({ start: b * bar, duration: bar });
    for (let s = 0; s < 8; s++) {
      const pitches = Array.from({ length: 12 }, () => rnd() * 0.35);
      prog[b % 4].forEach((pc) => (pitches[pc] = 0.7 + rnd() * 0.3));
      pitches[6] = Math.max(pitches[6], 0.8);
      segments.push({ start: b * bar + (s * bar) / 8, duration: bar / 8, loudness_max: loudness, pitches });
    }
  }
  return { track: { key: 11, mode: 0 }, bars, segments, sections: [{ start: 0, key: 6, mode: 0, key_confidence: 0.6 }] };
}

test("estimates a repeating progression", () => {
  const res = k.analyzeChords(syntheticAnalysis(), { tonic: 6, minor: true, src: "test" });
  assert.deepEqual(plain(res.spans.slice(0, 4).map((s) => k.chordName(s[2]))), ["F♯m", "G♯m", "A", "G♯m"]);
  const [top] = k.topProgressions(res.spans);
  assert.deepEqual(plain(top.chords.map(k.chordName)), ["F♯m", "G♯m", "A", "G♯m"]);
});

test("silence gives no chord", () => {
  const res = k.analyzeChords(syntheticAnalysis({ loudness: -60 }), null);
  assert.deepEqual(plain(res.spans.map((s) => s[2])), [-1]);
});

test("harmonic functions in C major and A minor", () => {
  assert.equal(k.functionOf(maj(C), C, false), "T");
  assert.equal(k.functionOf(min(A), C, false), "T");
  assert.equal(k.functionOf(maj(F), C, false), "S");
  assert.equal(k.functionOf(maj(G), C, false), "D");
  assert.equal(k.functionOf(min(A), A, true), "T");
  assert.equal(k.functionOf(min(D), A, true), "S");
  assert.equal(k.functionOf(maj(E), A, true), "D");
  assert.equal(k.functionOf(maj(D), C, false), null);
});

test("explains non-diatonic chords", () => {
  const ex = (chord, next, tonic = C, minor = false) => k.explainChord(chord, next, tonic, minor);
  assert.equal(ex(maj(D), maj(G)).label, "V/V");
  assert.match(ex(maj(D), maj(G)).note, /resolves to G/);
  assert.equal(ex(maj(E), min(A)).label, "V/vi");
  assert.equal(ex(maj(A), min(D)).label, "V/ii");
  assert.equal(ex(maj(10), maj(C)).kind, "borrowed"); // B♭ in C: ♭VII
  assert.equal(ex(min(F), maj(C)).kind, "borrowed"); // iv
  assert.equal(ex(maj(8), maj(C)).kind, "borrowed"); // ♭VI
  assert.match(ex(maj(1), maj(G)).note, /Neapolitan/); // D♭ in C
  assert.equal(ex(maj(6), maj(C)).kind, "chromatic"); // F♯ major in C
  // D major in A minor: Dorian IV unless it actually resolves like V/VII
  assert.match(ex(maj(D), min(A), A, true).note, /Dorian IV/);
  assert.equal(ex(maj(D), maj(G), A, true).label, "V/VII");
  assert.equal(ex(maj(E), min(A), A, true).fn, "D");
});

test("spells chords for the key", () => {
  assert.equal(k.spellChord(maj(3), C, false), "E♭"); // ♭III in C, not D♯
  assert.equal(k.spellChord(maj(1), C, false), "D♭"); // Neapolitan
  assert.equal(k.spellChord(maj(6), C, false), "F♯");
  assert.equal(k.spellChord(min(1), E, false), "C♯m"); // vi in E
  assert.equal(k.spellChord(maj(3), 10, false), "E♭"); // IV in B♭
  assert.equal(k.spellChord(min(10), F, false), "B♭m"); // iv in F
  assert.equal(k.spellChord(-1, C, false), "N");
});

test("finds cadences", () => {
  const spans = [
    [0, 2, maj(G)],
    [2, 4, maj(C)],
    [4, 6, maj(F)],
    [6, 8, maj(C)],
    [8, 10, maj(G)],
    [10, 12, min(A)],
    [12, 14, maj(F)],
    [14, 16, maj(G)],
  ];
  const sections = [[0, C, false, 1], [16, C, false, 1]];
  const types = k.findCadences(spans, C, false, sections).map((c) => `${c.start}:${c.type}`);
  assert.deepEqual(plain(types), ["0:authentic", "4:plagal", "8:deceptive", "14:half"]);
});

test("modal color hints", () => {
  const dorian = [[0, 8, min(6)], [8, 12, min(8)], [12, 16, maj(9)]]; // F♯m G♯m A in F♯ minor
  assert.ok(k.flavorHints(dorian, 6, true).some((h) => /Dorian/.test(h)));
  const mixo = [[0, 8, maj(D)], [8, 12, maj(C)], [12, 16, maj(G)]]; // D C G in D major
  assert.ok(k.flavorHints(mixo, D, false).some((h) => /Mixolydian/.test(h)));
});

test("corrections override spans by time and export as .lab", () => {
  const spans = [
    [0, 2, maj(C), 0.9],
    [2, 4, maj(G), 0.3],
    [4, 6, maj(G), 0.8],
  ];
  const fixed = k.applyCorrections(spans, [[2, 4, min(A)]]);
  assert.deepEqual(plain(fixed.map((s) => s[2])), [maj(C), min(A), maj(G)]);
  assert.equal(fixed[1][4], true);
  assert.equal(k.toLab(fixed), "0.000 2.000 C\n2.000 4.000 A:min\n4.000 6.000 G");
  assert.equal(k.toLab([[0, 1, -1], [1, 3, maj(1)], [3, 4, -2]]), "0.000 1.000 N\n1.000 3.000 C#\n3.000 4.000 X");
});
