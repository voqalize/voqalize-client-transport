# Findings

Everything here was measured, on the versions named, by the suites in this
repository. Where a claim was overturned, the wrong version is kept next to the
right one — a finding that was believed for a week is worth as much as the
correction.

Engines are Playwright's own builds as of 2026-09-07: chromium 1243 (Chrome
141), firefox 1489, webkit 2227. Pipecat: `@pipecat-ai/client-js` 1.13.1,
`@pipecat-ai/small-webrtc-transport` 1.10.7.

## Every reconnect left the call connected and silent

Decision 1 — publish `capture.clone()`, never the capture track — is
**necessary and, on its own, not sufficient.**

`SmallWebRTCTransport`'s reconnect order is:

1. `startNewPeerConnection()` → `addUserMedia()` → `replaceTrack(existing clone)`
   onto the new senders.
2. `closePeerConnection(old)` → `sender.track.stop()` — **on that same object.**

One clone is one track object. The new peer connection is publishing it at the
moment the old one stops it. Measured on chromium through
[`e2e/network.spec.ts`](../e2e/network.spec.ts):

```
connectionState      connected
iceConnectionState   connected
mLineCount           3
capture audio        live
published audio      ended
packetsSent          0        ← forever
```

Every number a dashboard would show is green, and the call is silent.

**The fix is a poll, reluctantly.** `MediaStreamTrack.stop()` fires **no**
`ended` event on any engine. That is specified behaviour, it is what the
manager's own `intentionalStops` set relies on, and
[`e2e/harness.spec.ts`](../e2e/harness.spec.ts) pins it per engine. A clone
somebody else stopped is therefore dead with no notification anywhere, and
there is nothing to listen for. `publishWatchdogMs` (default 500 ms, `0`
disables) ticks three `readyState` reads; a lane whose published clone is
`ended` while its capture track is still `live` gets a fresh clone through the
normal queue. The watchdog runs only while something is published.

## Firefox gathers zero ICE candidates on an `[::1]` origin

Recorded for a week as "Playwright's Firefox cannot open a loopback at all":
zero ICE candidates, `iceGatheringState` stuck on `"new"`, both peers `failed`
in under a second, reproducing with a bare data channel and no media at all.
Every observation was real. The conclusion was wrong, and the cause was ours.

**Vite's default `host` is `localhost`, which it resolves to `[::1]` and binds
IPv6-only.** `vite.config.ts` pins `host: "127.0.0.1"`, and the same page in
the same browser gathers three candidates and connects.

Bisected across seven dimensions — `media.peerconnection.*` prefs, page content,
origin scheme, HTTP/2, Vite's HMR client, the port, the bind address. Only the
last mattered:

|             | http                    | https                   |
| ----------- | ----------------------- | ----------------------- |
| `127.0.0.1` | connected, 3 candidates | connected, 3 candidates |
| `::1`       | failed, 0 candidates    | failed, 0 candidates    |

TLS is not a fix and the scheme is not a factor. Chromium and WebKit connect
either way, which is what made this look like a Firefox incapability.
Unskipping Firefox exposed two real defects in the manager, both invisible on
the two engines that had been carrying the suite.

**The general lesson: a capability gate is a claim, and an unverified claim
hides bugs for as long as it stands.** It cost twice; see the headless-runner
finding below.

## The relay cannot advertise `127.0.0.1` either

The same fact from the other side. With a `127.0.0.1` candidate the call
connects on chromium and webkit and **fails instantly on Firefox** —
`iceConnectionState` straight to `failed`, zero candidate pairs, zero datagrams
at the relay. Firefox does not gather loopback host candidates, so its only
local candidate is the LAN interface, and a LAN→loopback pair is not one it
will form.

[`lab/relay/udpRelay.ts`](../lab/relay/udpRelay.ts) therefore binds `0.0.0.0`
and advertises the host's own non-internal IPv4. Nothing leaves the machine —
the kernel routes a datagram addressed to one of its own interfaces over
loopback. On a host with no such interface the network cases take a **named
skip** on Firefox rather than pass quietly.

## `"default"` is a device id on chromium and not on Firefox

On chromium and webkit, `"default"` is a genuinely enumerated output — the
follow-the-system-default pseudo-device. Firefox names its outputs with opaque
hashed ids, exposes none at all until a microphone has been granted, and so has
nothing called `default`: `setSinkId("default")` rejects with `NotFoundError`.

`applySink` falls back to the spec's own "route to the user-agent default"
value, the empty string, **and only for our own sentinel** — a device the
caller actually named still fails loudly, or `updateSpeaker` would silently
swallow a bad selection.

**`bindOutputElement` was also floating a promise.** Binding is synchronous to
the caller but routing is not, so that rejection had nobody to reject to and
surfaced as an uncaught error in the host page. It is caught at the boundary
now and reported on the device-error channel: the element still plays, on the
default device.

## Chromium reports `audioLevel: 0` on `inbound-rtp`

The demo's level meter reads `audioLevel` from the **receiving** peer's
`getStats()`, because what it shows is that the audio arrived — which the
manager's own `onLocalAudioLevel`, measured before anything is sent, cannot
show. Measured in real
Chrome, one receiver, one instant, 200 packets received:

```
inbound-rtp.audioLevel                       0
getSynchronizationSources()[0].audioLevel    0.12589254117941673
```

WebKit populates `inbound-rtp.audioLevel` properly (0.1006 measured). Chromium
does not, so the loopback treats a **zero** as missing, not as silence, and
falls back to the synchronization source.

## Daily's local audio level is WebRTC's `audioLevel`, computed off-package

Measured 2026-10-15 against `@daily-co/daily-js` 0.90.0, the version
`@pipecat-ai/small-webrtc-transport` 1.10.7 depends on. Nothing below runs in
this repository; it is how the level `VoqalizeMediaManager` now emits was
matched.

- **Where it comes from.** `DailyMediaManager.initialize()` calls
  `startLocalAudioLevelObserver(100)` right after starting the camera and
  microphone — before any call — and forwards each `local-audio-level` event's
  `audioLevel` to `onLocalAudioLevel`. The computation is not in the npm
  package. It is in the call-machine bundle daily-js loads at runtime from
  `c.daily.co/call-machine/versioned/0.90.0/`, which is the remotely-loaded
  code this package exists to remove.
- **How it is computed.** A fresh `AudioContext` per start;
  `createMediaStreamSource(new MediaStream([track]))` on the **capture track
  itself**, into an `AudioWorkletNode`, **connected to
  `audioContext.destination`**. The worklet is a port of WebRTC's
  `audio_level.cc`, the source of `RTCAudioSourceStats.audioLevel`: over each
  window of at least 100 ms it keeps the largest absolute sample across
  channels, reports the held peak as linear full-scale amplitude (0 to 1), then
  divides the held peak by four. A main-thread `setInterval` at the requested
  100 ms emits the latest value. Some of it is artefact rather than design:
  the window length assumes 44.1 kHz whatever the real rate, and the reported
  value is the previous window's, one window late.
- **What type it is.** The worklet posts `audioLevel.toFixed(6)` and nothing
  parses it, so `onLocalAudioLevel` receives a **string** such as
  `"0.123456"`, despite pipecat typing it `number`. Before the first worklet
  message it emits `undefined`.
- **Muted.** Daily mutes by setting `enabled = false` on the capture track, and
  the observer stops whenever its track is missing or disabled: no events, and
  no final zero. Unmuting or switching device restarts it on the current track.
  `leave()` stops it.
- **Requirements.** `startLocalAudioLevelObserver` throws where
  `AudioWorkletNode` is missing, and refuses an interval under 100 ms.

`VoqalizeMediaManager` matches the scale, the decay, the cadence, the start
before any call, and the silence while muted. It differs where Daily's
behaviour is an accident or a cost: the level is a `number`, it is not a
window late, it is never `undefined`, it needs no `AudioWorklet`, and it
measures a **clone** of the capture track through an `AnalyserNode` connected
to nothing, so the context renders no audio. The analyser's window is the
smallest power of two covering 100 ms at the context's rate, read every
100 ms, so consecutive reads overlap rather than leave gaps.

Measured through `RTVIEvent.LocalAudioLevel` on a real `PipecatClient`
(`e2e/factory.spec.ts`), Playwright 1.63.0's engines, each with its fake
microphone, over 2 s:

```
chromium  beeps: 0 between them, 1 on each beep, then 0.25, 0.0625, 0.0156
webkit    a 0.597 beep over a steady 0.1 floor, decaying 0.597 → 0.149 → 0.1
firefox   a steady 0.1 tone
```

WebKit's mock microphone can also stay **silent for seconds** after it opens
when several engines run at once. It is the device, not the meter: an
`AnalyserNode` on the capture track itself, in a context of its own, read zero
at the same moments the meter did. The end-to-end test waits for the sound
instead of timing a fixed window.

## A level meter's `AudioContext` on iOS

Not measured on a device; this is the risk as the specifications and WebKit's
reports describe it, and why the meter is built the way it is.

The [Audio Session](https://www.w3.org/TR/audio-session/) specification, which
WebKit implements, resolves the page's audio session type from what is active:
a live microphone track contributes `play-and-record`, which outranks
everything; an `AudioContext` contributes only `ambient`, the lowest, and only
while it is running and audible. A page with a live microphone is already in
`play-and-record` — with the earpiece routing and the ducking of other apps'
audio that iOS applies to it, all of which getUserMedia causes before any meter
exists — and an `AudioContext` cannot change that type.

So the meter only exists while the microphone is live and enabled, and closes
its context when the microphone is disabled or released: there is never a
moment when the context is the most significant audio on the page. Its
analyser is connected to nothing, so the context is never audible. What remains
possible, and is unverified, is WebKit adjusting the shared hardware session
for the context's sake — a different preferred buffer size or sample rate, or
an `"interrupted"` state after a phone call or route change. The meter asks for
`latencyHint: "playback"` (the largest buffer, so it never asks for a smaller
one than capture already has), treats any state other than `"running"` as
"emit nothing", and resumes on the next gesture. A real iPhone and an iPad,
with Bluetooth and wired headsets, are owed before this is called safe.

## Android Chrome stops playing a taken-over call

Chrome 154 on Android 10, a page loaded mid-call that takes the call over
from the page before it. The agent's remote track is attached to an
`<audio>` element and `play()` resolves. Then, in every occurrence measured:

- the element's `currentTime` advances, so it reports itself playing;
- `inbound-rtp.packetsReceived` keeps rising (the agent is speaking);
- `inbound-rtp.totalSamplesReceived`, which only moves as the output pulls
  audio, stays at about 20 ms of audio;
- about a second in, the element raises `error` with code 3
  (`MEDIA_ERR_DECODE`, no message) and pauses, and stays paused.

It happened with pipecat's default (daily) media manager and with this one,
so it is the element and not the capture side. A cold start on the same phone
does not do it. Re-attaching the same track (a new `MediaStream` on
`srcObject`, then `play()`) brings the audio back at once; a watchdog that did
this after 300 ms of stall closed the gap on the phone, and at 120 ms and 5
packets "the voice comes in noticeably sooner" (2026-10-07). That is the
`PlayoutGuard`.

What the guard can rely on, measured in Chromium, Firefox and WebKit
(2026-10-07):

- Only Chromium ties `totalSamplesReceived` to playout. Firefox and WebKit
  advance it with no sink at all, so the stall signal never fires there and
  the element's `error` is the only one. The stall path is a Chromium
  optimisation; the error path is the guard.
- `trackIdentifier` on `inbound-rtp` equals the receiver's `track.id` in every
  engine.
- `loadstart` is queued as a task in every engine, `srcObject = null` fires
  none, and two assignments in one task fire one. So the guard tells its own
  re-attach from the app's by the stream's identity, never by the event.
- Stock pipecat servers send packets through silence; a server that stops
  sending between talkspurts sends none. Silence is therefore not a stall
  either way: with packets the element plays them, without them there is
  nothing to stall on.
- `getStats()` costs a median of about 0.4 ms.

## A page load mid-call plays without a tap when the mic is open

What `keepAcrossPageLoads` leans on: the page after a reload or a link
rejoins the call with no tap, and the agent's audio has to play. Measured
2026-10-07 on the desktop engines, fresh profiles, a fake microphone with
permission granted, a live call on the dev harness, nothing touching the new
page until a single read 8 s after it loaded (a probe through Playwright's
`page.evaluate` counts as a gesture in Chromium and would void the run).

| Engine  | How the page changed | Mic opened              | Agent's audio                                                    |
| ------- | -------------------- | ----------------------- | ---------------------------------------------------------------- |
| Chrome  | link click           | first                   | plays (user activation carries over)                             |
| Chrome  | reload               | first                   | plays, no user activation                                        |
| Chrome  | reload               | after the agent's track | refused; a later `play()`, mic open, still refused               |
| Firefox | reload or link       | first or after          | plays                                                            |
| WebKit  | reload or link       | first                   | plays                                                            |
| WebKit  | reload               | after the agent's track | refused, then plays on a gesture-free retry once the mic is open |

So: rejoin with the microphone on, and open it before the agent's audio is
attached; a user who was muted should still capture and then disable. Chrome
decides once, when the element first plays. WebKit reconsiders, so the
manager retries a refused element when the microphone opens. Anything still
refused is retried on the next tap or key press.

Not measured here: Android Chrome and iOS Safari.

## WebKit grants exactly one gesture-free `getDisplayMedia` per page

Measured in Playwright's WebKit on macOS, two calls in one `page.evaluate`:

```
1: ok tracks=1
2: InvalidStateError: getDisplayMedia must be called from a user gesture handler.
```

chromium and firefox resolve both. Any probe that _calls_ `getDisplayMedia`
from inside the page under test spends the one call the case needs, and every
WebKit screen-share case then skips itself. The capability is therefore
measured once per worker in a throwaway context —
[`e2e/screenShareSupport.ts`](../e2e/screenShareSupport.ts).

Two mechanical details that come with that shape. A hand-made
`browser.newContext()` does **not** inherit the project's `use` block, and
WebKit's mock capture devices only exist once the context has been granted
microphone and camera — so `permissions` has to be carried across explicitly.
And the measurement must be memoized _in flight_, not just on completion: under
`fullyParallel` the first few tests reach it simultaneously and each opens its
own throwaway context, which was enough to make Vite start answering
`NS_ERROR_NET_EMPTY_RESPONSE` on firefox.

## Firefox on a Linux runner has no audio server, so no `AudioContext` runs

The first CI run of the level meter failed on Firefox alone: the factory test
waited 15 s and received no levels at all — not zeros, nothing, which is the
meter's "context not running" path. It passed in Firefox on macOS.

Reproduced in the Playwright image (`mcr.microsoft.com/playwright:v1.63.0-noble`),
which, like GitHub's ubuntu runner, runs no sound server. Every `AudioContext`
Firefox builds there stays `"suspended"` and its `resume()` never settles, with
or without `sinkId: { type: "none" }` (Firefox has no `sinkId` member and drops
it), after a real click, and with `media.autoplay.default: 0`. Neither
`media.cubeb.force_null_context` nor `media.cubeb.force_mock_context` changes
that. Starting PulseAudio — whose only sink there is `auto_null` — is enough:
the context reaches `"running"` within the resume, and the test passes.

So the meter is right and the runner was missing a sound server: the Firefox
job starts PulseAudio. A real Linux desktop runs one. A Linux Firefox without
one reports no level, as the meter does anywhere its context cannot run, and so
would Daily's, whose level comes from an `AudioWorklet` in an `AudioContext`
too.

## A headless Linux runner has no display, and the gate said otherwise

`screenShare` was gated on `typeof navigator.mediaDevices.getDisplayMedia ===
"function"`. On macOS all three engines resolve, so that read `true` for the
right reason by accident. On GitHub's ubuntu runner there is nothing to
capture:

| engine   | headless ubuntu                                                      |
| -------- | -------------------------------------------------------------------- |
| chromium | resolves — `--use-fake-ui-for-media-stream` picks a fake source      |
| firefox  | **`NotFoundError: The object can not be found here.`**               |
| webkit   | **`NotAllowedError: The request is not allowed by the user agent…`** |

Eleven cases that declare `requires: ["screenShare"]` therefore _failed_ on the
first CI run rather than taking the named skip they were written to take. The
cases were right and the gate was wrong. Nothing was weakened: the gate now
measures.

## Per-engine capability table

Measured by the suite itself; every browser test carries the raw object as an
annotation.

| Capability                        | chromium   | firefox                                     | webkit  |
| --------------------------------- | ---------- | ------------------------------------------- | ------- |
| `contentHint`                     | yes        | **no**                                      | yes     |
| `setSinkId` exists                | yes        | yes                                         | yes     |
| `setSinkId("default")` accepted   | yes        | **no — `NotFoundError`**                    | yes     |
| multiple mics                     | yes (3)    | **no (1)**                                  | yes (4) |
| multiple cams                     | **no (1)** | **no (1)**                                  | yes (2) |
| `audiooutput` enumerated          | yes        | only _after_ a mic grant, opaque hashed ids | yes     |
| `getDisplayMedia`, headless macOS | yes        | yes                                         | yes     |
| loopback peer connection          | yes        | yes                                         | yes     |
| device vanishes mid-acquire       | no         | no                                          | no      |

Capture identities, for anyone debugging a device-id assertion:

|                                 | chromium                   | firefox                              | webkit                   |
| ------------------------------- | -------------------------- | ------------------------------------ | ------------------------ |
| mic label                       | `Fake Default Audio Input` | `Default Audio Device`               | `Mock audio device 1`    |
| camera label                    | `fake_device_0`            | `Default Video Device`               | `Mock video device 1..2` |
| screen label                    | `screen:-3:0`              | `Primary Monitor` (the real display) | `Mock screen device 1`   |
| screen `getSettings().deviceId` | `screen:-3:0`              | **`""` (absent)**                    | a stable GUID            |

**Nothing may key a screen track by device id.** There is no device behind it,
and Firefox says so.

## Test-environment facts that are not obvious

- **WebKit's fake capture devices need no flags.** `use.permissions:
["microphone", "camera"]` is the whole configuration; the permission grant is
  what turns the mock devices on.
- **Firefox rejects `context.permissions: ["microphone", "camera"]` outright**
  (`Unknown permission: microphone`). `media.navigator.permission.disabled:
true` in `firefoxUserPrefs` is what suppresses the prompt.
- **Chromium's `getDisplayMedia` auto-accept is a side effect of
  `--use-fake-ui-for-media-stream`** — no separate
  `--auto-select-desktop-capture-source` needed.
- **Firefox's `getDisplayMedia` captures the real primary display**, not a
  synthetic one, and the lane runs at 5 fps — which is why the mid-call
  screen-share case is the suite's one known flake under three-engine
  contention. CI retries once.
- **Only webkit fakes more than one camera.** Chromium's
  `--use-file-for-fake-video-capture` changes the _content_ of the single fake
  camera, not the _count_.

## Media actually crossed the wire

Not "the API resolved" — frames encoded, sent, received and decoded, on all
three lanes, on all three engines, ~2 s after connect. Camera and screen live
in the same call:

| engine   | codec | camera            | screen             |
| -------- | ----- | ----------------- | ------------------ |
| chromium | VP8   | 640×360 @21 fps   | 1920×1080 @5 fps   |
| webkit   | H264  | 640×360 @14 fps   | 1920×1080 @5 fps   |
| firefox  | VP8   | 320×180 @30.5 fps | 1671×1080 @6.4 fps |

Decision 8 is visible in those numbers: the screen holds its resolution and
gives up frames; the camera holds its frame rate and gives up size.
`qualityLimitationReason` was `none` on both lanes, so neither was struggling —
this is the policy working, not an artefact of contention. Each engine picks
its own capture size from the same range constraints, which is why the suite
asserts on `framesEncoded > 0` and on resolution _ratios_ rather than exact
pixels.

**Real Chrome, real hardware** (MacBook Pro camera and built-in microphone,
through `lab/demo.html`): video lane VP8 at 640×360, 30 fps, audio at
28–30 kbps, `replaceTrack` on lane 1 with **0 renegotiations**.

## `setParameters`: nothing was dropped, anywhere

Read back through a fresh `getParameters()` after connect. Audio 32 kbps, video
600 kbps @30 fps, screen 1.5 Mbps @5 fps, and `degradationPreference` per lane
— every field came back exactly as set, on every engine, with one encoding per
sender and no rejection anywhere. Two mechanical notes that cost time:

- `maxFramerate` is never set for audio (the policy records `0` to keep one
  shape per lane) and reads back `null` there. That is correct, not a drop.
- `degradationPreference` is set at the **top level** of
  `RTCRtpSendParameters`, not per-encoding. It moved there in the spec, and all
  three engines read it there.

## Behavioural facts the manager is built around

- **A screen track ending because the user pressed the browser's own "Stop
  sharing" is indistinguishable, at the event level, from a device
  disappearing** — both are a bare `ended`. Only the slot separates them. A
  `getUserMedia` slot re-acquires; the display slot must not, or the user gets
  a picker they never asked for.
- **WebKit stops an earlier track when a second `getUserMedia` targets the same
  device group.** Two calls is a bug even where it appears to work.
- **A held-but-disabled camera leaves the hardware indicator lit.** A user who
  turned the camera off and still sees the light is right to conclude we are
  lying, so the camera is released on disable and the microphone is not.
- **Two overlapping `enableScreenShare(true)` calls must share the whole
  operation**, not just the prompt. Memoizing only the `getDisplayMedia`
  promise let both callers queue their own install, both pass an `isLive` guard
  taken before anything was installed, and the second install's "already
  sharing" branch stop the stream the first had just published — a share that
  reports itself on while sending a dead track.
- **`manager.destroy()` can fire a track-changed event at a closed peer
  connection.** Releasing every track during teardown reaches `replaceTrack` on
  a `closed` pc, whose rejection propagates back into the manager's own
  mutation queue and fails an operation that otherwise succeeded.
  `attachTrackChangedHandler` now checks `connectionState` and never rethrows.
