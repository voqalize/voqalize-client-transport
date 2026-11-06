/**
 * Stands in for `@daily-co/daily-js` inside this package's build (see
 * `tsup.config.ts`).
 *
 * pipecat's `SmallWebRTCTransport` imports daily-js at the top of its module
 * for `DailyMediaManager`, its default media manager, which loads daily's call
 * machine into the page. This package always hands the transport
 * `VoqalizeMediaManager` instead, so the default is never built, but a
 * bundler keeps a static import whether or not it runs. We bundle the
 * transport ourselves with this stub in daily's place, so no app that uses
 * this package ships daily-js or needs any configuration to avoid it.
 *
 * If anything does reach it, it fails loudly rather than loading daily.
 */
function unavailable(): never {
  throw new Error(
    "@voqalize/client-transport does not include daily-js: build the transport with createVoqalizeTransport()",
  );
}

export default {
  createCallObject: unavailable,
  getCallInstance: unavailable,
  version: unavailable,
};
