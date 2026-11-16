# Design

pipecat's `MediaManager` is a wide interface — devices, enable/disable, screen
share, speaker selection, buffering, VAD hooks — and the default implementation
satisfies it by delegating to a full room engine. Nothing in the interface
requires one. It requires `navigator.mediaDevices`, three tracks, and a place to
keep the selection state.

One thing about the deployment makes this materially simpler than the general
case: **this is a 1:1 call, and one leg is always a server with known network
behaviour.** No SFU, no participant list, no simulcast negotiation against
unknown receivers, no active-speaker logic. What is left is local capture, and
getting local capture exactly right on three engines is the whole job.

## The injection seam

`SmallWebRTCTransportConstructorOptions.mediaManager` is public and supported,
so the manager goes in through the front door. Two things about
`@pipecat-ai/small-webrtc-transport@1.10.x` complicate that, both read off the
shipped build rather than inferred:

**The abstract `MediaManager` base is not exported.** There is no class to
extend and no type to name. So `VoqalizeMediaManager` implements the shape —
declared as `MediaManagerSurface` in
[`src/pipecatTypes.ts`](../src/pipecatTypes.ts) — and
`createVoqalizeTransport()` performs exactly one cast, guarded by a `satisfies`
so that dropping a member is a compile error rather than a `TypeError` on
someone's first connect.

**The track-changed callback is a constructor argument of the default manager,
not a base-class method.** The transport builds its `replaceTrack` closure
inline and passes it to the default manager's constructor — in the `||` branch
it takes _only when you did not supply a manager_. There is no
`setLocalTrackChangedHandler` on the base for an injected manager to receive it
through, and no other hook.

The consequence is quiet and bad. Inject a manager and say nothing else, and
the peer connection is wired exactly once, at `addUserMedia()` time. Every
later change — a headset unplugged mid-call, a camera switched from a settings
menu, a screen share started — produces a new track that the manager publishes
and nothing ever hands to a sender. The call stays up. The far end keeps
receiving the old track, or silence.

So `createVoqalizeTransport()` does that half itself: it subscribes to the
manager's own `setLocalTrackChangedHandler` and performs the `replaceTrack` the
stock transport performs for its own default. Same lane mapping, same
behaviour, no fork of pipecat. [`e2e/factory.spec.ts`](../e2e/factory.spec.ts)
pins it on all three engines, through both of `findSender`'s paths. This is why
the package ships a factory rather than documentation telling you to pass one
option.

## The ten decisions

1. **Publish clones.** The peer connection gets `track.clone()`; the manager
   keeps the capture track and mirrors `enabled` onto the clone. A fresh clone
   per peer connection. `SmallWebRTCTransport.closePeerConnection()` calls
   `sender.track.stop()`, and it closes a peer connection on every reconnect —
   publishing the capture track directly means the first reconnect kills the
   microphone.

2. **Serialize every mutation** through one promise queue, because pipecat's
   interface declares `enableMic`/`updateCam` as returning `void` and never
   awaits them. Two operations are deliberately outside it: `getDisplayMedia`
   must stay inside the caller's user-activation window (only the _install_ is
   queued, not the _prompt_), and so must the autoplay retry.

3. **One `getUserMedia` call when both audio and video are wanted.** WebKit
   stops an earlier track when a second `getUserMedia` targets the same device
   group.

4. **`supportsScreenShare` is constant `true`,** and three `sendonly`
   transceivers — `audio`, `video`, `screenVideo`, in that order — are created
   before the first offer. The m-line count is 3 on every engine and never
   changes, so starting or stopping a screen share mid-call needs no
   renegotiation. Lane index _is_ m-line index. Where screen capture genuinely
   is not available, `enableScreenShare` throws a typed error rather than
   changing the SDP.

5. **Debounce `devicechange`.** Chrome fires it before `enumerateDevices()`
   settles, and an undebounced handler reads a transiently missing device as
   removed and drops the microphone mid-call.

6. **`contentHint` on every published track**: `"speech"` for the mic,
   `"motion"` for the camera, `"detail"` for the screen.

7. **No Web Audio in the capture path.** The capture track and the clone the
   peer connection is given never pass through an `AudioContext`, so nothing
   the far end hears depends on one. The local level pipecat defines as
   `onLocalAudioLevel` — Daily's manager emits it, and an avatar reads it to
   show that it is listening — is measured on a separate branch: the meter
   takes its own clone of the capture track, feeds only that clone to a
   `MediaStreamAudioSourceNode` and an `AnalyserNode`, and connects the
   analyser to nothing, so no audio is rendered. Where the engine supports it
   (Chromium) the context is opened with `sinkId: { type: "none" }` and holds
   no output device at all, which was this decision's original objection to a
   level meter. The level is on Daily's scale and cadence — the peak sample of
   each 100 ms as linear amplitude, held with a quarter decay, as WebRTC's own
   `audioLevel` is — starts with the microphone, stops while it is disabled,
   and follows a device switch. Without an `AudioContext`, or while the
   autoplay policy holds one, it emits nothing. `userStartedSpeaking()` and
   `bufferBotAudio()` are inert; turn detection belongs on the server.

8. **The screen share is tuned for legibility, not motion.** 1080p at a low
   frame rate: `contentHint = "detail"`, `degradationPreference =
"maintain-resolution"`, `maxFramerate` 5, `maxBitrate` 1.5 Mbps. The camera
   carries the opposite bias (`"motion"`, `maintain-framerate`, 30 fps,
   600 kbps), and the mic 32 kbps of speech. All of it lives in one
   `ENCODING_POLICY` table in [`src/mediaManager.ts`](../src/mediaManager.ts).

9. **Screen video only — no screen audio.** pipecat's `MediaManager` defines a
   `screenVideo` member and no `screenAudio`. A fourth transceiver would push
   work the interface cannot describe out of the manager and into the transport.

10. **Camera and screen share can be live at once.** Transceivers 1 and 2 both
    exist; that is the interface's own shape. The uplink budget is split
    deliberately between them rather than left to two encoders competing.

## Capabilities pipecat has no place for

None has a callback in `RTVIEventCallbacks`, so they live on this package's
own options rather than being smuggled into a typed callback that means
something else.

**Speaker routing.** `updateSpeaker()` records a selection; something has to
call `setSinkId` on the element that plays the bot, and call it again when the
selected device disappears and the manager falls back to the default.
`bindOutputElement(el)` takes ownership of that and returns a detach function.

**Blocked autoplay.** A browser that has not seen a user gesture refuses to
play, silently and per element. The manager owns this because it owns the
elements: it detects the refusal and, while anything is refused, listens on the
document for the next `pointerdown` or `keydown` (capture phase, so an app that
stops propagation cannot swallow it) and retries every refused element inside
that event. No app code: a "tap to enable audio" affordance would be an API to
keep forever for a case the next tap answers anyway. The level meter's
`AudioContext` (decision 7) is held by the same policy, so the same listener is
armed while it is suspended and resumes it from the same gesture.

**Playout recovery.** The element can also stop playing a track it was
playing, with no refusal to catch (see
[FINDINGS](FINDINGS.md#android-chrome-stops-playing-a-taken-over-call)). Each
bound element gets a `PlayoutGuard`. The element's `error` (any code but an
abort) re-attaches every live track of its source in a new stream and plays
it, one task later because Chrome pauses the element after the event. In
Chromium it also reads the receiver's `inbound-rtp` stats: packets for the
element's track arriving while `totalSamplesReceived` stands still across two
reads is a stall. The stall is judged tightly (120 ms, 5 packets, read every
100 ms) for 2 s after the source's packets start, where the measured failure
lives, and loosely (300 ms, 10 packets, every 250 ms) after. A paused element
is skipped, and a read the app overtook (a pause, a new source) is dropped.
Re-attaches back off (500 ms, doubling) and are capped per source the app
attaches; the guard knows its own stream by identity, not by `loadstart`. An
engine whose stats lack either counter gets the error path only. The stats
come from the transport's peer connection, which `attachTrackChangedHandler`
hands the manager.

## Call health

pipecat's `mediaState` says whether a device is on. It cannot say that a
microphone is open and silent, that the operating system rather than the user
refused it, or that the network never formed a path. `CallHealth` is a
superset of it, not an extension of its union: pipecat's states stay driven by
the same errors they were driven by before. Extending it in place is not open
to a transport: `mediaState` belongs to the client, its states and reasons are
closed unions an app switches over, and it leaves `error` only when the app
calls `initDevices()` again. What `CallHealth` can do is not say a second
time what pipecat already says: where pipecat has a word for a problem
(`blocked`, `already-in-use`, `not-found`, `not-supported`, `unknown`), `CallHealth`
uses it, and the package exports only `CallHealth`, its listener and its
parts, not the leaf types inside them.

**One store, frozen snapshots.** `CallHealthStore` holds a part per device and
one for the connection. A write that changes nothing publishes nothing, and a
listener that throws does not stop the others. Every snapshot is frozen, so a
listener cannot change what the next one sees.

**Classified where the error happens.** A capture error is classified once, in
`classifyCaptureError`, from the error and what the page can read about its
environment: the permission state, the frame's permissions policy, and whether
the user agent is an in-app browser. The order is page, then operating system,
then in-app browser, then policy, then a dismissed prompt, then the user. An
earlier cause explains a later one. A frame that may not capture looks, in the
error, exactly like a user who said no. `fixesFor` maps a problem to what the
user can do, in the order to offer it.

**Silence: the page decides where it can measure.** The page measures the
microphone with the level-meter clone it already had (decision 7). The voice
runtime reports what it decoded. A microphone that gives nothing is reopened
once, because a reopen fixes a driver that stopped delivering, and then
reported as `no-signal`. A room that is merely quiet still carries noise, so it
is not silence. A muted microphone is not judged, and neither is a `virtual`
one: a noise-gated microphone (Krisp, NVIDIA Broadcast) gives exact zeros
whenever nobody speaks, so its silence would fail a person who is listening.
A dead virtual microphone goes unreported; that is the price of never telling
a quiet listener their microphone is broken.

**Interruptions come in runs.** A device the system takes back (a phone call,
another app) is reopened when the page is in front. One that keeps coming back
muted is `failed` with `interrupted` after a few reopens, and clears by itself
when its holder lets go. An interruption a minute or more after the last one
starts a new run, so a long call's occasional interruptions never add up to a
failure.

Where the page measures, its own reading wins. The runtime's `silent` stands in
only where the page cannot measure (its audio context is not yet running), and
its `none` never counts: no packets is also what a network drop looks like, and
the connection's grades already say that. Sound in the page with `silent` at
the runtime would mean the publish path is broken; that warning is held until
the runtime's silence floor is set from hardware data and agrees with the
page's. Once a microphone has failed, a click does not bring it back: it
leaves `failed` on a sustained sound, or on the runtime hearing it where the
page cannot.

**The camera is judged by the voice runtime, not the page.** The page does
not decode its own picture. The voice runtime decodes a keyframe of what reaches it and
says, under the `voqalize` label, `caller-video`: `ok`, `black` (a closed
shutter, a covered lens) or `none` (no frames). That becomes
`cam.signal.server`, with `black` read as `silent`; `cam.signal.local` is
always `unmeasured`. Black from the start is `failed` with `no-signal`, black
after a picture is `degraded`, and no frames is `degraded` only while the voice runtime
still receives the mic and the uplink grades better than `poor`: with neither,
the network dropped, and a congested uplink drops video before audio. Either
way the connection says so. No frames offers only `choose-another-device`: a
picture that never arrives is not a closed shutter. Until the voice runtime says,
the camera is `live` and unmeasured, which is all an older voice runtime ever gives.
The voice runtime judges only while the page's camera is on, and judges afresh when it
comes back on, so the page forgets the verdict when the camera goes off. A
device switch sends the voice runtime nothing; it looks again every 2 s while the picture
is black, so a new camera clears the failure without the page's help. A
virtual camera (the `virtual` trait) that is black has no shutter to open: its
fixes are `start-camera-app` and `choose-another-device`. A camera another app
holds is not black; it fails to open, `already-in-use`.

There is no camera verdict before the call. The voice runtime can judge only what reaches
it, and the owner ruled out the page looking at its own picture ("keep the
client side lightweight"), so an app that wants to catch a closed shutter on
its pre-join screen keeps its own preview check. In the call, a closed
shutter is reported a little over 2 s after the camera switches on: the voice runtime
needs two dark keyframes 1.5 s apart, so a webcam settling its exposure is
not told to open a shutter.

**The connection is read from pipecat, not rebuilt.** `trackConnectionHealth`
wraps, on the transport instance, the members pipecat already drives:

- its `state` accessor, for `connecting`, `ready` and the end of a call;
- its ICE handler, for a path forming or being lost;
- `attemptReconnection`, for a rebuild of a call that was up;
- `handleMessage`, for what the voice runtime reports.

An ICE failure before the call was ever up gives up at once: retrying the same
network will not form a path. Otherwise the 30 s unreachable timer runs from
`connecting` or `reconnecting`, and it stops when ICE connects, so a slow agent
does not count against the network, and it does not run out while the
browser's permission prompt is open. Giving up disconnects the transport so
`connect()` rejects rather than retrying for ever.

A 4xx to the offer is not the network: pipecat (1.10.7 and later) stops at
once, and its `_lastNegotiationError` still holds the response when it sets
`error`, so the call ends `refused` rather than `unreachable`.

**The runtime's reports have their own label.** The voice runtime sends every page
`caller-audio`, `caller-video` and `network-quality` under the RTVI label `voqalize` rather
than `rtvi-ai`. There is no opt-in: pipecat's client hands an app only
`rtvi-ai` messages, so an older client never sees them, and this one reads
them ahead of pipecat and drops any `voqalize` message or value it does not
know. The page sends nothing under the label; anything it ever sends would be
reviewed as a change to the voice runtime's protocol. The uplink grade is the voice runtime's
`network-quality`. The downlink grade is this page's own, from `inbound-rtp` loss,
concealment and jitter. It turns worse at once and better one step at a time.

## pipecat's transport is bundled, without daily

`@pipecat-ai/small-webrtc-transport` imports `@daily-co/daily-js` at module
scope for `DailyMediaManager`, the default it builds when no `mediaManager` is
passed. `createVoqalizeTransport()` always passes one, so that branch never
runs, but no bundler can see that: daily's SDK shipped in every app that used
this package, and keeping it out took an alias in each app's bundler config.
That is a fix every consumer has to know to make, so it belongs here.

The package therefore bundles the transport at an exact pinned version, with
daily aliased to `src/vendor/noDaily.ts` at build time, and stops declaring the
transport as a peer. `@pipecat-ai/client-js` stays a peer and stays external,
for `instanceof DeviceError`. Two build steps hold the result:

- `scripts/fix-dts.mjs` — the transport's own declarations import its
  `MediaManager` type from `@pipecat-ai/transport-lib`, which is not on npm.
  The bundled declarations name `MediaManagerSurface` in its place, the shape
  this package already implements.
- `scripts/check-dist.mjs` — fails when daily's code is in `dist/`, when
  `dist/` imports anything but `@pipecat-ai/client-js`, `events` and `lodash`,
  or when a bundled package has no licence section in `THIRD_PARTY_NOTICES.md`.

`events` and `lodash` are what the transport imports besides daily. They are
ordinary `dependencies`, not bundled, because client-js imports `events` too
and an app's bundler can only share a copy it can see: bundling them put two
of each in the site snippet.

Not forking pipecat still holds: the transport's code is unmodified. A pipecat
fix reaches apps through a release of this package that moves the pin.

## Layout

```
src/            the published library
  index.ts         public surface
  mediaManager.ts  VoqalizeMediaManager
  localAudioLevel.ts the onLocalAudioLevel meter, on a clone of the mic (decision 7)
  mediaPlatform.ts the structural media types the manager is written against
  pipecatTypes.ts  what is re-exported from pipecat, and what is mirrored
  transport.ts     createVoqalizeTransport / attachTrackChangedHandler
  vendor/noDaily.ts what the build puts in daily-js's place
scripts/        the post-build steps: fix-dts.mjs, check-dist.mjs
lab/            the harness: fake and real platforms, the probe and demo
                pages, a loopback peer connection, and a controllable UDP relay
tests/          the contract suite, in node over a fake MediaDevices
e2e/            the same contract suite, in three real browsers
```

`src/mediaManager.ts` names no DOM type concretely. It is written against
`MediaDevicesLike` / `TrackLike` / `StreamLike` in `src/mediaPlatform.ts`, each
a strict subset of the real type, which is what lets one implementation — the
same file, not a parallel one — run over a fake platform in node and over
`navigator.mediaDevices` in a browser. `tests/platformAssignability.test.ts` is
the compile-time proof that the subsets are real. The level meter follows the
same rule for Web Audio: `AudioContextLike` and `AnalyserLike` in
`src/localAudioLevel.ts`, proven in the same file.
