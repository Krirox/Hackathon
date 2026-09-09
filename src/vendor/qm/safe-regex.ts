/**
 * PROVENANCE — vendored, not written.
 *   source:        https://github.com/yc-software/qm
 *   commit:        60ba79195dc84aa85a23f238749656e11c88696c (2026-09-08)
 *   upstream path: src/util/safe-regex.ts (68 lines)
 *   license:       MIT — see LICENSE-THIRD-PARTY.md
 *
 * WHAT WAS CHANGED AND WHY
 *   Nothing. Verbatim copy: zero imports, zero coupling.
 *
 * EDIT RULE: do not "improve" this file. If upstream fixes it, re-vendor and
 * note the new SHA above. Vital-side adaptations go in non-vendored code.
 */
const MAX_PATTERN_CHARS = 256;

export function compileSafeRegex(pattern: string, flags = ""): RegExp {
  if (!pattern || pattern.length > MAX_PATTERN_CHARS)
    throw new Error(`pattern must be 1-${MAX_PATTERN_CHARS} characters`);
  if (/\\[1-9]|\\k<|\(\?[=!<]/.test(pattern)) throw new Error("backreferences and lookarounds are not supported");

  const groups: Array<{ quantified: boolean; alternation: boolean }> = [];
  let escaped = false;
  let inClass = false;
  let previousQuantifier = false;
  let closed: { quantified: boolean; alternation: boolean } | null = null;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (escaped) {
      escaped = false;
      previousQuantifier = false;
      closed = null;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      previousQuantifier = false;
      closed = null;
      continue;
    }
    if (ch === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (ch === "(") {
      groups.push({ quantified: false, alternation: false });
      previousQuantifier = false;
      closed = null;
      continue;
    }
    if (ch === "|") {
      if (groups.length) groups[groups.length - 1]!.alternation = true;
      previousQuantifier = false;
      closed = null;
      continue;
    }
    if (ch === ")") {
      closed = groups.pop() ?? { quantified: false, alternation: false };
      previousQuantifier = false;
      continue;
    }
    const quantifier = ch === "*" || ch === "+" || (ch === "?" && pattern[i - 1] !== "(") || ch === "{";
    if (quantifier) {
      if (previousQuantifier || (closed && (closed.quantified || closed.alternation))) {
        throw new Error("nested or ambiguous repetition is not supported");
      }
      if (groups.length) groups[groups.length - 1]!.quantified = true;
      previousQuantifier = true;
      closed = null;
      continue;
    }
    previousQuantifier = false;
    closed = null;
  }
  return new RegExp(pattern, flags);
}
