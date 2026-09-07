# @voqalize/client-transport

Local media for [pipecat](https://github.com/pipecat-ai/pipecat)'s
`SmallWebRTCTransport`.

[![CI](https://github.com/voqalize/voqalize-client-transport/actions/workflows/ci.yml/badge.svg)](https://github.com/voqalize/voqalize-client-transport/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@voqalize/client-transport.svg)](https://www.npmjs.com/package/@voqalize/client-transport)
[![license](https://img.shields.io/npm/l/@voqalize/client-transport.svg)](./LICENSE)

`SmallWebRTCTransport` ships with a proprietary `MediaManager` as its default;
this is an open implementation of the same `MediaManager` protocol, built on
`navigator.mediaDevices` alone.

```bash
npm install @voqalize/client-transport
```

## Use it

```ts
import { PipecatClient } from "@pipecat-ai/client-js";
import { createVoqalizeTransport } from "@voqalize/client-transport";

const transport = createVoqalizeTransport({
  webrtcRequestParams: { endpoint: "https://your-server.example.com/api/offer" },
});

const client = new PipecatClient({ transport, enableMic: true, enableCam: false });
await client.connect();
```

Everything else stays as it is. `client.enableMic()`, `client.updateCam()`,
`client.enableScreenShare()`, `client.getAllMics()` and the `onTrackStarted` /
`onDeviceError` callbacks all behave the way pipecat documents them, because
this is pipecat's own transport with one class swapped out.

`createVoqalizeTransport` accepts every `SmallWebRTCTransport` option, plus
`media` for the manager's own settings:

```ts
const transport = createVoqalizeTransport({
  webrtcRequestParams: { endpoint: "https://your-server.example.com/api/offer" },
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  media: {
    // The camera light staying on after the user turns the camera off is a
    // trust problem, so the device is released by default. The microphone is
    // held, because re-acquiring it costs a gap in the conversation.
    releaseCamOnDisable: true,
    releaseMicOnDisable: false,
    onPlaybackBlocked: (blocked) => setShowTapToListen(blocked),
  },
});
```

### Two things pipecat has no channel for

**Speaker routing.** `updateSpeaker()` selects a device; something has to apply
it to the element that plays the bot. Hand the manager your audio element and
it applies the current sink and re-applies it on every later change:

```ts
const detach = transport.voqalizeMedia.bindOutputElement(audioEl);
detach(); // on unmount
```

**Blocked autoplay.** A browser that has not seen a user gesture refuses to
play the bot's audio, silently. The manager detects the refusal, reports it
through `media.onPlaybackBlocked`, and `resumePlayback()` retries every bound
element from inside a real click.

### If you build your transport somewhere else

Use the manager directly — but wire it, or mid-call device switches will never
reach the peer connection. This is not optional; see
[the injection seam](docs/DESIGN.md#the-injection-seam).

```ts
import { VoqalizeMediaManager, attachTrackChangedHandler } from "@voqalize/client-transport";

const mediaManager = new VoqalizeMediaManager();
const transport = new SmallWebRTCTransport({ ...yourOptions, mediaManager } as never);
attachTrackChangedHandler(transport, mediaManager);
```

## What it does that a thin wrapper would not

- **Publishes a clone, keeps the original.** The peer connection is handed
  `track.clone()`; the manager owns the capture track. pipecat stops sender
  tracks when it rebuilds a peer connection, and it rebuilds one on every
  reconnect — without this, reconnecting kills the microphone.
- **Republishes a clone that was stopped underneath it.** The failure is
  silent: `connected`, three m-lines, capture `live`, `packetsSent: 0` forever.
  [The measurement, and why the fix has to be a poll](docs/FINDINGS.md#every-reconnect-left-the-call-connected-and-silent).
- **Fixes the SDP shape.** Three `sendonly` transceivers — mic, camera, screen
  — created before the first offer. Starting a screen share mid-call adds no
  m-line and triggers no renegotiation.
- **Tunes each lane for what it carries.** Speech at 32 kbps on the mic;
  `maintain-framerate` on the camera; `maintain-resolution` at 1080p and 5 fps
  on the screen, because a shared screen is read, not watched.
- **Serializes every mutation.** One queue. pipecat's interface declares
  `enableMic`/`updateCam` as returning `void`, so the transport never awaits a
  device switch and a user double-clicking a toggle would otherwise interleave
  two `getUserMedia` calls against one device.
- **Recovers from the things that actually happen.** A device that vanishes
  mid-acquire, a track that mutes and never unmutes, a `devicechange` burst
  Chrome fires before `enumerateDevices()` settles, a headset unplugged
  mid-sentence, the browser's own "Stop sharing" button.

## What it does not do

- **No screen audio.** pipecat's `MediaManager` has a `screenVideo` member and
  no `screenAudio`; capturing tab audio would need a fourth transceiver the
  interface cannot describe, and it would put system audio into the echo
  canceller's reference path.
- **No Web Audio in the capture path.** A local level meter that routes the mic
  through an `AudioContext` opens an output device and sits in the AEC path.
  `userStartedSpeaking()` and `bufferBotAudio()` are inert here; VAD belongs on
  the server.
- **No transport of its own.** Signalling, ICE, reconnection and renegotiation
  are all still pipecat's.

## Requirements

|                                      |                                                              |
| ------------------------------------ | ------------------------------------------------------------ |
| `@pipecat-ai/client-js`              | `>=1.13.0 <2` (peer)                                         |
| `@pipecat-ai/small-webrtc-transport` | `>=1.10.0 <2` (peer)                                         |
| Browsers                             | Chromium, Firefox and WebKit/Safari, all tested every commit |

This is a browser package. It is built for a page, has no Node entry point and
declares no `engines` — Node appears here only as the tool that builds and
tests it.

Both pipecat packages are peer dependencies and are never bundled — a second
copy in your tree would break `instanceof DeviceError`.

## More

[docs/DESIGN.md](docs/DESIGN.md) — the decisions the implementation turns on.
[docs/FINDINGS.md](docs/FINDINGS.md) — what was measured rather than assumed.
[CONTRIBUTING.md](CONTRIBUTING.md) — running the suites locally.

MIT © Voqalize. See [LICENSE](./LICENSE).
