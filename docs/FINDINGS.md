# Findings

Everything here was measured, on the versions named, by the suites in this
repository. Where a claim was overturned, the wrong version is kept next to the
right one — a finding that was believed for a week is worth as much as the
correction.

Engines are Playwright's own builds as of 2026-09-07: chromium 1243 (Chrome
141), firefox 1489, webkit 2227. Pipecat: `@pipecat-ai/client-js` 1.13.1,
`@pipecat-ai/small-webrtc-transport` 1.10.7.

## The defect that justifies the package: every reconnect left the call connected and silent

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

Every number a dashboard would show is green, and the call is silent. Decision
1 saved the microphone; it did not save the call.

**The fix is a poll, reluctantly.** `MediaStreamTrack.stop()` fires **no**
`ended` event on any engine. That is specified behaviour, it is what the
manager's own `intentionalStops` set relies on, and
[`e2e/harness.spec.ts`](../e2e/harness.spec.ts) pins it per engine. A clone
somebody else stopped is therefore dead with no notification anywhere, and
there is nothing to listen for. `publishWatchdogMs` (default 500 ms, `0`
disables) ticks three `readyState` reads; a lane whose published clone is
`ended` while its capture track is still `live` gets a fresh clone through the
normal queue, and the transport is handed it on the existing track-changed
hook. The watchdog runs only while something is published.

## Firefox gathers zero ICE candidates on an `[::1]` origin

Recorded for a week as "Playwright's Firefox cannot open a loopback at all":
zero ICE candidates, `iceGatheringState` stuck on `"new"`, both peers `failed`
in under a second, reproducing with a bare data channel and no media at all.
Every observation was real. The conclusion was wrong, and the cause was ours.

**Vite's default `host` is `localhost`, which it resolves to `[::1]` and binds
IPv6-only.** `vite.config.ts` pins `host: "127.0.0.1"`, and the same page in
the same browser gathers three candidates and connects.

Bisected across seven dimensions, each of which was the leading theory at some
point:

| Hypothesis                                   | Verdict                                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a `media.peerconnection.*` pref              | no — `ice.loopback`, `ice.obfuscate_host_addresses`, `ice.link_local`, `ice.no_host`, `ice.default_address_only`, `network.proxy.allow_hijacking_localhost`, every combination, still zero |
| page content (media vs. a bare data channel) | no — reproduces with neither                                                                                                                                                               |
| the origin scheme                            | no — see the 2×2                                                                                                                                                                           |
| HTTP/2                                       | no                                                                                                                                                                                         |
| Vite's injected HMR client                   | no                                                                                                                                                                                         |
| the port                                     | no                                                                                                                                                                                         |
| **the bind address**                         | **yes**                                                                                                                                                                                    |

The 2×2 of bind address × scheme is worth keeping, because "just use HTTPS" was
the first answer and it cost real time:

|             | http                    | https                   |
| ----------- | ----------------------- | ----------------------- |
| `127.0.0.1` | connected, 3 candidates | connected, 3 candidates |
| `::1`       | failed, 0 candidates    | failed, 0 candidates    |

TLS is not a fix and the scheme is not a factor. Chromium and WebKit connect
either way, which is exactly what made this look like a Firefox incapability.

Unskipping Firefox paid for itself immediately: it exposed two real defects in
the manager, both invisible on the two engines that had been carrying the
suite. See "`default` is a device id on chromium and not on Firefox" below.

The general lesson: **a capability gate is a claim, and an unverified claim
hides bugs for as long as it stands.**

## The relay cannot advertise `127.0.0.1` either

The same fact from the other side. With a `127.0.0.1` candidate the call
connects on chromium and webkit and **fails instantly on Firefox** —
`iceConnectionState` straight to `failed`, zero candidate pairs formed, zero
datagrams at the relay. Firefox does not gather loopback host candidates, so
its only local candidate is the LAN interface, and a LAN→loopback pair is not
one it will form. `media.peerconnection.ice.loopback` changes nothing; neither
does `obfuscate_host_addresses`.

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

The same root fact broke a test that was too literal: it asserted the manager
announces `onSpeakerUpdated:default` after a speaker vanishes. Firefox
announced its own default's opaque id and the case failed on an engine that was
behaving correctly. What every engine agrees on is weaker and truer: _a_
speaker was re-announced, and it is not the one that vanished.

**`bindOutputElement` was also floating a promise.** Binding is synchronous to
the caller but routing is not, so that rejection had nobody to reject to and
surfaced as an uncaught error in the host page — a _binding_ call crashing the
app over speaker routing. It is caught at the boundary now and reported on the
device-error channel: the element still plays, on the default device.
`e2e/demo.spec.ts`'s `expect(errors).toHaveLength(0)` on `pageerror` is what
caught it.

## Chromium reports `audioLevel: 0` on `inbound-rtp`

Decision 7 keeps Web Audio out of the capture path, so the demo's level meter
reads `audioLevel` from the **receiving** peer's `getStats()`. Measured in real
Chrome, one receiver, one instant, 200 packets received:

```
inbound-rtp.audioLevel                       0
getSynchronizationSources()[0].audioLevel    0.12589254117941673
```

WebKit populates `inbound-rtp.audioLevel` properly (0.1006 measured). Chromium
does not, so a meter that trusted it would sit dead in the browser most people
open. The loopback treats a **zero** as missing, not as silence, and falls back
to the synchronization source — still the receiving side, still not Web Audio.

## Per-engine capability table

Measured by the suite itself; every tier-2 test carries the raw object as an
annotation.

| Capability                              | chromium   | firefox                                     | webkit  |
| --------------------------------------- | ---------- | ------------------------------------------- | ------- |
| `contentHint`                           | yes        | **no**                                      | yes     |
| `setSinkId` exists                      | yes        | yes                                         | yes     |
| `setSinkId("default")` accepted         | yes        | **no — `NotFoundError`**                    | yes     |
| multiple mics                           | yes (3)    | **no (1)**                                  | yes (4) |
| multiple cams                           | **no (1)** | **no (1)**                                  | yes (2) |
| `audiooutput` enumerated                | yes        | only _after_ a mic grant, opaque hashed ids | yes     |
| `getDisplayMedia`, headless, no gesture | yes        | yes                                         | yes     |
| loopback peer connection                | yes        | yes                                         | yes     |
| device vanishes mid-acquire             | no         | no                                          | no      |

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
  what turns the mock devices on. There is no WebKit equivalent of
  `--use-fake-device-for-media-stream` to hunt for, because none is needed.
- **Firefox rejects `context.permissions: ["microphone", "camera"]` outright**
  (`Unknown permission: microphone` at `browser.newContext`).
  `media.navigator.permission.disabled: true` in `firefoxUserPrefs` is what
  suppresses the prompt; the `permissions` option is omitted for that project.
- **Chromium's `getDisplayMedia` auto-accept is a side effect of
  `--use-fake-ui-for-media-stream`** — no separate
  `--auto-select-desktop-capture-source` needed.
- **Firefox's `getDisplayMedia` captures the real primary display**, not a
  synthetic one. Fine for structural assertions; not fine for any future test
  that reads frame content.
- **Only webkit fakes more than one camera.** Chromium's
  `--use-file-for-fake-video-capture` changes the _content_ of the single fake
  camera, not the _count_. Closing this needs a virtual camera on the host.
- **Device labels are measured post-grant.** This suite always calls
  `getUserMedia` before `enumerateDevices` in the labels test, so "labels
  populated: yes" is not a claim about the pre-grant state.

## Media actually crossed the wire

Not "the API resolved" — frames encoded, sent, received and decoded, on all
three lanes, on all three engines, ~2 s after connect.

**chromium** (VP8 video, Opus audio):

| lane (m-line)   | framesEncoded         | fps   | resolution | bytesSent                       |
| --------------- | --------------------- | ----- | ---------- | ------------------------------- |
| audio (0)       | n/a                   | —     | —          | 4 062 (87 packets, 87 received) |
| video (1)       | 34                    | 20–21 | 640×360    | 42 125                          |
| screenVideo (2) | 3 in the first second | 4–5   | 1920×1080  | 13 158                          |

**webkit** (H264 video, Opus audio):

| lane (m-line)   | framesEncoded | fps   | resolution | bytesSent                       |
| --------------- | ------------- | ----- | ---------- | ------------------------------- |
| audio (0)       | n/a           | —     | —          | 7 098 (88 packets, 88 received) |
| video (1)       | 50            | 30–31 | 640×360    | 72 813                          |
| screenVideo (2) | 3             | 5     | 1920×1080  | 16 543                          |

**firefox** (VP8 video, Opus audio) — numbers that did not exist until the ICE
finding above was corrected:

| lane (m-line)   | framesEncoded | fps | resolution | bytesSent        |
| --------------- | ------------- | --- | ---------- | ---------------- |
| audio (0)       | n/a           | —   | —          | packets received |
| video (1)       | 52            | 30  | 480×270    | 43 128           |
| screenVideo (2) | yes           | ~6  | 1671×1080  | —                |

Each engine picks its own capture size from the same range constraints, which
is why the suite asserts on `framesEncoded > 0` and on resolution _ratios_
rather than on exact pixels.

**Real Chrome, real hardware** (MacBook Pro camera and built-in microphone,
through `lab/demo.html`): video lane VP8 at 640×360, 30 fps, audio at
28–30 kbps, `replaceTrack` on lane 1 with **0 renegotiations**.

## Decision 8 is visible in the numbers

Camera and screen live in the same call:

| engine   | camera                 | screen             |
| -------- | ---------------------- | ------------------ |
| chromium | 640×360 @21 fps, VP8   | 1920×1080 @5 fps   |
| webkit   | 640×360 @14 fps, H264  | 1920×1080 @5 fps   |
| firefox  | 320×180 @30.5 fps, VP8 | 1671×1080 @6.4 fps |

The screen holds its resolution and gives up frames; the camera holds its frame
rate and gives up size. `qualityLimitationReason` was `none` on both lanes, so
neither was struggling — this is the policy working, not an artefact of
contention.

## `setParameters`: nothing was dropped, anywhere

Read back through a fresh `getParameters()` after connect.

| field                       | asked     | chromium       | webkit         | firefox        |
| --------------------------- | --------- | -------------- | -------------- | -------------- |
| audio `maxBitrate`          | 32 000    | 32 000         | 32 000         | 32 000         |
| video `maxBitrate`          | 600 000   | 600 000        | 600 000        | 600 000        |
| screen `maxBitrate`         | 1 500 000 | 1 500 000      | 1 500 000      | 1 500 000      |
| video `maxFramerate`        | 30        | 30             | 30             | 30             |
| screen `maxFramerate`       | 5         | 5              | 5              | 5              |
| `degradationPreference`     | per lane  | echoed exactly | echoed exactly | echoed exactly |
| `setParameters()` rejection | —         | none           | none           | none           |

Every field came back as set, on every engine, with exactly one encoding per
sender. Two mechanical notes that cost time:

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
  mutation queue and fails an operation that otherwise succeeded. Found by
  [`e2e/factory.spec.ts`](../e2e/factory.spec.ts) on the first run of that
  spec; `attachTrackChangedHandler` now checks `connectionState` and never
  rethrows.
