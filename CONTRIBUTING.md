# Contributing

Thanks for looking. This package has a narrow job — own local media for
pipecat's `SmallWebRTCTransport`, with no proprietary dependency — and the
things worth contributing are mostly browser facts we have not measured yet.

## Getting set up

```bash
git clone https://github.com/voqalize/voqalize-client-transport
cd voqalize-client-transport
pnpm install
pnpm exec playwright install chromium firefox webkit
pnpm test
```

Node 20+ and pnpm 10+. The two pipecat packages are peer dependencies and are
installed as devDependencies here.

## Before you open a pull request

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm build && pnpm test
```

CI runs exactly this. `pnpm format` fixes the third one.

## Where a change goes

- **`src/`** is the published library. Nothing in it may import from `lab/`,
  `tests/` or `e2e/`, and nothing in it may name a DOM type where a
  `mediaPlatform.ts` type would do — `src/mediaManager.ts` has to run over the
  fake platform in node and over `navigator.mediaDevices` in a browser, and it
  is the same file in both.
- **`lab/`** is the harness: the two platforms, the loopback, the relay, the
  transport reproduction, and the three pages. It is not published.
- **`tests/`** is tier 1, **`e2e/`** is tier 2. Read
  [docs/TESTING.md](docs/TESTING.md) first.

## The rules that are not negotiable

**No Daily, and no remotely-loaded code.** The entire reason this package
exists is that installing `SmallWebRTCTransport` installed
`@daily-co/daily-js`, which fetches JavaScript from a third-party origin at
runtime and evaluates it. A dependency that reaches the network for code, or a
`new Function` / `eval` in `src/`, is not a tradeoff to weigh.

**Every behavioural assertion goes in `tests/contract/cases.ts`, once.** Two
drivers run it — vitest over the fake platform and Playwright over three real
engines. A case that only makes sense in one tier says so (`tiers: ["unit"]`,
`tiers: ["browser"]`); a case that needs an engine capability declares it
(`requires: ["multipleMics"]`) and takes a **named skip** where it is missing.

**Never weaken a case to make an engine pass.** A tier-1 pass that fails tier 2
is a bug in our model of the browser: fix the manager, or fix the fake. A
capability gate is a claim, and an unverified claim hides bugs for as long as
it stands — that is not rhetoric, it is
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

The useful report names the engine and version, says what
`pnpm exec playwright test --project=<engine>` did, and — if it is a media
problem — includes what the demo page showed:

```bash
pnpm dev   # http://127.0.0.1:5183/demo.html, press Start call
```

A lane stuck on 0 frames encoded, with the m-line count and the renegotiation
counter, is worth more than a stack trace.

## Commits and releases

Conventional-ish commit subjects (`fix:`, `feat:`, `docs:`, `test:`), imperative
mood, and a body that says _why_ when the _what_ is not obvious from the diff.

Releases are tag-driven: bump the version and the `CHANGELOG.md` entry, tag
`v<version>`, and the release workflow publishes to npm with provenance. Only
maintainers can cut one.

## Licence

MIT. By contributing you agree your contribution is licensed the same way.
