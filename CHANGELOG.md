# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The public surface is now only what an application needs; everything else is
internal. 0.2.0 is deprecated.

### Removed (breaking)

- Every export but `createVoqalizeTransport`, `VoqalizeMediaManager`,
  `attachTrackChangedHandler` and the `VoqalizeTransportOptions` type: the
  `PlayoutGuard` class and its types, `normalizeDeviceError`, the
  `ENCODING_POLICY`, `CAMERA_CONSTRAINTS` and `SCREEN_CONSTRAINTS` constants,
  and the platform and pipecat structural types.
- `createVoqalizeTransport({ media })` and `transport.voqalizeMedia`. Construct
  the manager and pass it as `mediaManager` to reach `bindOutputElement()`.
- The manager's options. `new VoqalizeMediaManager()` takes none.
- `onPlaybackBlocked`, `onPlaybackRecovered`, `playoutGuard` and
  `resumePlayback()`, along with `playbackBlocked`, `setStatsSource()`,
  `setLocalTrackChangedHandler()`, `destroy()`, `encodingPolicy()`,
  `requestedMicId`, `requestedCamId` and `captureTracks()` on the manager.

### Changed

- A bound element the browser refused to play is retried from the user's next
  `pointerdown` or `keydown` on the page, by the manager. No app code.

## [0.2.0] — 2026-10-06

### Added

- Playout recovery for bound output elements. When packets for the element's
  track arrive and nothing is played, or the element raises `error`, the
  manager re-attaches the same track and plays it again, and reports it
  through `media.onPlaybackRecovered`. Measured on Android Chrome, where a
  page taking over a live call played nothing.
  [The measurement](docs/FINDINGS.md#android-chrome-stops-playing-a-taken-over-call).
  `media.playoutGuard` tunes it or, with `false`, turns it off.
- `PlayoutGuard`, the same logic for an element the manager does not own.
- `VoqalizeMediaManager.setStatsSource()`, which `attachTrackChangedHandler`
  now calls with the peer connection's `getStats`.

## [0.1.0] — 2026-09-07

First release.

### Added

- `VoqalizeMediaManager` — an implementation of pipecat's `MediaManager`
  protocol that owns the microphone, camera and screen share using nothing but
  `navigator.mediaDevices`.
- `createVoqalizeTransport()` — a stock `SmallWebRTCTransport` with the manager
  injected _and wired_. Injection alone is not enough; see
  [the injection seam](docs/DESIGN.md#the-injection-seam).
- `attachTrackChangedHandler()` — that wiring on its own, for an application
  that builds its transport elsewhere.
- Three fixed `sendonly` transceivers (audio, camera, screen) created before
  the first offer, so starting or stopping a screen share mid-call never
  renegotiates.
- Per-lane encoder policy: speech/32 kbps for the mic, motion +
  `maintain-framerate` for the camera, detail + `maintain-resolution` at
  1080p/5 fps for the screen.
- A watchdog that republishes a clone the transport stopped underneath us —
  without it, every reconnect leaves the call `connected` and silent.
  [The measurement](docs/FINDINGS.md#every-reconnect-left-the-call-connected-and-silent).
- Speaker routing (`bindOutputElement`) and blocked-autoplay recovery
  (`resumePlayback`), neither of which pipecat's callback surface has a place
  for.
- 70 contract cases run in two harnesses — node with a fake `MediaDevices`, and
  chromium/firefox/webkit with real ones — plus a controllable UDP relay that
  breaks and moves the network path under a live call.

[Unreleased]: https://github.com/voqalize/voqalize-client-transport/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/voqalize/voqalize-client-transport/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/voqalize/voqalize-client-transport/releases/tag/v0.1.0
