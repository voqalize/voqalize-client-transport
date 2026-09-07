# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-09-07

First release. Extracted from the harness it was developed in, with the test
suite intact.

### Added

- `VoqalizeMediaManager` — a `MediaManager` for pipecat's
  `SmallWebRTCTransport` that owns the microphone, camera and screen share
  using nothing but `navigator.mediaDevices`. No `@daily-co/daily-js`, and no
  script fetched from a third-party origin at runtime.
- `createVoqalizeTransport()` — a stock `SmallWebRTCTransport` with the manager
  injected _and wired_. Injection alone is not enough: pipecat passes its
  `replaceTrack` callback into the `DailyMediaManager` constructor, so an
  injected manager receives nothing and mid-call device switches never reach a
  sender. See [docs/DESIGN.md](docs/DESIGN.md#the-injection-seam).
- `attachTrackChangedHandler()` — that wiring on its own, for an application
  that builds its transport elsewhere.
- Three fixed `sendonly` transceivers (audio, camera, screen) created before
  the first offer, so starting or stopping a screen share mid-call never
  renegotiates.
- Per-lane encoder policy: speech/32 kbps for the mic, motion +
  `maintain-framerate` for the camera, and detail + `maintain-resolution` at
  1080p/5 fps for the screen, because a blurry shared screen is a broken
  feature and a slow one is not.
- A watchdog that republishes a clone the transport stopped underneath us —
  without it, every pipecat reconnect leaves the call `connected` and silent.
  See [docs/FINDINGS.md](docs/FINDINGS.md#every-reconnect-left-the-call-connected-and-silent).
- Speaker routing (`bindOutputElement`) and blocked-autoplay recovery
  (`resumePlayback`), neither of which pipecat's callback surface has a place
  for.
- 79 contract cases run in two harnesses (node with a fake `MediaDevices`, and
  chromium/firefox/webkit with real ones), plus a controllable UDP relay that
  breaks and moves the network path under a live call.

[Unreleased]: https://github.com/voqalize/voqalize-client-transport/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/voqalize/voqalize-client-transport/releases/tag/v0.1.0
