// NAME: Camelot
// DESCRIPTION: Shows BPM, key and Camelot notation on every track row and the now-playing bar.

(function bpmKey() {
  if (!Spicetify?.CosmosAsync || !Spicetify?.Player || !Spicetify?.URI || !document.body) {
    setTimeout(bpmKey, 300);
    return;
  }

  const TAG = "[bpm-key]";
  const CACHE_KEY = "bpm-key:cache:v2";
  const STRATEGY_KEY = "bpm-key:strategy:v3";
  const MIX_AUDIO_ATTRIBUTES_V2 = 222; // extension kind: BPM, key and Camelot used by the Mix UI
  const CACHE_LIMIT = 20000;
  const CONCURRENCY = 4;
  const RETRY_AFTER_MS = 60_000;
  const PITCHES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  // Camelot wheel number by pitch class (B for major, A for minor)
  const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
  const CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
  const CHORD_CACHE_KEY = "bpm-key:chords:v2"; // bump when the estimator changes
  const CHORD_CACHE_LIMIT = 100;
  // Chord estimator tuning, chosen on the plateau (not the peak) of `node test/eval.mjs` sweeps.
  // Baseline before tuning: majmin 65.9%; with these values: 76.6% (Spotify key hint).
  const PARAMS = {
    keyPrior: 0.05, // bonus for chords diatonic to the track key
    switchPenalty: 0.1, // Viterbi cost of changing chords between windows
    silenceAmp: 0.01, // ≈ -40 dB; quieter windows get no chord
    windowsPerBar: 2, // analysis windows per bar
    flatPower: 2, // weight segments by (1 - mean chroma)^flatPower; flat chroma ≈ drums/noise
    thirdWeight: 0.7, // template weight of the third (root = 1)
    fifthWeight: 0.8, // template weight of the fifth
    repContext: 4, // repetition smoothing: windows on each side compared between candidates
    repTopK: 8, // number of most similar repetitions averaged in (0 = off)
    repThreshold: 0.5, // minimum context similarity for a repetition
    repWeight: 2, // weight of the averaged repetitions relative to the window itself
    // Local keys (Viterbi over chords, in seconds of chord time)
    keySwitch: 12, // cost of a modulation: the new key must fit ~this many seconds better
    keyHintBonus: 0.1, // per-second bonus for a Mix track key (audio-analysis keys are too often wrong to favor)
    // Fit per second of chord time: diatonic = 1, anything else not listed = -1
    keyTonicFit: 2, // the tonic triad
    keyBorrowedFit: 0.3, // common borrowed chords (♭VII, iv…)
    keySecondaryFit: -0.3, // secondary dominants (V/x of a diatonic chord)
  };
  const LOW_CONFIDENCE = 0.4;

  // ---- data sources ----

  // Cache entry: { t: BPM, n: note name, minor, c: Camelot, col: Camelot color }

  // Accepts both the audio-features shape ({tempo,key,mode}) and the audio-analysis shape ({track:{...}})
  const extract = (data) => {
    const src = data?.track ?? data;
    if (typeof src?.tempo !== "number" || src.tempo <= 0) return null;
    const valid = src.key >= 0 && src.key <= 11;
    const minor = src.mode === 0;
    return {
      t: Math.round(src.tempo * 10) / 10,
      n: valid ? PITCHES[src.key] : null,
      minor,
      c: valid ? (minor ? `${CAMELOT_MINOR[src.key]}A` : `${CAMELOT_MAJOR[src.key]}B`) : null,
    };
  };

  // AUDIO_ATTRIBUTES_V2 shape ({bpm, key:{key:"F#", mode, camelotKey:{value,color}}})
  const extractV2 = (data) => {
    if (typeof data?.bpm !== "number" || data.bpm <= 0) return null;
    const camelot = data.key?.camelotKey?.value ?? null;
    return {
      t: data.bpm,
      n: data.key?.key ? data.key.key.replace("#", "♯").replace(/b$/, "♭") : null,
      // The numeric mode values are undocumented, so trust Camelot's A (minor) / B (major)
      minor: camelot ? camelot.endsWith("A") : data.key?.mode === 1,
      c: camelot,
      col: data.key?.camelotKey?.color ?? null,
    };
  };

  const pick = (obj, key) => (obj instanceof Map ? obj.get(key) : obj?.[key]);

  const getJSON = async (url) => {
    const data = await Spicetify.CosmosAsync.get(url);
    // CosmosAsync sometimes returns {error:{status,message}} instead of throwing
    if (data?.error) throw Object.assign(new Error(data.error.message ?? "error"), { status: data.error.status });
    return data;
  };

  const strategies = {
    "mix-attributes-v2": {
      batch: 50,
      async fetch(ids) {
        const meta = Spicetify.Platform?.PlaylistMixingAPI?._metadataExtensionsAPI;
        if (typeof meta?.fetch !== "function") throw new Error("PlaylistMixingAPI unavailable");
        const uris = ids.map((id) => `spotify:track:${id}`);
        // Takes fetch([uri, kind, ...], [uri, kind, ...], ...)
        const res = await meta.fetch(...uris.map((uri) => [uri, MIX_AUDIO_ATTRIBUTES_V2]));
        const feats = uris.map((uri) => extractV2(pick(pick(res, uri), MIX_AUDIO_ATTRIBUTES_V2)));
        // Fill only the tracks missing from V2 with legacy audio-features
        const missing = ids.filter((_, i) => !feats[i]);
        if (missing.length) {
          try {
            const legacy = await strategies["spclient-features-batch"].fetch(missing);
            missing.forEach((id, j) => {
              if (legacy[j]) feats[ids.indexOf(id)] = { ...legacy[j], src: "spclient-features-batch" };
            });
          } catch {}
        }
        return feats.map((f) => (f && !f.src ? { ...f, src: "mix-attributes-v2" } : f));
      },
    },
    "web-features": {
      batch: 100,
      async fetch(ids) {
        const data = await getJSON(`https://api.spotify.com/v1/audio-features?ids=${ids.join(",")}`);
        if (!Array.isArray(data?.audio_features)) throw new Error("missing audio_features");
        return ids.map((_, i) => extract(data.audio_features[i]));
      },
    },
    "spclient-features-batch": {
      batch: 100,
      async fetch(ids) {
        const data = await getJSON(
          `https://spclient.wg.spotify.com/audio-attributes/v1/audio-features?ids=${ids.join(",")}&format=json`
        );
        if (!Array.isArray(data?.audio_features)) throw new Error("missing audio_features");
        return ids.map((_, i) => extract(data.audio_features[i]));
      },
    },
    "spclient-features": {
      batch: 1,
      fetch: async ([id]) => [
        extract(await getJSON(`https://spclient.wg.spotify.com/audio-attributes/v1/audio-features/${id}?format=json`)),
      ],
    },
    "web-analysis": {
      batch: 1,
      fetch: async ([id]) => [extract(await getJSON(`https://api.spotify.com/v1/audio-analysis/${id}`))],
    },
    "spclient-analysis": {
      batch: 1,
      fetch: async ([id]) => [
        extract(await getJSON(`https://spclient.wg.spotify.com/audio-attributes/v1/audio-analysis/${id}?format=json`)),
      ],
    },
    "spicetify-audio-data": {
      batch: 1,
      async fetch([id]) {
        if (typeof Spicetify.getAudioData !== "function") throw new Error("getAudioData unavailable");
        return [extract(await Spicetify.getAudioData(`spotify:track:${id}`))];
      },
    },
  };
  const ORDER = Object.keys(strategies);

  // ---- cache ----

  const cache = new Map(); // id → cache entry | null (no data for the track)
  try {
    for (const [id, v] of Object.entries(JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}"))) cache.set(id, v);
  } catch {}

  let persistTimer;
  const persist = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(cache)));
      } catch {}
    }, 1000);
  };

  // ---- request queue ----

  let strategy = null;
  try {
    const saved = localStorage.getItem(STRATEGY_KEY);
    if (saved in strategies) strategy = saved;
  } catch {}
  let detectFailures = 0;
  let disabled = false;

  const pending = new Set();
  const inflight = new Set();
  const failedAt = new Map();

  async function detect(id) {
    for (const name of ORDER) {
      try {
        const [feat] = await strategies[name].fetch([id]);
        if (feat) {
          cache.set(id, feat);
          try {
            localStorage.setItem(STRATEGY_KEY, name);
          } catch {}
          console.log(`${TAG} using ${name}`);
          return name;
        }
      } catch (e) {
        console.debug(TAG, name, e);
      }
    }
    return null;
  }

  async function runLimited(items, limit, fn) {
    const queue = [...items];
    const worker = async () => {
      while (queue.length) await fn(queue.shift());
    };
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
  }

  const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

  function request(id) {
    if (disabled || cache.has(id) || inflight.has(id) || pending.has(id)) return;
    if (Date.now() - (failedAt.get(id) ?? 0) < RETRY_AFTER_MS) return;
    pending.add(id);
    setTimeout(flush, 80);
  }

  let flushing = false;
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      while (pending.size && !disabled) {
        if (!strategy) {
          const [first] = pending;
          pending.delete(first);
          strategy = await detect(first);
          if (!strategy) {
            failedAt.set(first, Date.now());
            if (++detectFailures >= 3) {
              disabled = true;
              console.warn(`${TAG} no working endpoint`);
              Spicetify.showNotification?.("BPM/Key: no working endpoint found", true);
            }
            continue;
          }
          render();
        }

        const s = strategies[strategy];
        const ids = [...pending];
        pending.clear();
        ids.forEach((id) => inflight.add(id));
        await runLimited(chunk(ids, s.batch), CONCURRENCY, async (part) => {
          try {
            const res = await s.fetch(part);
            part.forEach((id, i) => cache.set(id, res[i]));
          } catch (e) {
            console.warn(TAG, strategy, e);
            part.forEach((id) => failedAt.set(id, Date.now()));
          } finally {
            part.forEach((id) => inflight.delete(id));
          }
        });
        persist();
        render();
      }
    } finally {
      flushing = false;
    }
  }

  // ---- chords ----

  // Chord index = root * 2 + (minor ? 1 : 0); -1 means no chord
  const CHORDS = Array.from({ length: 24 }, (_, i) => {
    const root = i >> 1;
    const minor = (i & 1) === 1;
    return { root, minor, tones: [0, minor ? 3 : 4, 7].map((d) => (root + d) % 12) };
  });
  const chordName = (i) => (i < 0 ? "N" : `${PITCHES[CHORDS[i].root]}${CHORDS[i].minor ? "m" : ""}`);

  // Key-aware spelling: flat keys and ♭-degree chords use flats (E♭ as ♭III in C, not D♯)
  const FLAT_PITCHES = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];
  const FLAT_MAJOR_TONICS = new Set([1, 3, 5, 8, 10]); // D♭ E♭ F A♭ B♭
  const FLAT_MINOR_TONICS = new Set([0, 2, 3, 5, 7, 10]); // Cm Dm E♭m Fm Gm B♭m
  const usesFlats = (tonic, minorKey) => (minorKey ? FLAT_MINOR_TONICS : FLAT_MAJOR_TONICS).has(tonic);
  function spellChord(chord, tonic, minorKey) {
    if (chord < 0 || tonic == null || tonic < 0) return chordName(chord);
    const { root, minor } = CHORDS[chord];
    const flat = usesFlats(tonic, minorKey) || roman(chord, tonic, minorKey).startsWith("♭");
    return `${(flat ? FLAT_PITCHES : PITCHES)[root]}${minor ? "m" : ""}`;
  }
  const spellKey = (tonic, minorKey) =>
    tonic == null || tonic < 0 ? "?" : `${(usesFlats(tonic, minorKey) ? FLAT_PITCHES : PITCHES)[tonic]}${minorKey ? "m" : ""}`;

  const centered = (v) => {
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const c = v.map((x) => x - mean);
    const norm = Math.hypot(...c) || 1;
    return c.map((x) => x / norm);
  };
  // Mean-centered templates so the score is a Pearson correlation with the chroma
  const makeTemplates = () =>
    CHORDS.map(({ tones: [root, third, fifth] }) => {
      const v = new Array(12).fill(0);
      v[root] = 1;
      v[third] = PARAMS.thirdWeight;
      v[fifth] = PARAMS.fifthWeight;
      return centered(v);
    });
  const ZERO_EMISSION = new Array(24).fill(0);

  const pitchClassOf = (name) => {
    const m = name?.match(/^([A-G])([♯#♭b])?/);
    if (!m) return null;
    const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]];
    const shift = m[2] === "♯" || m[2] === "#" ? 1 : m[2] ? 11 : 0;
    return (base + shift) % 12;
  };

  const MAJOR_DIATONIC = [[0, false], [2, true], [4, true], [5, false], [7, false], [9, true]];
  const MINOR_DIATONIC = [[0, true], [3, false], [5, true], [7, true], [7, false], [8, false], [10, false]];
  const diatonicSet = (tonic, minor) =>
    tonic == null || tonic < 0
      ? new Set()
      : new Set((minor ? MINOR_DIATONIC : MAJOR_DIATONIC).map(([d, m]) => ((tonic + d) % 12) * 2 + (m ? 1 : 0)));

  const ROMAN_MAJOR = ["I", "♭II", "II", "♭III", "III", "IV", "♯IV", "V", "♭VI", "VI", "♭VII", "VII"];
  const ROMAN_MINOR = ["I", "♭II", "II", "III", "♯III", "IV", "♯IV", "V", "VI", "♯VI", "VII", "♯VII"];
  function roman(chord, tonic, minorKey) {
    if (chord < 0 || tonic == null || tonic < 0) return "";
    const { root, minor } = CHORDS[chord];
    const r = (minorKey ? ROMAN_MINOR : ROMAN_MAJOR)[(root - tonic + 12) % 12];
    return minor ? r.toLowerCase() : r;
  }

  // Loudness-weighted average chroma per time window; null when the window is near silent
  function windowChroma(segments, windows) {
    let j = 0;
    return windows.map(([from, to]) => {
      while (j < segments.length && segments[j].start + segments[j].duration <= from) j++;
      const acc = new Array(12).fill(0);
      let weight = 0;
      for (let k = j; k < segments.length && segments[k].start < to; k++) {
        const s = segments[k];
        const overlap = Math.min(to, s.start + s.duration) - Math.max(from, s.start);
        if (overlap <= 0 || !Array.isArray(s.pitches)) continue;
        // Drum hits and noise light up every pitch class; tonal segments have a few peaks
        const flatness = s.pitches.reduce((a, b) => a + b, 0) / 12;
        const w = overlap * 10 ** ((s.loudness_max ?? -60) / 20) * (1 - flatness) ** PARAMS.flatPower;
        s.pitches.forEach((p, i) => (acc[i] += p * w));
        weight += w;
      }
      return weight / (to - from) < PARAMS.silenceAmp ? null : centered(acc);
    });
  }

  // Songs repeat: average each window with the windows whose surrounding context looks most alike
  // (same place in another chorus/verse). Averaging repetitions cancels noise that differs between them.
  function smoothRepetitions(chromas) {
    const { repContext: h, repTopK: k, repThreshold, repWeight } = PARAMS;
    const n = chromas.length;
    if (!k || n < 2 * h + 2) return chromas;
    const dot = Array.from({ length: n }, () => new Float32Array(n));
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        const a = chromas[i];
        const b = chromas[j];
        const v = a && b ? a.reduce((sum, x, d) => sum + x * b[d], 0) : 0;
        dot[i][j] = dot[j][i] = v;
      }
    }
    return chromas.map((c, i) => {
      if (!c) return c;
      const matches = [];
      for (let j = 0; j < n; j++) {
        if (Math.abs(i - j) <= h || !chromas[j]) continue;
        let sum = 0;
        let count = 0;
        for (let d = -h; d <= h; d++) {
          if (i + d < 0 || j + d < 0 || i + d >= n || j + d >= n) continue;
          sum += dot[i + d][j + d];
          count++;
        }
        const sim = count ? sum / count : 0;
        if (sim >= repThreshold) matches.push([sim, j]);
      }
      if (!matches.length) return c;
      matches.sort((a, b) => b[0] - a[0]);
      const top = matches.slice(0, k);
      const acc = c.slice();
      for (const [sim, j] of top) chromas[j].forEach((x, d) => (acc[d] += (repWeight * sim * x) / top.length));
      return centered(acc);
    });
  }

  // Emissions are per-state scores; staying on a chord is free, switching costs PARAMS.switchPenalty
  function viterbi(emissions) {
    if (!emissions.length) return [];
    let score = Float64Array.from(emissions[0]);
    const back = [];
    for (let t = 1; t < emissions.length; t++) {
      let best = 0;
      for (let s = 1; s < 24; s++) if (score[s] > score[best]) best = s;
      const switched = score[best] - PARAMS.switchPenalty;
      const next = new Float64Array(24);
      const from = new Int8Array(24);
      for (let s = 0; s < 24; s++) {
        const stay = score[s] >= switched;
        next[s] = (stay ? score[s] : switched) + emissions[t][s];
        from[s] = stay ? s : best;
      }
      back.push(from);
      score = next;
    }
    let s = 0;
    for (let i = 1; i < 24; i++) if (score[i] > score[s]) s = i;
    const path = new Array(emissions.length);
    path[path.length - 1] = s;
    for (let t = back.length; t > 0; t--) path[t - 1] = s = back[t - 1][s];
    return path;
  }

  const round2 = (x) => Math.round(x * 100) / 100;

  // Result: { tonic, minor, keySrc, spans: [[start, end, chord, conf]], sections: [[start, pc, minor, conf]] }
  function analyzeChords(data, keyHint) {
    const bars = data?.bars;
    const segments = data?.segments;
    if (!bars?.length || !segments?.length) return null;
    const per = PARAMS.windowsPerBar;
    const windows = bars.flatMap(({ start, duration }) =>
      Array.from({ length: per }, (_, i) => [start + (duration * i) / per, start + (duration * (i + 1)) / per])
    );
    const tonic = keyHint?.tonic ?? (data.track?.key >= 0 ? data.track.key : null);
    const minor = keyHint ? keyHint.minor : data.track?.mode === 0;
    const diatonic = diatonicSet(tonic, minor);
    const templates = makeTemplates();
    const corr = smoothRepetitions(windowChroma(segments, windows)).map((c) =>
      c ? templates.map((t) => t.reduce((sum, x, i) => sum + x * c[i], 0)) : null
    );
    const path = viterbi(corr.map((r) => (r ? r.map((v, s) => v + (diatonic.has(s) ? PARAMS.keyPrior : 0)) : ZERO_EMISSION)));

    // Merge consecutive windows with the same chord: [start, end, chord, confSum, count]
    const spans = [];
    windows.forEach(([from, to], t) => {
      const chord = corr[t] ? path[t] : -1;
      const conf = corr[t] ? corr[t][chord] : 0;
      const last = spans[spans.length - 1];
      if (last && last[2] === chord && from - last[1] < 0.05) {
        last[1] = to;
        last[3] += conf;
        last[4]++;
      } else spans.push([from, to, chord, conf, 1]);
    });

    return {
      tonic,
      minor,
      keySrc: keyHint ? keyHint.src : "audio-analysis",
      spans: spans.map(([a, b, c, sum, n]) => [round2(a), round2(b), c, round2(sum / n)]),
      sections: (data.sections ?? []).map((s) => [round2(s.start), s.key, s.mode === 0, round2(s.key_confidence ?? 0)]),
    };
  }

  // Most frequent 4-chord loops (ignoring no-chord spans), e.g. "F♯m → G♯m → A → G♯m"
  function topProgressions(spans, limit = 3) {
    const seq = spans.map((s) => s[2]).filter((c) => c >= 0);
    const counts = new Map();
    for (let i = 0; i + 4 <= seq.length; i++) {
      const gram = seq.slice(i, i + 4);
      if (new Set(gram).size < 2) continue;
      const k = gram.join(",");
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...counts]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([k, n]) => ({ chords: k.split(",").map(Number), count: n }));
  }

  // Share of total (non-silent) time per chord, most used first
  function chordUsage(spans) {
    const time = new Map();
    let sum = 0;
    for (const [s, e, c] of spans) {
      if (c < 0) continue;
      time.set(c, (time.get(c) ?? 0) + e - s);
      sum += e - s;
    }
    return [...time].sort((a, b) => b[1] - a[1]).map(([chord, t]) => ({ chord, share: t / sum }));
  }

  // Joins adjacent spans with the same chord: [start, end, chord]
  function mergeSpans(spans) {
    const out = [];
    for (const [s, e, c] of spans) {
      const last = out[out.length - 1];
      if (last && last[2] === c && s - last[1] < 0.05) last[1] = e;
      else out.push([s, e, c]);
    }
    return out;
  }

  // ---- harmony theory ----

  const degreeOf = (chord, tonic) => (CHORDS[chord].root - tonic + 12) % 12;
  const chordKey = (chord, tonic) => `${degreeOf(chord, tonic)},${CHORDS[chord].minor ? 1 : 0}`;

  // Function of diatonic triads, keyed by "degree,minor": T(onic) / S(ubdominant) / D(ominant)
  const FUNCTIONS_MAJOR = { "0,0": "T", "4,1": "T", "9,1": "T", "2,1": "S", "5,0": "S", "7,0": "D" };
  const FUNCTIONS_MINOR = { "0,1": "T", "3,0": "T", "5,1": "S", "8,0": "S", "7,0": "D", "7,1": "D", "10,0": "D" };
  const FUNCTION_NAMES = { T: "tonic", S: "subdominant", D: "dominant" };
  function functionOf(chord, tonic, minorKey) {
    if (chord < 0 || tonic == null || tonic < 0) return null;
    return (minorKey ? FUNCTIONS_MINOR : FUNCTIONS_MAJOR)[chordKey(chord, tonic)] ?? null;
  }

  // Common non-diatonic chords borrowed from a related mode, keyed by "degree,minor"
  const BORROWED_MAJOR = {
    "5,1": "iv from the parallel minor",
    "8,0": "♭VI from the parallel minor",
    "10,0": "♭VII from the parallel minor / Mixolydian",
    "3,0": "♭III from the parallel minor",
    "0,1": "i from the parallel minor",
    "7,1": "v from the parallel minor / Mixolydian",
  };
  const BORROWED_MINOR = {
    "5,0": "Dorian IV (raised 6th degree)",
    "2,1": "Dorian ii (raised 6th degree)",
    "0,0": "I from the parallel major (Picardy third)",
  };

  // Explains a chord in context: { kind: diatonic|secondary|borrowed|chromatic, fn?, label?, note }
  function explainChord(chord, next, tonic, minorKey) {
    if (chord < 0 || tonic == null || tonic < 0) return null;
    const fn = functionOf(chord, tonic, minorKey);
    if (fn) return { kind: "diatonic", fn, note: `${FUNCTION_NAMES[fn]} function` };

    // Secondary dominant: a major chord a fifth above a diatonic chord other than the tonic
    const { root, minor } = CHORDS[chord];
    const targetRoot = (root + 5) % 12;
    const target = minor ? null : [...diatonicSet(tonic, minorKey)].find((c) => CHORDS[c].root === targetRoot && targetRoot !== tonic);
    const resolves = target != null && next >= 0 && CHORDS[next].root === targetRoot;
    const secondary = target != null && {
      kind: "secondary",
      label: `V/${roman(target, tonic, minorKey)}`,
      note: resolves
        ? `secondary dominant, resolves to ${chordName(next)}`
        : `secondary dominant of ${chordName(target)} (doesn't resolve here)`,
    };
    if (resolves) return secondary;

    const borrowed = (minorKey ? BORROWED_MINOR : BORROWED_MAJOR)[chordKey(chord, tonic)];
    if (borrowed) return { kind: "borrowed", note: `borrowed: ${borrowed}` };
    if (secondary) return secondary;
    if (!minor && degreeOf(chord, tonic) === 1) return { kind: "chromatic", note: "Neapolitan chord (♭II)" };
    return { kind: "chromatic", note: "chromatic, outside the key" };
  }

  // Cadences between consecutive chords; a phrase (section) ending on V counts as a half cadence
  function findCadences(spans, tonic, minorKey, sections = []) {
    if (tonic == null || tonic < 0) return [];
    const seq = mergeSpans(spans).filter(([, , c]) => c >= 0);
    const deg = (c) => degreeOf(c, tonic);
    const isV = (c) => deg(c) === 7 && !CHORDS[c].minor;
    const out = [];
    for (let i = 0; i + 1 < seq.length; i++) {
      const [start, , a] = seq[i];
      const [, end, b] = seq[i + 1];
      let type = null;
      if (isV(a) && deg(b) === 0) type = "authentic";
      else if (deg(a) === 5 && deg(b) === 0) type = "plagal";
      else if (isV(a) && deg(b) === (minorKey ? 8 : 9)) type = "deceptive";
      if (type) out.push({ start, end, from: a, to: b, type });
    }
    for (const [start, end, c] of seq) {
      if (isV(c) && sections.some(([t]) => t > 0 && Math.abs(t - end) < 1) && !out.some((o) => o.start === start)) {
        out.push({ start, end, from: c, to: -1, type: "half" });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }

  // Modal color of the whole track from how much time characteristic chords take up
  function flavorHints(spans, tonic, minorKey) {
    if (tonic == null || tonic < 0) return [];
    const usage = chordUsage(spans);
    const share = (...keys) =>
      usage.filter(({ chord }) => keys.includes(chordKey(chord, tonic))).reduce((sum, u) => sum + u.share, 0);
    const MIN = 0.05;
    const hints = [];
    if (minorKey) {
      if (share("5,0", "2,1") >= MIN) hints.push("Dorian color (major IV / minor ii)");
      if (share("7,0") >= MIN) hints.push("harmonic minor (major V)");
      else if (share("10,0") >= MIN) hints.push("Aeolian cadences (♭VII instead of V)");
    } else {
      if (share("10,0") >= MIN) hints.push("Mixolydian color (♭VII)");
      if (share("5,1", "8,0", "3,0") >= MIN) hints.push("modal mixture from the parallel minor");
      if (share("2,0", "4,0", "9,0", "11,0") >= MIN) hints.push("secondary dominants");
    }
    return hints;
  }

  // Chord names for a set of played notes (piano), beyond the triads the estimator knows
  const QUALITIES = [
    ["", [0, 4, 7]],
    ["m", [0, 3, 7]],
    ["7", [0, 4, 7, 10]],
    ["maj7", [0, 4, 7, 11]],
    ["m7", [0, 3, 7, 10]],
    ["dim", [0, 3, 6]],
    ["aug", [0, 4, 8]],
    ["sus4", [0, 5, 7]],
    ["sus2", [0, 2, 7]],
    ["m7♭5", [0, 3, 6, 10]],
    ["dim7", [0, 3, 6, 9]],
    ["6", [0, 4, 7, 9]],
    ["m6", [0, 3, 7, 9]],
    ["5", [0, 7]],
  ];
  const MINORISH = new Set(["m", "m7", "dim", "m7♭5", "dim7", "m6"]);
  const ROMAN_SUFFIX = { dim: "°", aug: "+", "m7♭5": "ø7", dim7: "°7", m7: "7", m6: "6" };

  // MIDI notes → { root, quality, bass, chord (triad index or -1) } or null; inversions keep the bass
  function identifyChord(midis) {
    if (!midis.length) return null;
    const bass = Math.min(...midis) % 12;
    const pcs = [...new Set(midis.map((m) => m % 12))];
    const roots = [bass, ...pcs.filter((p) => p !== bass)];
    for (const root of roots) {
      const set = pcs.map((p) => (p - root + 12) % 12).sort((a, b) => a - b).join(",");
      const q = QUALITIES.find(([, iv]) => iv.join(",") === set);
      if (q) return { root, quality: q[0], bass, chord: q[0] === "" ? root * 2 : q[0] === "m" ? root * 2 + 1 : -1 };
    }
    return null;
  }
  function chordLabel({ root, quality, bass }, tonic, minorKey) {
    const names = tonic != null && usesFlats(tonic, minorKey) ? FLAT_PITCHES : PITCHES;
    return `${names[root]}${quality}${bass !== root ? `/${names[bass]}` : ""}`;
  }
  function romanOf({ root, quality }, tonic, minorKey) {
    if (tonic == null || tonic < 0) return "";
    const r = (minorKey ? ROMAN_MINOR : ROMAN_MAJOR)[(root - tonic + 12) % 12];
    return `${MINORISH.has(quality) ? r.toLowerCase() : r}${ROMAN_SUFFIX[quality] ?? (quality === "m" ? "" : quality)}`;
  }

  // How well a chord fits key k (= tonic * 2 + minor), per second of chord time
  function keyFit(chord, k) {
    const tonic = k >> 1;
    const minorKey = (k & 1) === 1;
    if (degreeOf(chord, tonic) === 0 && CHORDS[chord].minor === minorKey) return PARAMS.keyTonicFit;
    const diatonic = diatonicSet(tonic, minorKey);
    if (diatonic.has(chord)) return 1;
    if ((minorKey ? BORROWED_MINOR : BORROWED_MAJOR)[chordKey(chord, tonic)]) return PARAMS.keyBorrowedFit;
    const { root, minor } = CHORDS[chord];
    const target = (root + 5) % 12;
    if (!minor && target !== tonic && [...diatonic].some((c) => CHORDS[c].root === target)) return PARAMS.keySecondaryFit;
    return -1;
  }

  // Key regions [[start, end, tonic, minor]]: Viterbi over the chord sequence, where staying in a key
  // is free and modulating costs PARAMS.keySwitch seconds of fit. The track key gets a small bonus,
  // so short excursions (secondary dominants, borrowed chords) stay explained within the main key.
  function localKeys(spans, tonic, minorKey, hintBonus = PARAMS.keyHintBonus) {
    const seq = mergeSpans(spans).filter(([, , c]) => c >= 0);
    if (!seq.length) return [];
    const hint = tonic == null || tonic < 0 ? -1 : tonic * 2 + (minorKey ? 1 : 0);
    const emit = ([s, e, c]) =>
      Array.from({ length: 24 }, (_, k) => (keyFit(c, k) + (k === hint ? hintBonus : 0)) * (e - s));
    let score = emit(seq[0]);
    const back = [];
    for (let t = 1; t < seq.length; t++) {
      let best = 0;
      for (let k = 1; k < 24; k++) if (score[k] > score[best]) best = k;
      const switched = score[best] - PARAMS.keySwitch;
      const e = emit(seq[t]);
      const from = new Int8Array(24);
      score = score.map((v, k) => {
        from[k] = v >= switched ? k : best;
        return Math.max(v, switched) + e[k];
      });
      back.push(from);
    }
    let k = score.indexOf(Math.max(...score));
    const path = [k];
    for (let t = back.length; t > 0; t--) path.unshift((k = back[t - 1][k]));
    // Regions cover the whole track, including no-chord gaps
    const regions = [];
    path.forEach((key, t) => {
      const last = regions[regions.length - 1];
      if (last && last[2] * 2 + (last[3] ? 1 : 0) === key) last[1] = seq[t][1];
      else regions.push([last ? seq[t][0] : Math.min(seq[t][0], spans[0][0]), seq[t][1], key >> 1, (key & 1) === 1]);
    });
    regions.forEach((r, i) => (r[1] = regions[i + 1]?.[0] ?? Math.max(r[1], spans[spans.length - 1][1])));
    return regions;
  }
  const keyRegions = (res, spans = res.spans) =>
    localKeys(spans, res.tonic, res.minor, res.keySrc === "audio-analysis" ? 0 : PARAMS.keyHintBonus);
  const keyAt = (regions, t) => regions.find(([s, e]) => t >= s && t < e) ?? regions[regions.length - 1];

  // ---- corrections ----

  // User fixes are stored as time ranges [start, end, chord] so they survive estimator changes
  const CORRECTIONS_KEY = "bpm-key:corrections:v1";
  let corrections = {};
  try {
    corrections = JSON.parse(localStorage.getItem(CORRECTIONS_KEY) ?? "{}");
  } catch {}
  const saveCorrections = () => {
    try {
      localStorage.setItem(CORRECTIONS_KEY, JSON.stringify(corrections));
    } catch {}
  };
  function setCorrection(id, start, end, chord) {
    const list = (corrections[id] ?? []).filter(([s, e]) => e <= start || s >= end);
    list.push([start, end, chord]);
    corrections[id] = list.sort((a, b) => a[0] - b[0]);
    saveCorrections();
  }
  function clearCorrections(id) {
    delete corrections[id];
    saveCorrections();
  }
  // Spans get [start, end, chord, conf, corrected]
  function applyCorrections(spans, fixes = []) {
    if (!fixes.length) return spans;
    return spans.map(([s, e, c, cf]) => {
      const mid = (s + e) / 2;
      const fix = fixes.find(([fs, fe]) => mid >= fs && mid < fe);
      return fix ? [s, e, fix[2], 1, true] : [s, e, c, cf];
    });
  }

  // Isophonics/Harte .lab text (the format test/eval.mjs scores against); X marks unannotated gaps
  const HARTE_ROOTS = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  const harteLabel = (c) => (c < 0 ? "N" : `${HARTE_ROOTS[CHORDS[c].root]}${CHORDS[c].minor ? ":min" : ""}`);
  function toLab(spans) {
    return mergeSpans(spans)
      .map(([s, e, c]) => `${s.toFixed(3)} ${e.toFixed(3)} ${c === -2 ? "X" : harteLabel(c)}`)
      .join("\n");
  }

  const chordCache = new Map(); // id → analyzeChords result | null
  try {
    for (const [id, v] of Object.entries(JSON.parse(localStorage.getItem(CHORD_CACHE_KEY) ?? "{}"))) chordCache.set(id, v);
  } catch {}
  const persistChords = () => {
    while (chordCache.size > CHORD_CACHE_LIMIT) chordCache.delete(chordCache.keys().next().value);
    try {
      localStorage.setItem(CHORD_CACHE_KEY, JSON.stringify(Object.fromEntries(chordCache)));
    } catch {}
  };

  const ANALYSIS_URLS = [
    (id) => `https://spclient.wg.spotify.com/audio-attributes/v1/audio-analysis/${id}?format=json`,
    (id) => `https://api.spotify.com/v1/audio-analysis/${id}`,
  ];
  // Segment chroma for the piano view, kept in memory only (too big for localStorage):
  // id → { starts: Float64Array, pitches: Uint8Array (12 per segment, 0–255) }
  const pitchCache = new Map();
  const PITCH_CACHE_LIMIT = 3;
  function keepPitches(id, segments) {
    const starts = Float64Array.from(segments, (s) => s.start);
    const pitches = new Uint8Array(segments.length * 12);
    segments.forEach((s, i) => s.pitches?.forEach((p, d) => (pitches[i * 12 + d] = Math.round(p * 255))));
    pitchCache.delete(id);
    pitchCache.set(id, { starts, pitches });
    while (pitchCache.size > PITCH_CACHE_LIMIT) pitchCache.delete(pitchCache.keys().next().value);
  }

  async function fetchAnalysis(id) {
    for (const url of ANALYSIS_URLS) {
      try {
        const data = await getJSON(url(id));
        if (data?.segments?.length) {
          keepPitches(id, data.segments);
          return data;
        }
      } catch (e) {
        console.debug(TAG, "analysis", e);
      }
    }
    return null;
  }

  async function fetchChords(id) {
    const data = await fetchAnalysis(id);
    if (!data) return null; // not cached, so the next open retries
    // Prefer the Mix key (more reliable than audio-analysis, see README)
    const feat = cache.get(id);
    const pc = pitchClassOf(feat?.n);
    const keyHint = pc == null ? null : { tonic: pc, minor: !!feat.minor, src: feat.src ?? strategy };
    const res = analyzeChords(data, keyHint);
    chordCache.delete(id);
    chordCache.set(id, res);
    persistChords();
    return res;
  }

  // Analysis is only fetched on demand, when the harmony page is opened
  const chordPending = new Map(); // id → Promise
  function loadChords(id) {
    if (chordCache.has(id)) return Promise.resolve(chordCache.get(id));
    if (!chordPending.has(id)) chordPending.set(id, fetchChords(id).finally(() => chordPending.delete(id)));
    return chordPending.get(id);
  }

  async function trackMeta(id) {
    const item = Spicetify.Player.data?.item;
    const fromItem = (t) => ({ name: t.name, artist: t.artists?.map((a) => a.name).join(", ") });
    if (item?.uri === `spotify:track:${id}`) return fromItem(item);
    // The client's own GraphQL query; the public Web API is often rate limited (429) inside the client
    try {
      const G = Spicetify.GraphQL;
      const t = (await G.Request(G.Definitions.getTrack, { uri: `spotify:track:${id}` }))?.data?.trackUnion;
      if (t?.name) {
        const artists = [t.firstArtist, t.otherArtists].flatMap((a) => a?.items ?? []).map((a) => a.profile?.name);
        return { name: t.name, artist: artists.filter(Boolean).join(", ") };
      }
    } catch {}
    try {
      return fromItem(await getJSON(`https://api.spotify.com/v1/tracks/${id}`));
    } catch {
      return null;
    }
  }

  const keyLabel = (pc, minor) => (pc == null || pc < 0 ? "?" : `${PITCHES[pc]}${minor ? "m" : ""}`);

  function currentTrackId() {
    const uri = Spicetify.Player.data?.item?.uri ?? Spicetify.Player.data?.track?.uri;
    return uri && Spicetify.URI.isTrack(uri) ? uri.split(":")[2] : null;
  }

  // ---- playback ----

  // Synthesized chord: bass root plus a close-position triad, E2–D♯3 / E3–D♯4 so every key sits in the same range
  let audioCtx = null;
  let voices = [];
  let sounding = []; // synthesized notes for the piano view: { midi, from, to } in audioCtx time
  const ctx = () => {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  };
  function stopSynth() {
    for (const v of voices) {
      try {
        v.stop();
      } catch {}
    }
    voices = [];
    sounding = [];
  }
  const voicing = (chord) => {
    const { root, minor } = CHORDS[chord];
    const base = 52 + ((root - 4 + 12) % 12);
    return [base - 12, base, base + (minor ? 3 : 4), base + 7];
  };
  function synthChord(chord, when = 0, dur = 1.2) {
    if (chord < 0) return;
    const t0 = ctx().currentTime + when;
    const midis = voicing(chord);
    sounding = sounding.filter((n) => n.to > audioCtx.currentTime);
    midis.forEach((m) => {
      sounding.push({ midi: m, from: t0, to: t0 + dur });
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "triangle";
      osc.frequency.value = 440 * 2 ** ((m - 69) / 12);
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.25 / midis.length, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
      voices.push(osc);
    });
  }
  // A held piano note; returns a function that releases it
  function noteOn(midi) {
    const ac = ctx();
    const t0 = ac.currentTime;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.12, t0 + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.04, t0 + 1.2);
    gain.connect(ac.destination);
    const oscs = [
      ["triangle", 1, 1],
      ["sine", 2, 0.3],
    ].map(([type, mult, level]) => {
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.type = type;
      osc.frequency.value = 440 * 2 ** ((midi - 69) / 12) * mult;
      g.gain.value = level;
      osc.connect(g).connect(gain);
      osc.start(t0);
      return osc;
    });
    return () => {
      const t = ac.currentTime;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      oscs.forEach((o) => o.stop(t + 0.3));
    };
  }

  // One chord per bar at the track tempo (clamped so very slow/fast tracks stay listenable)
  function synthProgression(chords, bpm) {
    stopSynth();
    const bar = Math.min(2.5, Math.max(0.8, 240 / (bpm || 120)));
    chords.forEach((c, i) => synthChord(c, i * bar, bar * 0.95));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(cond, ms) {
    for (const until = Date.now() + ms; Date.now() < until; await sleep(100)) if (cond()) return true;
    return false;
  }

  // Plays [start, end) of the track, then pauses or (while loopEnabled) jumps back to start.
  // Manual seeking elsewhere just cancels the watch.
  let spanWatch = null;
  let loopEnabled = false;
  async function playSpan(id, start, end) {
    clearInterval(spanWatch);
    stopSynth();
    const P = Spicetify.Player;
    if (currentTrackId() !== id) {
      await P.playUri?.(`spotify:track:${id}`);
      if (!(await waitFor(() => currentTrackId() === id && P.isPlaying?.(), 5000))) return;
    } else if (!P.isPlaying?.()) P.play?.();
    P.seek?.(Math.max(start * 1000, 1)); // seek() treats values ≤ 1 as a fraction of the track
    let seen = false;
    let deadline = Date.now() + (end - start + 5) * 1000;
    spanWatch = setInterval(() => {
      const t = (P.getProgress?.() ?? 0) / 1000;
      const inside = t >= start - 0.5 && t < end;
      if (!seen) {
        seen = inside; // ignore stale positions until the seek lands
        if (!seen && Date.now() < deadline) return;
      }
      if (currentTrackId() !== id || Date.now() > deadline || t < start - 1 || t > end + 1) {
        clearInterval(spanWatch);
      } else if (t >= end && loopEnabled) {
        P.seek?.(Math.max(start * 1000, 1));
        seen = false;
        deadline = Date.now() + (end - start + 5) * 1000;
      } else if (t >= end) {
        P.pause?.();
        clearInterval(spanWatch);
      }
    }, 100);
  }

  // ---- harmony page ----

  const make = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  let page = null;
  let pageTimer = null;
  let piano = null;
  const onPageKey = (e) => e.key === "Escape" && closeHarmonyPage();

  function closeHarmonyPage() {
    clearInterval(pageTimer);
    // Stop looping/auto-pause but let the track keep playing
    clearInterval(spanWatch);
    loopEnabled = false;
    stopSynth();
    document.removeEventListener("keydown", onPageKey);
    piano?.destroy();
    piano = null;
    page?.remove();
    page = null;
  }

  async function openHarmonyPage(id) {
    if (!id) return;
    closeHarmonyPage();
    const root = make("div", "bpmkey-page");
    const body = make("div", "bpmkey-page-body");
    const close = make("button", "bpmkey-page-close", "✕");
    close.title = "Close (Esc)";
    close.onclick = closeHarmonyPage;
    root.append(close, body);
    body.appendChild(make("p", "bpmkey-note", "Analyzing…"));
    document.body.appendChild(root);
    document.addEventListener("keydown", onPageKey);
    page = root;

    if (!cache.has(id)) request(id);
    const [res, meta] = await Promise.all([loadChords(id), trackMeta(id)]);
    if (page !== root) return; // closed or replaced while loading
    body.replaceChildren();
    if (!res) {
      body.appendChild(make("p", null, "No audio analysis available for this track."));
      return;
    }
    loopEnabled = false;
    const view = { root, body, id, res, meta, ui: { edit: false, loop: false, sel: null } };
    drawHarmony(view);
    piano = createPiano(view);
    root.appendChild(piano.el);
    // Chords may come from the cache without the (memory-only) segment chroma; fetch it for the piano
    if (!pitchCache.has(id)) fetchAnalysis(id);
  }

  // ---- piano ----

  const PIANO_LOW = 36; // C2
  const PIANO_HIGH = 72; // C5
  const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);
  // Physical keys (KeyboardEvent.code, so it works with any input language) → semitones above the playing C
  const KEYMAP = {
    KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9,
    KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17,
  };
  const keyCap = (code) => ({ Semicolon: ";", Quote: "'" })[code] ?? code.slice(3);
  const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
  const noteName = (midi, tonic, minorKey) =>
    `${(tonic != null && usesFlats(tonic, minorKey) ? FLAT_PITCHES : PITCHES)[midi % 12]}${Math.floor(midi / 12) - 1}`;

  // Sticky keyboard at the bottom of the harmony page. Shows the estimated chord (voiced like ♪), the
  // live pitch-class energy of the current segment, scale degrees of the local key, and plays what you press.
  // view.spans / view.regions / view.mainKey are refreshed by drawHarmony.
  function createPiano(view) {
    const el = make("div", "bpmkey-piano");
    const head = make("div", "bpmkey-piano-head");
    const now = make("span", "bpmkey-piano-now");
    const you = make("span", "bpmkey-piano-you");
    const toggle = make("button", "bpmkey-tool", "▾ Piano");
    toggle.title = "Show/hide the piano";
    head.append(now, you, toggle);
    const keysEl = make("div", "bpmkey-piano-keys");
    el.append(head, keysEl);
    toggle.onclick = () => {
      keysEl.hidden = !keysEl.hidden;
      toggle.textContent = keysEl.hidden ? "▸ Piano" : "▾ Piano";
    };

    const keys = new Map(); // midi → { el, degree, cap }
    const whites = [];
    for (let m = PIANO_LOW; m <= PIANO_HIGH; m++) if (!BLACK_KEYS.has(m % 12)) whites.push(m);
    const w = 100 / whites.length;
    for (let m = PIANO_LOW; m <= PIANO_HIGH; m++) {
      const black = BLACK_KEYS.has(m % 12);
      const k = make("div", black ? "bpmkey-key bpmkey-key-black" : "bpmkey-key");
      const before = whites.filter((x) => x < m).length;
      k.style.left = `${black ? (before - 0.3) * w : before * w}%`;
      k.style.width = `${black ? w * 0.6 : w}%`;
      k.dataset.midi = String(m);
      const cap = make("small", "bpmkey-key-cap");
      const degree = make("small", "bpmkey-key-degree");
      k.append(cap, degree);
      if (m % 12 === 0) k.appendChild(make("small", "bpmkey-key-octave", `C${m / 12 - 1}`));
      keys.set(m, { el: k, degree, cap });
      keysEl.appendChild(k);
    }

    // Held notes by source ("pointer", "KeyA"…) so key-up releases the right one
    const held = new Map();
    let octave = 48; // the A key plays C3
    const press = (src, midi) => {
      if (held.has(src) || midi < PIANO_LOW - 12 || midi > PIANO_HIGH + 12) return;
      held.set(src, { midi, release: noteOn(midi) });
    };
    const release = (src) => {
      held.get(src)?.release();
      held.delete(src);
    };
    const releaseAll = () => [...held.keys()].forEach(release);

    const midiAt = (x, y) => Number(document.elementFromPoint(x, y)?.closest?.(".bpmkey-key")?.dataset.midi) || null;
    let dragging = false;
    keysEl.addEventListener("pointerdown", (e) => {
      const m = midiAt(e.clientX, e.clientY);
      if (!m) return;
      e.preventDefault();
      dragging = true;
      press("pointer", m);
    });
    const onPointerMove = (e) => {
      if (!dragging) return;
      const m = midiAt(e.clientX, e.clientY);
      if (m && m !== held.get("pointer")?.midi) {
        release("pointer");
        press("pointer", m);
      }
    };
    const onPointerUp = () => {
      dragging = false;
      release("pointer");
    };

    const ignore = (e) => e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName ?? "");
    const onKeyDown = (e) => {
      if (ignore(e)) return;
      if (e.code === "KeyZ" || e.code === "KeyX") {
        octave = Math.min(PIANO_HIGH - 12, Math.max(PIANO_LOW, octave + (e.code === "KeyZ" ? -12 : 12)));
      } else if (e.code in KEYMAP) {
        if (!e.repeat) press(e.code, octave + KEYMAP[e.code]);
      } else return;
      // Keep Spotify's own shortcuts from seeing piano keys
      e.preventDefault();
      e.stopPropagation();
    };
    const onKeyUp = (e) => {
      if (!(e.code in KEYMAP)) return;
      release(e.code);
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("blur", releaseAll);

    let seg = 0;
    const segmentAt = (starts, t) => {
      if (seg >= starts.length || starts[seg] > t) seg = 0; // seeked backwards
      while (seg + 1 < starts.length && starts[seg + 1] <= t) seg++;
      return seg;
    };

    let raf = 0;
    let sig = "";
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const { spans = [], regions = [], mainKey = [null, false] } = view;
      const t = currentTrackId() === view.id ? (Spicetify.Player.getProgress?.() ?? 0) / 1000 : -1;
      const span = t >= 0 ? spans.find(([s, e]) => t >= s && t < e) : null;
      const region = t >= 0 && regions.length ? keyAt(regions, t) : null;
      const [tonic, minorKey] = region ? [region[2], region[3]] : mainKey;
      const pitches = pitchCache.get(view.id);
      const si = pitches && t >= 0 ? segmentAt(pitches.starts, t) : -1;
      const ac = audioCtx?.currentTime ?? 0;
      const synth = sounding.filter((n) => n.from <= ac && n.to > ac).map((n) => n.midi);
      const user = [...held.values()].map((h) => h.midi);
      const chord = span?.[2] ?? -1;
      const next = [si, chord, tonic, minorKey, synth, user, octave, keysEl.hidden].join("|");
      if (next === sig) return;
      sig = next;

      const tones = chord >= 0 ? voicing(chord) : [];
      const scale = tonic == null || tonic < 0 ? [] : SCALES[minorKey ? "minor" : "major"];
      for (const [m, k] of keys) {
        const pc = m % 12;
        const energy = si >= 0 ? pitches.pitches[si * 12 + pc] / 255 : 0;
        k.el.style.setProperty("--energy", (energy * energy).toFixed(2));
        const on = String(user.includes(m) || synth.includes(m));
        if (k.el.dataset.held !== on) k.el.dataset.held = on;
        const role = tones.includes(m) ? (pc === CHORDS[chord].root ? "root" : "tone") : "";
        if (k.el.dataset.chord !== role) k.el.dataset.chord = role;
        const d = scale.indexOf((pc - tonic + 12) % 12);
        const degree = d < 0 ? "" : String(d + 1);
        if (k.degree.textContent !== degree) k.degree.textContent = degree;
        k.el.dataset.tonic = String(d === 0);
        const code = Object.keys(KEYMAP).find((c) => octave + KEYMAP[c] === m);
        const cap = code ? keyCap(code) : "";
        if (k.cap.textContent !== cap) k.cap.textContent = cap;
      }

      const keyName = spellKey(tonic, minorKey);
      now.textContent =
        chord >= 0
          ? `Now ${spellChord(chord, tonic, minorKey)}  ${roman(chord, tonic, minorKey)} in ${keyName}`
          : t >= 0
            ? `Now —  in ${keyName}`
            : `Key ${keyName} · play the track to follow along`;
      const notes = [...new Set([...user, ...synth])].sort((a, b) => a - b);
      if (notes.length) {
        const found = identifyChord(notes);
        const fn = found && found.chord >= 0 ? functionOf(found.chord, tonic, minorKey) : null;
        you.textContent = `${notes.map((m) => noteName(m, tonic, minorKey)).join(" ")}${
          found ? `  =  ${chordLabel(found, tonic, minorKey)}  (${romanOf(found, tonic, minorKey)}${fn ? `, ${FUNCTION_NAMES[fn]}` : ""})` : ""
        }`;
      } else {
        you.textContent = `Play: A–' keys (W E T Y U O P = black), Z / X octave (A = C${octave / 12 - 1}), or click`;
      }
    };
    frame();

    return {
      el,
      destroy() {
        cancelAnimationFrame(raf);
        releaseAll();
        window.removeEventListener("keydown", onKeyDown, true);
        window.removeEventListener("keyup", onKeyUp, true);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("blur", releaseAll);
      },
    };
  }

  const CADENCE_NAMES = {
    authentic: "authentic cadence (V → I)",
    plagal: "plagal cadence (IV → I)",
    deceptive: "deceptive cadence (V → vi)",
    half: "half cadence (phrase ends on V)",
  };

  // Redraws the whole page from state; called again after edits, keeping the scroll position
  function drawHarmony(view) {
    const { root, body, id, res, meta, ui } = view;
    const scroll = root.scrollTop;
    clearInterval(pageTimer);
    body.replaceChildren();
    const redraw = () => drawHarmony(view);

    const feat = cache.get(id);
    const spans = applyCorrections(res.spans, corrections[id]);
    const regions = keyRegions(res, spans);
    // Main key = the region key covering the most time; it can differ from the hint when the chords disagree
    const keyTime = new Map();
    for (const [s, e, t, m] of regions) keyTime.set(t * 2 + (m ? 1 : 0), (keyTime.get(t * 2 + (m ? 1 : 0)) ?? 0) + e - s);
    const main = [...keyTime].sort((a, b) => b[1] - a[1])[0]?.[0];
    const tonic = main == null ? res.tonic : main >> 1;
    const minor = main == null ? res.minor : (main & 1) === 1;
    const keyOf = (t) => {
      const r = regions.length ? keyAt(regions, t) : null;
      return r ? [r[2], r[3]] : [tonic, minor];
    };
    Object.assign(view, { spans, regions, mainKey: [tonic, minor] });
    const rn = (c) => roman(c, tonic, minor);
    const nm = (c) => spellChord(c, tonic, minor);
    const tool = (text, title, onclick) => {
      const b = make("button", "bpmkey-tool", text);
      b.title = title;
      b.onclick = onclick;
      return b;
    };

    // Header
    body.appendChild(make("h1", null, meta?.name ?? "Harmony analysis"));
    if (meta?.artist) body.appendChild(make("p", "bpmkey-note", meta.artist));
    const hinted = tonic === res.tonic && minor === res.minor;
    const facts = [
      `Key ${spellKey(tonic, minor)} (${hinted ? `via ${res.keySrc}` : `from the chords; ${res.keySrc} says ${spellKey(res.tonic, res.minor)}`})`,
    ];
    if (feat?.t) facts.push(`${Math.round(feat.t)} BPM`);
    if (feat?.c) facts.push(feat.c);
    body.appendChild(make("p", null, facts.join(" · ")));
    const hints = flavorHints(spans, tonic, minor);
    if (hints.length) body.appendChild(make("p", null, `Color: ${hints.join(" · ")}`));
    body.appendChild(
      make(
        "p",
        "bpmkey-note",
        "Estimated from Spotify audio analysis (major/minor triads only, ~70% of the time right on reference songs). " +
          "Key changes are detected from the chords; the timeline's Roman numerals follow the local key. Fix wrong chords with ✎ Edit."
      )
    );

    // Key regions
    if (regions.length > 1) {
      body.appendChild(make("h2", null, "Key changes"));
      const list = make("div", "bpmkey-chips");
      regions.forEach(([rs, re, t, m], i) => {
        if (i) list.appendChild(make("span", "bpmkey-note", "→"));
        const b = make("button", "bpmkey-cadence", `${fmtTime(rs)}  ${spellKey(t, m)}`);
        b.title = `${spellKey(t, m)} ${m ? "minor" : "major"} ${fmtTime(rs)}–${fmtTime(re)} · click to play`;
        b.onclick = () => ((ui.sel = [rs, re]), playSpan(id, rs, re), markSelection());
        list.appendChild(b);
      });
      body.appendChild(list);
    }

    // Progressions
    const progs = topProgressions(spans);
    if (progs.length) {
      body.appendChild(make("h2", null, "Progressions"));
      for (const { chords, count } of progs) {
        const row = make("p", "bpmkey-prog");
        const play = make("button", "bpmkey-synth", "♪");
        play.title = "Play this progression (synthesized)";
        play.onclick = () => synthProgression(chords, feat?.t);
        const fns = chords.map((c) => functionOf(c, tonic, minor) ?? "·").join(" ");
        row.append(play, `${chords.map(nm).join(" → ")}`, make("small", null, `  ${chords.map(rn).join(" – ")}  [${fns}]  ×${count}`));
        body.appendChild(row);
      }
    }

    // Cadences
    // Per key region, so a modulation's own V → I counts in the new key
    const inRegion = (rs, re) => spans.filter(([s, e]) => (s + e) / 2 >= rs && (s + e) / 2 < re);
    const cadences = (regions.length ? regions : [[0, Infinity, tonic, minor]]).flatMap(([rs, re, t, m]) =>
      findCadences(inRegion(rs, re), t, m, res.sections).map((c) => ({ ...c, key: [t, m] }))
    );
    if (cadences.length) {
      body.appendChild(make("h2", null, "Cadences"));
      const counts = {};
      for (const c of cadences) counts[c.type] = (counts[c.type] ?? 0) + 1;
      body.appendChild(make("p", "bpmkey-note", Object.entries(counts).map(([t, n]) => `${t} ×${n}`).join(" · ")));
      const list = make("div", "bpmkey-chips");
      for (const { start, end, from, to, type, key } of cadences.slice(0, 24)) {
        const r = (c) => roman(c, ...key);
        const n = (c) => spellChord(c, ...key);
        const b = make("button", "bpmkey-cadence", `${fmtTime(start)}  ${r(from)}${to >= 0 ? ` → ${r(to)}` : ""}`);
        b.dataset.type = type;
        b.title = `${CADENCE_NAMES[type]} in ${spellKey(...key)} · ${n(from)}${to >= 0 ? ` → ${n(to)}` : ""} · click to play`;
        b.onclick = () => ((ui.sel = [start, end]), playSpan(id, start, end), markSelection());
        list.appendChild(b);
      }
      body.appendChild(list);
    }

    // Chord usage
    body.appendChild(make("h2", null, "Chord usage"));
    for (const { chord, share } of chordUsage(spans).slice(0, 8)) {
      // Named in the key where the chord first appears (C♯m in an A major bridge, not D♭m in C)
      const key = keyOf(spans.find(([, , c]) => c === chord)[0]);
      const nm = (c) => spellChord(c, ...key);
      const rn = (c) => roman(c, ...key);
      const pct = `${Math.round(share * 100)}%`;
      const track = make("div", "bpmkey-usage-track");
      track.appendChild(make("div", "bpmkey-usage-bar")).style.width = pct;
      const name = make("button", "bpmkey-synth", `♪ ${nm(chord)}`);
      name.title = "Play this chord (synthesized)";
      name.onclick = () => (stopSynth(), synthChord(chord));
      const fn = functionOf(chord, ...key);
      const inOtherKey = key[0] !== tonic || key[1] !== minor;
      const row = make("div", "bpmkey-usage-row");
      const label = make("small", null, `${rn(chord)}${fn ? ` ${fn}` : ""}`);
      if (inOtherKey) label.title = `in ${spellKey(...key)}`;
      row.append(name, label, track, make("small", null, pct));
      body.appendChild(row);
    }

    // Timeline toolbar
    body.appendChild(make("h2", null, "Timeline"));
    const bar = make("div", "bpmkey-toolbar");
    const editBtn = tool(ui.edit ? "✎ Editing — click a chord to fix it" : "✎ Edit", "Correct wrong chords", () => {
      ui.edit = !ui.edit;
      redraw();
    });
    editBtn.dataset.on = String(ui.edit);
    const loopBtn = tool(ui.loop ? "⟲ Loop on" : "⟲ Loop off", "Repeat the selected chords (A–B loop)", () => {
      ui.loop = loopEnabled = !ui.loop;
      redraw();
    });
    loopBtn.dataset.on = String(ui.loop);
    bar.append(editBtn, loopBtn);
    if (ui.sel) bar.appendChild(make("span", "bpmkey-note", `selected ${fmtTime(ui.sel[0])}–${fmtTime(ui.sel[1])}`));
    bar.appendChild(
      tool("Copy .lab", "Copy the (corrected) chord timeline in .lab format", async () => {
        const text = toLab(spans);
        try {
          await (Spicetify.Platform?.ClipboardAPI?.copy?.(text) ?? navigator.clipboard.writeText(text));
          Spicetify.showNotification?.("Chord timeline copied (.lab)");
        } catch {
          Spicetify.showNotification?.("Copy failed", true);
        }
      })
    );
    const fixes = corrections[id]?.length ?? 0;
    if (fixes) {
      bar.appendChild(
        tool(`Reset ${fixes} correction${fixes > 1 ? "s" : ""}`, "Forget your corrections for this track", () => {
          clearCorrections(id);
          redraw();
        })
      );
    }
    body.appendChild(bar);
    body.appendChild(
      make(
        "p",
        "bpmkey-note",
        "Click a chord to play that part (Shift+click another chord to select a range). ♪ = the chord itself, synthesized. " +
          "Border: blue = secondary dominant, orange = borrowed, red = chromatic. Dimmed = low confidence, ✓ = corrected."
      )
    );

    // Chips by section
    const merged = mergeSpans(spans);
    const nextChord = (s) => merged.find(([ms, , c]) => ms > s && c >= 0)?.[2] ?? -1;
    const chips = [];
    const sections = res.sections.length ? res.sections : [[0]];
    let prevKey = null;
    sections.forEach(([start], si) => {
      const end = sections[si + 1]?.[0] ?? Infinity;
      const head = make("div", "bpmkey-section", `${fmtTime(start)}  ·  ${spellKey(...keyOf(start))}`);
      const row = make("div", "bpmkey-chips");
      for (const [s, e, c, cf, corrected] of spans.filter(([s]) => s >= start && s < end)) {
        const key = keyOf(s);
        if (prevKey && key.join() !== prevKey.join()) {
          const mod = make("div", "bpmkey-modulation", `→ ${spellKey(...key)}`);
          mod.title = `key change: ${spellKey(...prevKey)} → ${spellKey(...key)}`;
          row.appendChild(mod);
        }
        prevKey = key;
        const rn = (x) => roman(x, ...key);
        const nm = (x) => spellChord(x, ...key);
        const info = explainChord(c, nextChord(s), ...key);
        const chip = make("div", "bpmkey-chip");
        if (info) chip.dataset.kind = info.kind;
        if (corrected) chip.dataset.corrected = "true";
        else if (cf < LOW_CONFIDENCE) chip.dataset.state = "low";

        if (ui.edit) {
          const select = make("select", "bpmkey-edit");
          const options = [[-1, "N (no chord)"], ...CHORDS.map((_, i) => [i, `${nm(i)}  ${rn(i)}`])];
          for (const [value, text] of options) {
            const o = make("option", null, text);
            o.value = String(value);
            o.selected = value === c;
            select.appendChild(o);
          }
          select.onchange = () => {
            setCorrection(id, s, e, Number(select.value));
            redraw();
          };
          chip.appendChild(select);
        } else {
          const seg = make("button", "bpmkey-chip-play");
          const sub = info?.label ?? `${rn(c)}${info?.fn ? ` ${info.fn}` : ""}`;
          seg.append(make("span", null, `${nm(c)}${corrected ? " ✓" : ""}`), make("small", null, sub || " "));
          seg.title = [
            `${fmtTime(s)}–${fmtTime(e)}`,
            info?.note,
            corrected ? "corrected by you" : `confidence ${cf}`,
            "click to play, Shift+click to extend the selection",
          ]
            .filter(Boolean)
            .join(" · ");
          seg.onclick = (ev) => {
            ui.sel = ev.shiftKey && ui.sel ? [Math.min(ui.sel[0], s), Math.max(ui.sel[1], e)] : [s, e];
            playSpan(id, ui.sel[0], ui.sel[1]);
            markSelection();
          };
          chip.appendChild(seg);
          if (c >= 0) {
            const tone = make("button", "bpmkey-synth", "♪");
            tone.title = `Play ${nm(c)} (synthesized)`;
            tone.onclick = () => (stopSynth(), synthChord(c));
            chip.appendChild(tone);
          }
        }
        row.appendChild(chip);
        chips.push([s, e, chip]);
      }
      body.append(head, row);
    });

    function markSelection() {
      for (const [s, e, chip] of chips) {
        const on = String(!!ui.sel && s >= ui.sel[0] && e <= ui.sel[1]);
        if (chip.dataset.selected !== on) chip.dataset.selected = on;
      }
    }
    const highlight = () => {
      const t = currentTrackId() === id ? (Spicetify.Player.getProgress?.() ?? 0) / 1000 : -1;
      for (const [s, e, chip] of chips) {
        const on = String(t >= s && t < e);
        if (chip.dataset.current !== on) chip.dataset.current = on;
      }
    };
    markSelection();
    highlight();
    pageTimer = setInterval(highlight, 250);
    root.scrollTop = scroll;
  }

  function registerContextMenu(tries = 0) {
    if (!Spicetify.ContextMenu?.Item) {
      if (tries < 50) setTimeout(() => registerContextMenu(tries + 1), 300);
      return;
    }
    new Spicetify.ContextMenu.Item(
      "Harmony analysis",
      ([uri]) => openHarmonyPage(uri.split(":")[2]),
      (uris) => uris.length === 1 && Spicetify.URI.isTrack(uris[0])
    ).register();
  }

  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  // ---- rendering ----

  function setBadge(badge, feat) {
    let head, camelot = null, color = null, title, state;
    if (feat === undefined) {
      [head, title, state] = ["…", "Loading", "loading"];
    } else if (feat === null) {
      [head, title, state] = ["–", "No BPM/Key data", "empty"];
    } else {
      const keyName = feat.n ? `${feat.n}${feat.minor ? "m" : ""}` : null;
      head = [Math.round(feat.t), keyName].filter(Boolean).join(" · ");
      [camelot, color] = [feat.c, feat.col];
      title = `${feat.t} BPM · ${keyName ?? "?"} (${feat.c ?? "?"}) · via ${feat.src ?? strategy}`;
      state = "ok";
    }
    // Skip DOM writes when unchanged so the MutationObserver doesn't loop
    const sig = [head, camelot, color].join("|");
    if (badge.dataset.sig !== sig) {
      badge.dataset.sig = sig;
      badge.textContent = camelot ? `${head} · ` : head;
      if (camelot) {
        const c = document.createElement("span");
        c.className = "bpmkey-camelot";
        c.textContent = camelot;
        if (color) c.style.color = color;
        badge.appendChild(c);
      }
    }
    if (badge.title !== title) badge.title = title;
    if (badge.dataset.state !== state) badge.dataset.state = state;
  }

  const makeBadge = (extraClass) => {
    const el = document.createElement("span");
    el.className = `bpmkey-badge ${extraClass}`;
    return el;
  };

  function trackIdOf(row) {
    const href = row.querySelector('a[href*="/track/"]')?.getAttribute("href");
    const m = href?.match(/\/track\/([A-Za-z0-9]{22})/);
    if (m) return m[1];
    // Rows without a title link (e.g. album pages) carry the uri in React props
    const fiberKey = Object.keys(row).find((k) => k.startsWith("__reactFiber$"));
    for (let f = fiberKey && row[fiberKey], i = 0; f && i < 20; f = f.return, i++) {
      const uri = f.memoizedProps?.uri;
      if (typeof uri === "string" && uri.startsWith("spotify:track:")) return uri.split(":")[2];
    }
    return null;
  }

  function renderRow(row) {
    const id = trackIdOf(row);
    let badge = row.querySelector(".bpmkey-row");
    if (!id) {
      badge?.remove();
      return;
    }
    const cells = row.querySelectorAll('[role="gridcell"]');
    const last = cells[cells.length - 1];
    if (!last) return;
    // Rows like "Recommended" end with a narrow "Add" button cell instead of the duration;
    // squeezing the badge in there wraps the button text, so use the previous cell instead
    const buttonOnly = last.querySelector("button") && !/\d:\d\d/.test(last.textContent) && cells.length > 1;
    const target = buttonOnly ? cells[cells.length - 2] : last;
    if (!badge) badge = makeBadge("bpmkey-row");
    // Virtualized rows get reused across row types, so move the badge if its cell changed
    if (badge.parentElement !== target) {
      badge.classList.toggle("bpmkey-row-inline", buttonOnly);
      if (buttonOnly) target.appendChild(badge);
      else target.prepend(badge);
    }
    if (!cache.has(id)) request(id);
    setBadge(badge, cache.get(id));
  }

  function renderNowPlaying() {
    const widget =
      document.querySelector('[data-testid="now-playing-widget"]') ??
      document.querySelector(".main-nowPlayingWidget-nowPlaying");
    if (!widget) return;
    const id = currentTrackId();
    let badge = widget.querySelector(".bpmkey-now");
    if (!id) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = makeBadge("bpmkey-now");
      badge.onclick = () => openHarmonyPage(currentTrackId());
      widget.appendChild(badge);
    }
    if (!cache.has(id)) request(id);
    setBadge(badge, cache.get(id));
  }

  function render() {
    document.querySelectorAll('[role="row"]').forEach(renderRow);
    renderNowPlaying();
  }

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      render();
    });
  };

  const style = document.createElement("style");
  style.textContent = `
    .bpmkey-badge {
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      color: var(--spice-subtext, #b3b3b3);
      white-space: nowrap;
    }
    .bpmkey-badge[data-state="loading"] { opacity: .4; }
    .bpmkey-row { min-width: 104px; margin-right: 16px; text-align: right; flex-shrink: 0; }
    .bpmkey-row-inline { margin-left: auto; }
    [role="gridcell"]:has(> .bpmkey-row-inline) { display: flex; align-items: center; min-width: 0; }
    [role="gridcell"]:has(> .bpmkey-row-inline) > :not(.bpmkey-row) { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .bpmkey-now { margin-left: 12px; cursor: pointer; }
    .bpmkey-page {
      position: fixed; inset: 0; z-index: 1000; overflow-y: auto; padding: 48px 32px;
      background: var(--spice-main, #121212); color: var(--spice-text, #fff);
    }
    .bpmkey-page-body { max-width: 960px; margin: 0 auto; padding-bottom: 200px; }
    .bpmkey-page-close {
      position: fixed; top: 16px; right: 24px; width: 32px; height: 32px; border: 0; border-radius: 50%;
      background: var(--spice-card, #282828); color: var(--spice-text, #fff); cursor: pointer;
    }
    .bpmkey-page h1 { margin: 0 0 4px; font-size: 32px; }
    .bpmkey-page h2 { margin: 28px 0 8px; font-size: 18px; }
    .bpmkey-page p { margin: 0 0 8px; }
    .bpmkey-prog small, .bpmkey-usage-row small { color: var(--spice-subtext, #b3b3b3); }
    .bpmkey-usage-row { display: grid; grid-template-columns: 56px 40px 1fr 40px; gap: 8px; align-items: center; margin-bottom: 4px; }
    .bpmkey-usage-track { height: 8px; border-radius: 4px; background: var(--spice-card, #282828); }
    .bpmkey-usage-bar { height: 100%; border-radius: 4px; background: var(--spice-button, #1db954); }
    .bpmkey-chip[data-state="low"], .bpmkey-section[data-state="low"] { opacity: .5; }
    .bpmkey-chip[data-current="true"] { outline: 2px solid var(--spice-button, #1db954); opacity: 1; }
    .bpmkey-note { font-size: 12px; color: var(--spice-subtext, #b3b3b3); }
    .bpmkey-section { margin: 16px 0 6px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .bpmkey-chips { display: flex; flex-wrap: wrap; gap: 4px; }
    .bpmkey-chip {
      display: flex; flex-direction: column; align-items: center; min-width: 48px; padding: 2px;
      border-radius: 4px; background: var(--spice-card, #282828);
    }
    .bpmkey-chip-play {
      display: flex; flex-direction: column; align-items: center; width: 100%; padding: 2px 4px;
      border: 0; background: none; color: var(--spice-text, #fff); cursor: pointer;
    }
    .bpmkey-chip small { font-size: 10px; color: var(--spice-subtext, #b3b3b3); }
    .bpmkey-synth {
      border: 0; border-radius: 4px; padding: 0 6px; margin-right: 6px; background: none;
      color: var(--spice-button, #1db954); cursor: pointer; font: inherit; text-align: left;
    }
    .bpmkey-chip .bpmkey-synth { margin: 0; font-size: 11px; }
    .bpmkey-synth:hover, .bpmkey-chip-play:hover, .bpmkey-tool:hover, .bpmkey-cadence:hover { background: rgba(255, 255, 255, .1); }
    .bpmkey-chip { border: 2px solid transparent; }
    .bpmkey-chip[data-kind="secondary"] { border-color: #4f9dff; }
    .bpmkey-chip[data-kind="borrowed"] { border-color: #ff9f43; }
    .bpmkey-chip[data-kind="chromatic"] { border-color: #ff5c5c; }
    .bpmkey-chip[data-selected="true"] { background: rgba(29, 185, 84, .25); }
    .bpmkey-chip[data-corrected="true"] span { text-decoration: underline dotted; }
    .bpmkey-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; }
    .bpmkey-tool, .bpmkey-cadence {
      border: 1px solid var(--spice-subtext, #b3b3b3); border-radius: 14px; padding: 2px 10px;
      background: none; color: var(--spice-text, #fff); cursor: pointer; font-size: 12px; font-variant-numeric: tabular-nums;
    }
    .bpmkey-tool[data-on="true"] { border-color: var(--spice-button, #1db954); color: var(--spice-button, #1db954); }
    .bpmkey-cadence[data-type="authentic"] { border-color: #1db954; }
    .bpmkey-cadence[data-type="plagal"] { border-color: #4f9dff; }
    .bpmkey-cadence[data-type="deceptive"] { border-color: #ff9f43; }
    .bpmkey-modulation { align-self: center; padding: 0 6px; color: #c58bff; font-size: 12px; font-weight: 700; }
    .bpmkey-piano {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 1001; padding: 8px 32px 12px;
      background: var(--spice-main, #121212); border-top: 1px solid rgba(255, 255, 255, .1); box-shadow: 0 -8px 24px rgba(0, 0, 0, .5);
    }
    .bpmkey-piano-head {
      display: flex; align-items: center; gap: 16px; max-width: 960px; margin: 0 auto 6px;
      font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap;
    }
    .bpmkey-piano-now { font-weight: 700; }
    .bpmkey-piano-you { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--spice-subtext, #b3b3b3); }
    .bpmkey-piano-keys { position: relative; max-width: 960px; height: 110px; margin: 0 auto; user-select: none; touch-action: none; }
    .bpmkey-key {
      position: absolute; top: 0; height: 100%; box-sizing: border-box; display: flex; flex-direction: column;
      justify-content: flex-end; align-items: center; padding-bottom: 3px; border: 1px solid #222; border-radius: 0 0 4px 4px;
      background: #e8e8e8; color: #333; cursor: pointer;
    }
    .bpmkey-key-black { z-index: 1; height: 62%; background: #181818; color: #bbb; border-color: #000; }
    /* live pitch-class energy of the current segment */
    .bpmkey-key::before {
      content: ""; position: absolute; top: 3px; left: 2px; right: 2px; height: 18%; border-radius: 2px;
      background: #1db954; opacity: var(--energy, 0);
    }
    .bpmkey-key[data-chord="tone"] { background: #a7dcb7; }
    .bpmkey-key[data-chord="root"] { background: #57c27a; }
    .bpmkey-key-black[data-chord="tone"] { background: #2f7a49; }
    .bpmkey-key-black[data-chord="root"] { background: #1db954; }
    .bpmkey-key[data-held="true"] { background: #ffcc4d; }
    .bpmkey-key-black[data-held="true"] { background: #d9a400; }
    .bpmkey-key small { font-size: 9px; line-height: 1.25; pointer-events: none; }
    .bpmkey-key-cap { opacity: .55; }
    .bpmkey-key[data-tonic="true"] .bpmkey-key-degree { color: #0b7a34; font-weight: 700; }
    .bpmkey-key-black[data-tonic="true"] .bpmkey-key-degree { color: #7dffa8; }
    .bpmkey-key-octave { opacity: .5; }
    .bpmkey-edit { background: var(--spice-main, #121212); color: var(--spice-text, #fff); border: 0; font: inherit; font-size: 12px; }
  `;
  document.head.appendChild(style);

  // Virtualized lists reuse row DOM, so also watch href and text changes
  new MutationObserver(schedule).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["href"],
  });
  Spicetify.Player.addEventListener("songchange", schedule);
  registerContextMenu();
  schedule();

  window.__bpmKey = {
    cache,
    chordCache,
    params: PARAMS,
    analyzeChords,
    topProgressions,
    chordUsage,
    chordName,
    functionOf,
    spellChord,
    explainChord,
    findCadences,
    flavorHints,
    localKeys,
    keyRegions,
    identifyChord,
    chordLabel,
    romanOf,
    applyCorrections,
    toLab,
    get corrections() {
      return corrections;
    },
    openHarmonyPage,
    get strategy() {
      return strategy;
    },
    reset() {
      cache.clear();
      chordCache.clear();
      strategy = null;
      disabled = false;
      detectFailures = 0;
      try {
        localStorage.removeItem(CACHE_KEY);
        localStorage.removeItem(STRATEGY_KEY);
        localStorage.removeItem(CHORD_CACHE_KEY);
      } catch {}
      schedule();
    },
  };

  console.log(`${TAG} loaded`);
})();
