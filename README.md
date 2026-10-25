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

## Caveats

- This relies on **undocumented internal Spotify APIs** and on the client's DOM structure. Either can change with any Spotify update.
- `AUDIO_ATTRIBUTES_V2` may be unavailable on accounts or regions without Mix.
- Modifying the Spotify client is against Spotify's Terms of Use. Use at your own risk.

## Debug

In DevTools (`spicetify enable-devtools`, then `Cmd+Opt+I`):

```js
__bpmKey.strategy   // currently selected source
__bpmKey.reset()    // clear cache and re-detect the source
```

## License

MIT
