// Loads camelot.js outside Spotify with just enough stubs to reach window.__bpmKey.

import { readFileSync } from "node:fs";
import vm from "node:vm";

const SOURCE = new URL("../camelot.js", import.meta.url);

const node = () => ({
  children: [],
  dataset: {},
  style: {},
  classList: { toggle() {}, add() {}, remove() {} },
  appendChild: (c) => c,
  append() {},
  prepend() {},
  replaceChildren() {},
  remove() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
});

export function loadExtension({ spicetify = {}, extra = {} } = {}) {
  const ctx = {
    console: { log() {}, debug() {}, warn: console.warn, error: console.error },
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: () => {},
    MutationObserver: class {
      observe() {}
    },
    document: {
      body: node(),
      head: node(),
      createElement: node,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
    },
    Spicetify: {
      CosmosAsync: { get: async () => ({ error: { status: 404 } }) },
      Player: { addEventListener() {}, data: {}, getProgress: () => 0 },
      URI: { isTrack: () => true },
      ...spicetify,
    },
    ...extra,
  };
  ctx.window = ctx;
  vm.runInNewContext(readFileSync(SOURCE, "utf8"), ctx, { filename: "camelot.js" });
  return ctx.window.__bpmKey;
}
