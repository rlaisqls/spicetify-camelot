# spicetify-camelot

A [Spicetify](https://spicetify.app) extension that shows **BPM, key and Camelot notation** next to every track: in playlists, albums, search results, artist pages and the now-playing bar.

```
Billie Jean  Michael Jackson   117 · F♯m · 11A  4:54
```

Spotify's own BPM/Key columns only appear in Mix-enabled playlists. This extension puts the same data everywhere.

## Install

```sh
cp camelot.js ~/.config/spicetify/Extensions/
spicetify config extensions camelot.js
spicetify apply
```

## How it works

Data sources are tried in order, and the first one that works is remembered:

| Strategy | Source |
|---|---|
| `mix-attributes-v2` | `Spicetify.Platform.PlaylistMixingAPI` metadata extension kind `222` (`AUDIO_ATTRIBUTES_V2`), the same data the Mix UI shows, including Camelot color |
| `spclient-features-batch` | `spclient.wg.spotify.com/audio-attributes/v1/audio-features?ids=` (up to 100 tracks per request) |
| others | Web API `audio-features` / `audio-analysis`, spclient `audio-analysis`, `Spicetify.getAudioData` |

Tracks missing from `AUDIO_ATTRIBUTES_V2` fall back to `spclient-features-batch`. Hover a value to see which source it came from.

Results are cached in `localStorage` (up to 20,000 tracks), and only visible rows are requested.

### Accuracy

The legacy `audio-features` key can differ from the Mix UI. For example, *Billie Jean* comes back as B minor (10A) from `audio-features`, while the Mix UI shows F♯ minor (11A), which is the commonly cited key. That's why `AUDIO_ATTRIBUTES_V2` is preferred.

Neither source is ground truth. Check by ear or with a dedicated analyzer when it matters.

## Chords (experimental)

Right-click a track and choose **Harmony analysis**, or click the BPM/Key badge in the now-playing bar, to open a full-page harmony analysis. Press Esc to close.

- **Progressions**: the most repeated 4-chord loops with Roman numerals and functions (T/S/D). ♪ plays them synthesized at the track tempo.
- **Cadences**: authentic (V→I), plagal (IV→I), deceptive (V→vi) and half cadences. Click one to hear it.
- **Color**: modal hints such as Dorian (major IV in minor), Mixolydian (♭VII in major), modal mixture, or secondary dominants.
- **Timeline**: chords per section. The border shows secondary dominants (blue, e.g. `V/V`), borrowed chords (orange, e.g. `♭VII`) and chromatic chords (red). Hover a chord for an explanation.
  - Click a chord to play that part of the track. Shift+click a second chord to select a range, and turn on **⟲ Loop** to repeat it (A–B loop).
  - ♪ plays the chord itself (synthesized).
  - **✎ Edit** lets you fix wrong chords. Corrections are stored per time range, so they survive estimator updates. **Copy .lab** copies the corrected timeline.

Audio analysis is fetched only when the page is opened, and the result is cached for the last 100 tracks.

### How chords are estimated

Chords are estimated from `audio-analysis` segment chroma (`segments[].pitches`):

1. Each half-bar averages segment chroma, weighted by loudness and down-weighting flat (drum-like) segments.
2. Each window is averaged with the windows whose surrounding context looks most alike (the same spot in other verses/choruses), which cancels noise between repetitions.
3. The result is matched against 24 major/minor triads (root-weighted templates), with a small bonus for chords in the key (from the Mix data when available).
4. Viterbi smoothing keeps the chord from flickering.

Only triads are detected (no 7ths, inversions or slash chords), and Roman numerals use one key for the whole track, so modulations show up as chromatic chords. Treat it as a hint, not a transcription.

### Accuracy

Scored against time-aligned [Isophonics](http://isophonics.net/content/reference-annotations-beatles) reference annotations of 20 Beatles songs (majmin, duration-weighted):

| | Before tuning | Now |
|---|---|---|
| 10 songs used for tuning | 65.9% | 76.6% |
| 10 held-out songs | 62.8% | **68.8%** |

The held-out number is the realistic expectation. Expect lower on dense modern productions.

## Caveats

- This relies on **undocumented internal Spotify APIs** and on the client's DOM structure. Either can change with any Spotify update.
- `AUDIO_ATTRIBUTES_V2` may be unavailable on accounts or regions without Mix.
- Modifying the Spotify client is against Spotify's Terms of Use. Use at your own risk.

## Debug

In DevTools (`spicetify enable-devtools`, then `Cmd+Opt+I`):

```js
__bpmKey.strategy   // currently selected source
__bpmKey.reset()    // clear cache and re-detect the source
__bpmKey.params     // chord estimator tuning
```

## Development

```sh
npm test            # unit tests (estimator on synthetic data, music theory, corrections)
npm run eval        # score the chord estimator against test/fixtures (both key settings)
node test/eval.mjs --key=analysis --param switchPenalty=0.2   # try a parameter
```

`test/fixtures` holds, per song, Isophonics chord/key annotations (`<slug>.lab`, `<slug>.key.lab`) and the Spotify audio analysis (`<slug>.analysis.json`). Songs in `songs.json` are split into `tune` (used to choose `PARAMS`) and `holdout` (never used for tuning; report this number).

Fixtures are exported from the running client through the DevTools port (`spicetify enable-devtools`):

```sh
node scripts/export-fixtures.mjs                 # analyses for songs.json
node scripts/export-fixtures.mjs --corrections   # your ✎ corrections → user-<id> fixtures (only corrected ranges are scored)
```

Reference annotations: C. Harte et al., *Isophonics* reference annotations for The Beatles (Centre for Digital Music, Queen Mary University of London).

## License

MIT
