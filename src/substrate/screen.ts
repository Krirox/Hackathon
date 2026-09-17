/**
 * Substrate, part 4 (TODO §0.5): content screen in the `securityScreen` shape.
 *
 * `user_input` / `tool_response` hooks, score + threshold, `shadow` before
 * `enforce`, and it FAILS CLOSED: a backend that throws denies. The backend
 * is injected — the reference denylist backend below is a floor for tests
 * and bootstrapping, not a security claim. The prompt-injection suite in CI
 * (TODO §3.1) runs against this contract on every model AND harness swap.
 */

export type ScreenHook = 'user_input' | 'tool_response';
export type ScreenMode = 'shadow' | 'enforce';

export interface ScreenScore {
  score: number;
  flags: string[];
}

export interface ScreenBackend {
  scoreText(hook: ScreenHook, text: string): ScreenScore;
}

export interface ScreenResult extends ScreenScore {
  verdict: 'allow' | 'deny';
  /** True when enforcement would have denied but shadow mode only observed. */
  shadowed: boolean;
}

export interface ScreenOptions {
  threshold: number;
  mode: ScreenMode;
}

export function createContentScreen(backend: ScreenBackend, opts: ScreenOptions) {
  return {
    check(hook: ScreenHook, text: string): ScreenResult {
      let scored: ScreenScore;
      try {
        scored = backend.scoreText(hook, text);
      } catch {
        // Fail closed: a dead classifier denies rather than waves through.
        return { verdict: 'deny', score: 1, flags: ['classifier_error'], shadowed: false };
      }
      const over = scored.score >= opts.threshold;
      // A non-finite score (NaN from an unparseable judge, ±Infinity) fails
      // the comparison to `false` — without this gate a broken classifier
      // waves content through unexamined. Fail closed instead.
      if (!Number.isFinite(scored.score)) {
        return { verdict: 'deny', score: 1, flags: [...scored.flags, 'classifier_malformed'], shadowed: false };
      }
      if (!over) return { verdict: 'allow', score: scored.score, flags: scored.flags, shadowed: false };
      if (opts.mode === 'shadow') {
        return { verdict: 'allow', score: scored.score, flags: scored.flags, shadowed: true };
      }
      return { verdict: 'deny', score: scored.score, flags: scored.flags, shadowed: false };
    },
  };
}

export interface DenyPattern {
  re: RegExp;
  flag: string;
  weight: number;
}

const REFERENCE_PATTERNS: DenyPattern[] = [
  { re: /ignore\s+(all\s+)?previous\s+instructions/i, flag: 'direct_override', weight: 0.9 },
  { re: /you\s+are\s+now\s+/i, flag: 'role_reassign', weight: 0.7 },
  { re: /reveal\s+(your\s+)?(system|secret|private)/i, flag: 'exfiltration', weight: 0.8 },
  { re: /\b(exec|eval|child_process|rm\s+-rf)\b/i, flag: 'dangerous_primitive', weight: 0.6 },
  { re: /\[system\]/i, flag: 'role_forgery', weight: 0.9 },
];

/** Reference backend: summed pattern weights, capped at 1. Floor, not ceiling. */
export function denylistBackend(patterns: DenyPattern[] = REFERENCE_PATTERNS): ScreenBackend {
  return {
    scoreText: (_hook: ScreenHook, text: string): ScreenScore => {
      const flags: string[] = [];
      let score = 0;
      for (const p of patterns) {
        if (p.re.test(text)) {
          flags.push(p.flag);
          score += p.weight;
        }
      }
      return { score: Math.min(1, score), flags };
    },
  };
}
