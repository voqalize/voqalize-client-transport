# Design

## Why this exists

`SmallWebRTCTransport` is pipecat's own transport, and it does not use Daily's
infrastructure — it posts an SDP offer to your pipecat server and talks to it
directly. What it does use is `DailyMediaManager` as its default local-media
implementation, which means installing the transport installs
`@daily-co/daily-js`. That package fetches JavaScript from a `daily.co` origin
at runtime and evaluates it.

For a product whose whole claim is that the customer's code and data stay in the
customer's environment, that is not a dependency detail. It is a third-party
origin in the media path of every call, a `Content-Security-Policy` nobody can
write, and a proprietary blob doing a job the platform already does.

The rest of the transport is fine. So the smallest honest fix is to replace one
class.

## The shape of the problem

pipecat's `MediaManager` is a wide interface — devices, enable/disable, screen
share, speaker selection, buffering, VAD hooks — and `DailyMediaManager`
satisfies it by delegating to a full room engine. Nothing in the interface
requires a room engine. It requires `navigator.mediaDevices`, three tracks and
a place to keep the selection state.

One thing about the deployment makes this materially simpler than the general
case: **this is a 1:1 call, and one leg is always a server with known network
behaviour.** There is no SFU, no participant list, no simulcast negotiation
against unknown receivers, no active-speaker logic. What is left is local
capture, and getting local capture exactly right on three engines is the whole
job.

## The injection seam

`SmallWebRTCTransportConstructorOptions.mediaManager` is public and supported,
so the manager goes in through the front door. Two things about
`@pipecat-ai/small-webrtc-transport@1.10.x` complicate that, both read off the
shipped build rather than inferred:

**The abstract `MediaManager` base is not exported.** Only `WavMediaManager` and
`DailyMediaManager` are. There is no class to extend and no type to name. So
`VoqalizeMediaManager` implements the shape — declared as `MediaManagerSurface`
in [`src/pipecatTypes.ts`](../src/pipecatTypes.ts) — and
`createVoqalizeTransport()` performs exactly one cast, guarded by a `satisfies`
so that dropping a member is a compile error rather than a `TypeError` on
someone's first connect.

**The track-changed callback is a `DailyMediaManager` constructor argument, not
a base-class method.** The transport builds its `replaceTrack` closure inline
and passes it to `new DailyMediaManager(..., onTrackStarted, onTrackStopped)` —
in the `||` branch it takes _only when you did not supply a manager_. There is
no `setLocalTrackChangedHandler` on the base for an injected manager to receive
it through, and no other hook.

The consequence is quiet and bad. Inject a manager and say nothing else, and
the peer connection is wired exactly once, at `addUserMedia()` time. Every
later change — a headset unplugged mid-call, a camera switched from a settings
menu, a screen share started — produces a new track that the manager publishes
and nothing ever hands to a sender. The call stays up. The far end keeps
receiving the old track, or silence.

So `createVoqalizeTransport()` does that half itself: it subscribes to the
manager's own `setLocalTrackChangedHandler` and performs the `replaceTrack` the
stock transport would have performed for Daily. Same lane mapping, same
behaviour, no fork of pipecat. [`e2e/factory.spec.ts`](../e2e/factory.spec.ts)
pins it on all three engines, through both of `findSender`'s paths.

This is also why the package ships a factory rather than documentation telling
you to pass one option.

## The ten decisions

1. **Publish clones.** The peer connection gets `track.clone()`; the manager
   keeps the capture track and mirrors `enabled` onto the clone. A fresh clone
   per peer connection. This exists because `SmallWebRTCTransport.
closePeerConnection()` calls `sender.track.stop()`, and it closes a peer
   connection on every reconnect — publishing the capture track directly means
   the first reconnect kills the microphone.

2. **Serialize every mutation** through one promise queue. pipecat's interface
   declares `enableMic`, `updateCam` and friends as returning `void`, so the
   transport never awaits a device switch; without a queue, a user
   double-clicking a toggle interleaves two `getUserMedia` calls against one
   device. Two operations are deliberately outside it: `getDisplayMedia` must
   stay inside the caller's user-activation window (only the _install_ is
   queued, not the _prompt_), and so must `resumePlayback()`.

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

7. **No Web Audio in the capture path.** A local level meter that routes the mic
   into an `AudioContext` opens an output device and puts itself in the echo
   canceller's reference path. `userStartedSpeaking()` and `bufferBotAudio()`
   are inert; turn detection belongs on the server.

8. **The screen share is tuned for legibility, not motion.** 1080p at a low
   frame rate: `contentHint = "detail"`, `degradationPreference =
"maintain-resolution"`, `maxFramerate` 5, `maxBitrate` 1.5 Mbps. The encoder
   must never trade resolution for frame rate here — a blurry shared screen is
   a broken feature, a slow one is not. The camera carries the opposite bias
   (`"motion"`, `maintain-framerate`, 30 fps, 600 kbps), and the mic 32 kbps of
   speech. All of it lives in one `ENCODING_POLICY` table in
   [`src/mediaManager.ts`](../src/mediaManager.ts).

9. **Screen video only — no screen audio.** pipecat's `MediaManager` defines a
   `screenVideo` member and no `screenAudio`. A fourth transceiver would push
   work the interface cannot describe out of the manager and into the
   transport, and system audio in the AEC's reference path is its own problem.

10. **Camera and screen share can be live at once.** Transceivers 1 and 2 both
    exist; that is the interface's own shape. The uplink budget is split
    deliberately between them rather than left to two encoders competing.

## Two capabilities pipecat has no place for

Both are real failure modes with no callback in `RTVIEventCallbacks`, so they
live on this package's own options rather than being smuggled into a typed
callback that means something else.

**Speaker routing.** `updateSpeaker()` records a selection; something has to
call `setSinkId` on the element that plays the bot, and call it again when the
selected device disappears and the manager falls back to the default.
`bindOutputElement(el)` takes ownership of that and returns a detach function.

**Blocked autoplay.** A browser that has not seen a user gesture refuses to
play, silently and per element. The manager owns this because it owns the
elements: it detects the refusal, reports it through `onPlaybackBlocked`, and
`resumePlayback()` retries every bound element from inside a real click.

## Layout

```
src/            the published library
  index.ts        public surface
  mediaManager.ts VoqalizeMediaManager
  mediaPlatform.ts the structural media types the manager is written against
  pipecatTypes.ts  what is re-exported from pipecat, and what is mirrored
  transport.ts     createVoqalizeTransport / attachTrackChangedHandler
lab/            the harness: fake and real platforms, the probe and demo
                pages, a loopback peer connection, and a controllable UDP relay
tests/          tier 1 — the contract suite, in node
e2e/            tier 2 — the same contract suite, in three real browsers
```

`src/mediaManager.ts` names no DOM type concretely. It is written against
`MediaDevicesLike` / `TrackLike` / `StreamLike` in `src/mediaPlatform.ts`, each
a strict subset of the real type, which is what lets one implementation — the
same file, not a parallel one — run over a fake platform in node and over
`navigator.mediaDevices` in a browser. `tests/platformAssignability.test.ts` is
the compile-time proof that the subsets are real.
