/**
 * The voice runtime's messages to this library, byte for byte as the voice runtime sends them. The voice runtime's
 * `TestCallHealthMessageShapes` (internal/smallwebrtc/calleraudio_test.go) and
 * `TestCallerVideoMessageShape` (callervideo_test.go) assert the same strings:
 * change both together.
 */
export const RUNTIME = {
  callerAudio: {
    ok: `{"data":{"audio":"ok"},"label":"voqalize","type":"caller-audio"}`,
    silent: `{"data":{"audio":"silent"},"label":"voqalize","type":"caller-audio"}`,
    none: `{"data":{"audio":"none"},"label":"voqalize","type":"caller-audio"}`,
  },
  callerVideo: {
    ok: `{"data":{"video":"ok"},"label":"voqalize","type":"caller-video"}`,
    black: `{"data":{"video":"black"},"label":"voqalize","type":"caller-video"}`,
    none: `{"data":{"video":"none"},"label":"voqalize","type":"caller-video"}`,
  },
  networkQuality: {
    good: `{"data":{"quality":"good"},"label":"voqalize","type":"network-quality"}`,
    fair: `{"data":{"quality":"fair"},"label":"voqalize","type":"network-quality"}`,
    poor: `{"data":{"quality":"poor"},"label":"voqalize","type":"network-quality"}`,
    bad: `{"data":{"quality":"bad"},"label":"voqalize","type":"network-quality"}`,
  },
} as const;
