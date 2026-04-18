# Agent Notes

## Babel Helper Extension

Before changing this repo, read these local docs first:
- `docs/babel-dashboard-snapshot/README.md`
- `docs/babel-dashboard-snapshot/extension-engineering.md`

Reason:
- The Babel dashboard has several non-obvious traps that are easy to rediscover badly.

Known trap: playback transport
- Do not assume the visible `audio` element is the real playback transport.
- In live debugging, Babel exposed a dummy `audio` element with no real media source while playback was actually driven by Wavesurfer instances stored in React hook state on waveform hosts.
- When that transport is owned by page React objects, a content-script-only seek can still be misleading. Use a page-world bridge if the direct helper appears to "succeed" without moving the real player.
- If native playback controls work but custom rewind/seek does nothing, inspect the real transport path before changing hotkeys again.

Workflow expectation
- Prefer native Babel controls when possible.
- After changing the extension content script, reload the unpacked extension and refresh the Babel dashboard tab before judging behavior.
- When touching playback, rewind, seek, or hotkeys, re-check the live page behavior against the docs above.
