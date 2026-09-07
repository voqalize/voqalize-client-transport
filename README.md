# @voqalize/client-transport

Local media for [pipecat](https://github.com/pipecat-ai/pipecat)'s
`SmallWebRTCTransport`, without Daily.

[![CI](https://github.com/voqalize/voqalize-client-transport/actions/workflows/ci.yml/badge.svg)](https://github.com/voqalize/voqalize-client-transport/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@voqalize/client-transport.svg)](https://www.npmjs.com/package/@voqalize/client-transport)
[![license](https://img.shields.io/npm/l/@voqalize/client-transport.svg)](./LICENSE)

`SmallWebRTCTransport` does not run on Daily's infrastructure — it talks to your
own pipecat server over plain WebRTC. But its default `MediaManager` is
`DailyMediaManager`, so installing it pulls in `@daily-co/daily-js`, and that
package fetches JavaScript from `daily.co` at runtime and evaluates it. You get
a third-party origin in your media path, a `Content-Security-Policy` you cannot
write, and a proprietary dependency, in exchange for a microphone.

This package replaces that one class. It uses `navigator.mediaDevices` and
nothing else: no room engine, no remote code, no vendor.

```bash
npm install @voqalize/client-transport
```

## Use it

Three lines, in the place you build your transport today.

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
// on unmount
detach();
```

**Blocked autoplay.** A browser that has not seen a user gesture refuses to
play the bot's audio, silently. The manager detects the refusal, reports it
through `media.onPlaybackBlocked`, and retries every bound element from a real
click:

```tsx
{
  blocked && (
    <button onClick={() => transport.voqalizeMedia.resumePlayback()}>
      Tap to hear the assistant
    </button>
  );
}
```

### If you build your transport somewhere else

Use the manager directly — but wire it, or mid-call device switches will never
reach the peer connection. This is not optional; see
[the injection seam](docs/DESIGN.md#the-injection-seam) for why pipecat leaves
that half undone for any manager but its own.

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
- **Republishes a clone that was stopped underneath it.** Publishing a clone
  turns out to be necessary and not sufficient, and the failure is silent:
  `connected`, three m-lines, capture `live`, and `packetsSent: 0` forever.
  [The measurement, and why the fix has to be a poll](docs/FINDINGS.md#every-reconnect-left-the-call-connected-and-silent).
- **Fixes the SDP shape.** Three `sendonly` transceivers — mic, camera, screen —
  created before the first offer. Starting a screen share mid-call adds no
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
- **No transport of its own.** This is pipecat's `SmallWebRTCTransport`, not a
  fork of it. Signalling, ICE, reconnection and renegotiation are all still
  pipecat's.

## Requirements

|                                       |                                                              |
| ------------------------------------- | ------------------------------------------------------------ |
| `@pipecat-ai/client-js`               | `>=1.13.0 <2` (peer)                                         |
| `@pipecat-ai/small-webrtc-transport`  | `>=1.10.0 <2` (peer)                                         |
| Browsers                              | Chromium, Firefox and WebKit/Safari, all tested every commit |
| Node (for the build and tier‑1 tests) | 20+                                                          |

Both pipecat packages are peer dependencies and are never bundled — a second
copy in your tree would break `instanceof DeviceError`.

## Documentation

- **[docs/DESIGN.md](docs/DESIGN.md)** — the ten decisions the implementation
  turns on, and the injection seam that made a factory necessary.
- **[docs/FINDINGS.md](docs/FINDINGS.md)** — what was measured rather than
  assumed: the silent-reconnect defect, the per-engine capability table, the
  encoder parameters each engine keeps and drops.
- **[docs/TESTING.md](docs/TESTING.md)** — one contract suite, two harnesses,
  and the UDP relay that breaks the network under a live call.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — how to run it all locally.

## License

MIT © Voqalize. See [LICENSE](./LICENSE).
