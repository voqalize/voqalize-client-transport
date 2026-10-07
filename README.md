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

`createVoqalizeTransport` accepts every `SmallWebRTCTransport` option. The
manager has no settings of its own: the camera is released when the user turns
it off (a camera light still on afterwards is a trust problem), and the
microphone is held (re-acquiring it costs a gap in the conversation).

### Play the agent on an element the manager knows

`SmallWebRTCTransport` owns no playback element. Give the manager yours, and
keep setting its `srcObject` from `onTrackStarted` as you do today:

```ts
import { VoqalizeMediaManager, createVoqalizeTransport } from "@voqalize/client-transport";

const mediaManager = new VoqalizeMediaManager();
const transport = createVoqalizeTransport({ mediaManager, webrtcRequestParams });
const detach = mediaManager.bindOutputElement(audioEl);
detach(); // on unmount
```

A bound element gets what pipecat has no channel for, with nothing for the app
to handle:

- **Speaker routing.** It follows `updateSpeaker()`, now and on every later
  change.
- **Blocked autoplay.** A browser that has not seen a user gesture refuses to
  play, silently. The manager retries from inside the user's next tap or key
  press on the page.
- **An element that stops playing.** On Android Chrome, a page that takes over
  a live call can give the element the agent's track, resolve `play()`, and
  output nothing: packets arrive, the samples played stand still, and about a
  second in the element errors and pauses for good. The manager re-attaches
  the same track and plays it again. An element you paused is left alone.
  [The measurement](docs/FINDINGS.md#android-chrome-stops-playing-a-taken-over-call).

### Keep the call across page loads

A full page load — a reload, or a link to another page of the same site —
closes the connection. If your server holds a dropped call for a few seconds
and takes the same request again as the same call, the next page can carry on
where the last one stopped:

```ts
const transport = createVoqalizeTransport({ keepAcrossPageLoads: true, mediaManager });
const client = new PipecatClient({ transport, enableMic: true });

// On every page load:
if (transport.hasLiveCall) await client.connect(); // rejoin, no arguments
// …and from your "Start" button, as before:
// await client.startBotAndConnect(...) or client.connect(params)

// From your "End call" button:
client.disconnectBot();
await client.disconnect();
```

- The transport remembers, in `sessionStorage`, the request each `connect()`
  used: per tab, so a second tab starts its own call. A request you pass to
  `connect()` always wins.
- It forgets the call on `disconnectBot()`, and when the server refuses an
  offer (a 4xx), so a call that ended while nobody was looking makes
  `connect()` reject once and `hasLiveCall` turn false.
- It never connects by itself, and never hangs up when the page unloads. Don't
  call `client.disconnect()` on `pagehide` either: that is the page load you
  want to survive, and the server ends an abandoned call on its own.
- Rejoin on load without asking for a tap, with the microphone on: an open
  microphone is what lets the new page play the agent without one. Initialize
  devices before `connect()`; for a user who was muted, disable the mic after
  it opens rather than never opening it. Where the browser still holds the
  agent's audio back, the manager plays it when the mic opens or on the user's
  next tap or key press.
  [The measurement](docs/FINDINGS.md#a-page-load-mid-call-plays-without-a-tap-when-the-mic-is-open).
- The saved request carries the session's credentials. It never leaves the
  origin, but anything that can run script on your page can read it, as it can
  read the live client.
- A page restored from the back/forward cache brings back a client whose
  connection is gone: reload it (`pageshow` with `event.persisted`).

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

The package exports `createVoqalizeTransport`, `VoqalizeMediaManager`,
`attachTrackChangedHandler` and the `VoqalizeTransportOptions` type. The manager's members are pipecat's
`MediaManager` and `bindOutputElement()`; nothing else is public.

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
