# Upstream pins — verify the identifier, not the name

Cloned under `.upstream/` (gitignored, never enters our history).
Absorbed code additionally records its SHA per-file in provenance headers;
`LICENSE-THIRD-PARTY.md` is the binding record.

| Repo | Clone URL | Pinned SHA | Date | Why |
|---|---|---|---|---|
| QM | `https://github.com/yc-software/qm` | `60ba79195dc84aa85a23f238749656e11c88696c` | 2026-09-08 | absorb-from source (leaf modules only, MIT) |
| Buzz | `https://github.com/block/buzz.git` | `218633b8fd6ee41aee8eb18ba9806e8d90694751` | 2026-09-08 | talk-layer surface (Apache-2.0) |
| jcode (real) | `https://github.com/1jehuang/jcode` | `e65e47c31af2ab79346458ff1511bea533930b59` | 2026-09-09 | Rust harness API we drive (MIT v0.84.0) |
| TDAM | `https://github.com/TencentCloud/TencentDB-Agent-Memory` | `8f2dc830317934e54548472bf62c5999f9bb1202` | 2026-09-15 | read-only reference for the §29 moat-scope correction (MIT, LICENSE text verified). **No code absorbed, no dependency — so no `LICENSE-THIRD-PARTY.md` row.** |

Name-collision warning: `cnjack/jcode` is a **different, Go** project that
shares the name. We cloned it once, then rewrote our own correct docs to
match the wrong clone. `jcode` alone is ambiguous — always use the full
`1jehuang/jcode` identifier. The impostor clone has been deleted; do not
re-clone it.

Refresh: re-clone or fetch each remote, `git rev-parse HEAD`, compare
against this table before absorbing anything new.

## Change + rebase policy

We may modify any of these (licenses permit it), but "rebase to
latest" means something different per repo — because we hold them
differently:

- **QM — re-vendor, never fork.** We run zero QM code; we hold narrowed
  copies of leaf modules. "Rebase" = re-run the vendoring (byte-compare
  against the new SHA, update the provenance header + this table +
  `LICENSE-THIRD-PARTY.md`), then the full suite must stay green. No
  fork repo, no merge discipline, nothing to rebase in the git sense.
  Cadence: when we need an upstream fix, or monthly — not floating.
- **Buzz — extend first, fork only with cause.** Preferred: new Nostr
  event kinds + `buzz-cli` subcommands against unmodified Buzz (its own
  contributor guide says the same). If a patch is unavoidable, it lives
  in a **separate fork repo** (never as edits in `.upstream/`, which is
  gitignored reference and evaporates), rebased onto Block's `main`
  before each deploy, with `just ci` green there. Budget merge time:
  this is a relay+desktop+mobile monorepo, not a library.
- **jcode — drive, don't fork.** We speak its harness API as a sibling
  process. Fork only if the API itself is insufficient (missing
  capability we can name), because a fork means building and shipping
  Rust binaries per platform. Same separate-fork-repo rule as Buzz.
- **TDAM — read, never absorb.** Assessed 2026-09-15 for the §29 moat-scope
  correction (`idea.md` §29): do not depend on it, do not absorb it. The
  clone exists so the assessment stays re-checkable against the pinned
  SHA; "rebase" here means re-reading a new HEAD and updating §29, never
  vendoring.

In all three cases: no silent drift. A rebase that changes vendored
semantics updates headers, pins, and the tests that prove the semantics
— `npm run verify:provenance` fails the build otherwise.

## Velocity note (2026-09-09)

Buzz shows ~1.5k open issues / ~2k open PRs; QM and Buzz both moved within
a day of our Sept 8 pins (verified live with `scripts/upstream-drift.mjs`;
jcode in sync). Consequences:

1. Pins, not floating — re-checked by the weekly drift workflow. Rebase
   monthly or when we need an upstream fix, never continuously.
2. The faster upstream moves, the more a fork costs — this is the
   extend-don't-fork argument compounding. Every patch we carry is merge
   debt against thousands of upstream changes.
3. The flip side of 2k open PRs: upstream accepts outside work. Generic
   improvements go upstream as PRs; every merged one permanently shrinks
   our patch surface. Contributing upstream IS the rebase strategy.
