# Testing

Three tiers. The load-bearing idea is that tiers 1 and 2 run **the same test
bodies** — every behavioural assertion is written once, in
[`tests/contract/cases.ts`](../tests/contract/cases.ts), and two thin drivers
run it against two different platforms.

| Tier | Runner                                        | Platform under the manager                              | Cost   |
| ---- | --------------------------------------------- | ------------------------------------------------------- | ------ |
| 1    | vitest, node                                  | `lab/fakeMediaDevices.ts` — a scriptable `MediaDevices` | ~1 s   |
| 2    | Playwright, chromium + firefox + webkit       | real `navigator.mediaDevices`                           | ~1 min |
| 3    | a person, [`lab/demo.html`](../lab/demo.html) | real hardware                                           | manual |

**A tier-1 pass that fails tier 2 is a bug in our model of the browser.** Fix
the manager or fix the fake — never weaken the case.

## Running it

```bash
pnpm install
pnpm exec playwright install chromium firefox webkit   # first time only

pnpm typecheck      # tsc --noEmit over src/, lab/, tests/, e2e/ and the configs
pnpm lint
pnpm build          # tsup: ESM + CJS + .d.ts
pnpm test:unit      # tier 1
pnpm test:e2e       # tier 2, all three engines
pnpm test           # both
```

`test:e2e` starts its own Vite dev server (the `webServer` block in
`playwright.config.ts`), so no separate `pnpm dev` is needed. Scope to one
engine with `pnpm exec playwright test --project=webkit`, watch it with
`--headed`, read the last run with `pnpm report`.

`pnpm dev` serves the lab pages for tier 3 at **<http://127.0.0.1:5183/>** —
`demo.html` (the thing a person judges), `probe.html` and `factory.html`.

> The dev server binds **`127.0.0.1`, never `localhost`**. Vite resolves
> `localhost` to `[::1]` and binds IPv6-only, and Firefox gathers zero ICE
> candidates on an IPv6-loopback origin. It is one line in `vite.config.ts` and
> it cost a day — [FINDINGS.md](FINDINGS.md#firefox-gathers-zero-ice-candidates-on-an-1-origin).

## Current measured results

```
pnpm typecheck    clean
pnpm lint         clean
pnpm build        clean — ESM + CJS + .d.ts, 0 occurrences of "daily", 0 of "eval("
pnpm test:unit     70 passed,  9 skipped
pnpm test:e2e     255 passed, 12 skipped   (chromium, firefox, webkit)
```

70 contract cases, run in both tiers. Tier 1 also runs 8 fake-platform
self-tests and 1 compile-time platform-assignability test. Tier 2 adds the
engine-capability probes, the network suite, the demo page and the factory
suite.

## Skips are named, never silent

A case declares what it needs and the runner honours it, so an engine that
_cannot_ support an assertion is reported as a named skip:

- `tiers: ["unit"]` — only meaningful against the fake. A device that vanishes
  _during_ an in-flight `getUserMedia` is the canonical example; no real
  browser can do that.
- `tiers: ["browser"]` — needs a real `RTCPeerConnection`. Node has none, so
  the nine peer-connection cases skip in tier 1 by name.
- `requires: ["multipleMics", …]` — needs an engine capability. A missing one
  prints as `firefox lacks: multipleMics`.

### One known flake

`a screen share started mid-call encodes without disturbing the other lanes`
has failed once on **firefox** in a full three-engine run and passed on every
isolated re-run (3/3 repeats, and a full firefox project run, immediately
after). Firefox's `getDisplayMedia` captures the host's **real** primary
display rather than a synthetic source, and the screen lane runs at 5 fps by
policy — under three engines' worth of contention the first encoded frame can
miss the case's 20 s window. `retries: 1` is set on CI for this reason. If it
starts failing on retry too, it is no longer a flake: read the trace before
widening the timeout.

The 12 tier-2 skips are all engine facts: Firefox fakes one microphone, one
camera and implements no `contentHint`; chromium fakes one camera; three cases
are tier-1-only by construction. Full capability table in
[FINDINGS.md](FINDINGS.md#per-engine-capability-table).

## The suites

| File                                                                            | Tier | What it holds                                                                                                       |
| ------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------- |
| [`tests/contract.test.ts`](../tests/contract.test.ts)                           | 1    | driver: the contract over the fake platform                                                                         |
| [`tests/fakeMediaDevices.test.ts`](../tests/fakeMediaDevices.test.ts)           | 1    | the fake platform's own self-tests                                                                                  |
| [`tests/platformAssignability.test.ts`](../tests/platformAssignability.test.ts) | 1    | compile-time proof that `MediaDevicesLike` is a real subset of the DOM types, so one manager runs on both platforms |
| [`e2e/contract.spec.ts`](../e2e/contract.spec.ts)                               | 2    | driver: the **same** contract over real engines                                                                     |
| [`e2e/harness.spec.ts`](../e2e/harness.spec.ts)                                 | 2    | engine-capability probes — what each browser can actually do                                                        |
| [`e2e/network.spec.ts`](../e2e/network.spec.ts)                                 | 2    | the call over a breakable UDP path                                                                                  |
| [`e2e/demo.spec.ts`](../e2e/demo.spec.ts)                                       | 2    | loads the demo page in all three engines and requires a real non-zero frame count on screen, with zero `pageerror`s |
| [`e2e/factory.spec.ts`](../e2e/factory.spec.ts)                                 | 2    | `createVoqalizeTransport()` itself, against a real `PipecatClient`                                                  |

## Why the page boundary is shaped the way it is

Tier 2 runs the contract bodies in node and the manager in the page, so
everything crossing that boundary is structured-cloneable — no
`MediaStreamTrack`, no `MediaDeviceInfo`, no callbacks. Tracks are not
cloneable across `page.evaluate`, so [`lab/labApi.ts`](../lab/labApi.ts) is
id-keyed and data-only. That constraint is what makes one body run in two
tiers.

Errors travel as data too. An exception thrown inside `page.evaluate` arrives
in node with its `name` flattened into the message — losing exactly the field
the error-mapping cases assert on — so the driver rethrows a `LabError` built
from an envelope.

`LabApi.burst()` exists for the same reason. Decision 2 (one mutation queue)
can only be observed by _overlapping_ calls, and tier 2 is one `page.evaluate`
round trip per call; issuing them from node would serialize them at the
boundary and prove nothing. The burst runs inside the page, so the overlap is
real in both tiers.

## The loopback and the relay

Two `RTCPeerConnection`s in one page, wired to each other
([`lab/loopback.ts`](../lab/loopback.ts)), are enough to prove media: three
`sendonly` transceivers created before the first offer, real encode → RTP →
decode, and `getStats()` read back for frames, bitrate and applied encoder
parameters.

A same-page loopback **cannot** produce two of the failures that matter: a
network path that moves, and ICE wedging. Both peers are on this host, they
find each other directly, and the only way to end that call is to close it. So
the media path gets an addressable middle:

```
page                 Vite dev server                page
client PC  ──UDP──►  socketFromA ──► socketFromB  ──UDP──►  server PC
           ◄──────   (cross-forwarding, controllable)  ◄──────
```

[`lab/relay/udpRelay.ts`](../lab/relay/udpRelay.ts) is two `dgram` sockets
inside the dev server, cross-forwarding, with HTTP control at `/__relay`:

| Verb        | Models                                                                |
| ----------- | --------------------------------------------------------------------- |
| `blackhole` | the path stays and the packets stop — ICE wedges                      |
| `rebind`    | the ports close and different ones open — the path moved (Wi-Fi, VPN) |
| `loss`      | degradation without a break                                           |
| `resume`    | clear both                                                            |

Per-direction counters prove the packets really crossed the middle. The cross —
a datagram from A leaving the _B_ socket — is the whole trick: sending it back
out of the socket it arrived on would put the wrong port in the source field
and every ICE check would be discarded.

There is no page-side version of this. WebRTC's transport is below JavaScript;
the only way to get between two peers is to be a real address on the network
they were told to use.

**[`lab/labTransport.ts`](../lab/labTransport.ts) reproduces pipecat's reconnect
state machine deliberately** — the 5 s `disconnected` grace, the rebuild on
`failed`, `startNewPeerConnection()` **before** `closePeerConnection(old)`,
three `sendonly` transceivers. A harness that recovers _better_ than the
shipping transport proves nothing about the shipping transport. That fidelity
is what surfaced the silent-reconnect defect.

What the network suite proves is never "WebRTC reconnects". It is the manager's
half: across a break and a recovery the **capture tracks stay live, no second
`getUserMedia` is issued, and the m-line count stays at three**. A call that
comes back by re-prompting for the microphone has not come back.

## Tier 3: the demo page

```bash
pnpm dev            # then open http://127.0.0.1:5183/demo.html
```

Press **Start call**. Nothing is acquired until you do — no permission prompt
on load. The right-hand videos are your own camera and screen after a real
encode → RTP → decode round trip.

| Panel                      | Healthy                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| video lane, frames encoded | climbing steadily, ~24–30 fps at 640×360, 300–600 kbps                                                            |
| screenVideo lane           | climbing **slowly** — ~5 fps is the policy, at your real display resolution                                       |
| audio lane                 | packets sent climbing ~50/s; `framesEncoded` reads `n/a`, which is correct                                        |
| mic meter                  | moves when you speak — `getStats()` `audioLevel` from the **receiving** peer, never Web Audio on the capture path |
| m-lines in the offer       | **3**, before, during and after a screen share                                                                    |
| renegotiations needed      | **0**, including a screen share started mid-call                                                                  |

A live video lane stuck on a red `0` is the failure worth reporting. The page's
own "things to try" list is at the bottom: unplug a headset mid-call, press the
browser's own _Stop sharing_, switch Bluetooth output, background the tab, deny
a permission.

`e2e/demo.spec.ts` loads this same page in all three engines — the demo is the
thing under test, not a second implementation of it.

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs typecheck, lint,
format check, build and tier 1 in one job, then tier 2 as a matrix over the
three engines. The Playwright report and any failure traces upload as
artifacts.

CI installs only the engine the shard needs (`playwright install --with-deps
<engine>`), which is why the matrix is per-project rather than one job running
all three.
