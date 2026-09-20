# Third-party code in this repository

Vital is its own codebase. The only third-party _code_ we carry is vendored
leaf modules under `src/vendor/` (each file carries a provenance header with
source URL, pinned commit SHA, upstream path, and what we changed and why).
Full license texts live upstream; the SPDX identifiers and pins below are the
binding record.

| Project                                             | Use                                                                                                                | License    | Pinned commit (verified)                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------- |
| [yc-software/qm](https://github.com/yc-software/qm) | absorb-from source: `src/vendor/qm/` leaf modules (`loops/governor.ts` first). We do **not** depend on or fork QM. | MIT        | `60ba79195dc84aa85a23f238749656e11c88696c` (2026-09-08) |
| [Buzz](https://buzz.xyz)                            | talk-layer surface (not vendored as code; bound at runtime).                                                       | Apache-2.0 | `218633b8fd6ee41aee8eb18ba9806e8d90694751` (2026-09-08) |
| [1jehuang/jcode](https://github.com/1jehuang/jcode) | hands: driven as a sibling process over `jcode-harness-api` (protocol mirrored in `src/jcode/`, not vendored).     | MIT        | `e65e47c31af2ab79346458ff1511bea533930b59` (2026-09-09) |

Name-collision warning (cost us a wrong-language rewrite once): `cnjack/jcode`
is a different, Go project. It is not used, not pinned, and must not be
re-cloned. `jcode` alone is ambiguous — always use the full identifier above.

Vendoring rules (`idea.md` §17): vendored code lives ONLY under `src/vendor/`;
nothing outside that directory may be edited to look like upstream; every
vendored file carries a provenance header; `scripts/verify:provenance`
(TODO §0.2) fails the build if a header SHA is missing or malformed.
