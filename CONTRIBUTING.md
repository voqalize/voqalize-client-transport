# Contributing

This package has a narrow job — own local media for pipecat's
`SmallWebRTCTransport` — and the things most worth contributing are browser
facts we have not measured yet.

## Setup

```bash
git clone https://github.com/voqalize/voqalize-client-transport
cd voqalize-client-transport
pnpm install
pnpm exec playwright install chromium firefox webkit   # first time only
pnpm test
```

Node 20+ and pnpm 10+. The two pipecat packages are peer dependencies and are
installed as devDependencies here.

## The gate

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm build && pnpm test
```

CI runs exactly this, then the browser suite as a matrix over chromium, firefox
and webkit. `pnpm format` fixes the third one. Current state: unit 70 passed /
9 skipped, browsers 255 passed / 12 skipped on macOS.

## The suites

Two runners, **one set of test bodies**. Every behavioural assertion is written
once in [`tests/contract/cases.ts`](tests/contract/cases.ts); vitest runs it in
node against a scriptable fake `MediaDevices`, and Playwright runs the same
bodies in three real browsers against `navigator.mediaDevices`.

```bash
pnpm test:unit                                  # node, ~1 s
pnpm test:e2e                                   # all three engines, ~1 min
pnpm exec playwright test --project=webkit      # one engine
pnpm report                                     # read the last run
```

`test:e2e` starts its own Vite dev server, so no separate `pnpm dev` is needed.
Alongside the contract driver, `e2e/` holds engine-capability probes
(`harness.spec.ts`), the call over a breakable UDP path (`network.spec.ts`),
the demo page (`demo.spec.ts`) and `createVoqalizeTransport()` against a real
`PipecatClient` (`factory.spec.ts`).

For a human check, `pnpm dev` serves the lab at <http://127.0.0.1:5183/> —
open `demo.html` and press **Start call**. Healthy looks like: the video lane
climbing at ~24–30 fps, the screen lane climbing slowly at ~5 fps and full
resolution, **3** m-lines and **0** renegotiations before, during and after a
mid-call screen share. A live lane stuck on a red `0` is the failure worth
reporting.

> The dev server binds **`127.0.0.1`, never `localhost`**. Vite resolves
> `localhost` to `[::1]` and binds IPv6-only, and Firefox gathers zero ICE
> candidates on an IPv6-loopback origin —
> [FINDINGS.md](docs/FINDINGS.md#firefox-gathers-zero-ice-candidates-on-an-1-origin).

## Where a change goes

- **`src/`** is the published library. Nothing in it may import from `lab/`,
  `tests/` or `e2e/`, and nothing in it may name a DOM type where a
  `mediaPlatform.ts` type would do — `src/mediaManager.ts` runs over the fake
  platform in node and over `navigator.mediaDevices` in a browser, and it is
  the same file in both.
- **`lab/`** is the harness: the two platforms, the loopback, the relay, the
  transport reproduction, and the three pages. It is not published.
- **`tests/`** is the node tier, **`e2e/`** the browser tier.

## The rules that are not negotiable

**No remotely-loaded code.** A dependency that reaches the network for code, or
a `new Function` / `eval` in `src/`, is not a tradeoff to weigh. CI asserts the
built `dist` imports nothing but the two declared peer dependencies.

**Every behavioural assertion goes in `tests/contract/cases.ts`, once.** A case
that only makes sense in one tier says so (`tiers: ["unit"]`,
`tiers: ["browser"]`); a case that needs an engine capability declares it
(`requires: ["multipleMics"]`) and takes a **named skip** where it is missing.

**Never weaken a case to make an engine pass.** A node-tier pass that fails in
a browser is a bug in our model of the browser: fix the manager, or fix the
fake. A capability gate is a claim, and an unverified claim hides bugs for as
long as it stands — that is not rhetoric, it is
[what happened to Firefox](docs/FINDINGS.md#firefox-gathers-zero-ice-candidates-on-an-1-origin)
for a week, hiding two real defects.

**Measurements go in `docs/FINDINGS.md`, with the engine and the version.** If
you overturn something written there, keep the old claim next to the correction
rather than deleting it. The wrong answer is how the next person avoids
re-deriving it.

**One `getUserMedia` per acquisition, and everything through the queue.** The
two documented exceptions are `getDisplayMedia` and `resumePlayback()`, both of
which must stay inside the caller's user-activation window. Adding a third
needs a reason in [docs/DESIGN.md](docs/DESIGN.md).

## Reporting a browser-specific failure

Name the engine and version, say what
`pnpm exec playwright test --project=<engine>` did, and — if it is a media
problem — include what `demo.html` showed. A lane stuck on 0 frames encoded,
with the m-line count and the renegotiation counter, is worth more than a stack
trace.

## Commits and releases

Conventional-ish subjects (`fix:`, `feat:`, `docs:`, `test:`), imperative mood,
and a body that says _why_ when the _what_ is not obvious from the diff.

Releases are tag-driven: bump the version and the `CHANGELOG.md` entry, tag
`v<version>`, and the release workflow publishes to npm with provenance. Only
maintainers can cut one.

## Licence

MIT. By contributing you agree your contribution is licensed the same way.
