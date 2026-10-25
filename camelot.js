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
    if (!badge) {
      const cells = row.querySelectorAll('[role="gridcell"]');
      const last = cells[cells.length - 1];
      if (!last) return;
      badge = makeBadge("bpmkey-row");
      last.prepend(badge);
    }
    if (!cache.has(id)) request(id);
    setBadge(badge, cache.get(id));
  }

  function renderNowPlaying() {
    const widget =
      document.querySelector('[data-testid="now-playing-widget"]') ??
      document.querySelector(".main-nowPlayingWidget-nowPlaying");
    if (!widget) return;
    const uri = Spicetify.Player.data?.item?.uri ?? Spicetify.Player.data?.track?.uri;
    let badge = widget.querySelector(".bpmkey-now");
    if (!uri || !Spicetify.URI.isTrack(uri)) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = makeBadge("bpmkey-now");
      widget.appendChild(badge);
    }
    const id = uri.split(":")[2];
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
    .bpmkey-row { min-width: 104px; margin-right: 16px; text-align: right; }
    .bpmkey-now { margin-left: 12px; }
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
  schedule();

  window.__bpmKey = {
    cache,
    get strategy() {
      return strategy;
    },
    reset() {
      cache.clear();
      strategy = null;
      disabled = false;
      detectFailures = 0;
      try {
        localStorage.removeItem(CACHE_KEY);
        localStorage.removeItem(STRATEGY_KEY);
      } catch {}
      schedule();
    },
  };

  console.log(`${TAG} loaded`);
})();
