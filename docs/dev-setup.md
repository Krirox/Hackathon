# Dev setup (traps recorded so nobody rediscovers them)

- Node 22: `C:\Program Files\nodejs\node.exe` on this machine. The
  `node`/`npx` shims may be absent from the agent bash PATH — call the
  binary by absolute path: `"C:\Program Files\nodejs\node.exe"
  node_modules/typescript/bin/tsc`, `... node_modules/tsx/dist/cli.mjs
  test/run.ts`.
- `node:sqlite` emits an ExperimentalWarning. Harmless.
- Windows has no Unix sockets: transports take named pipes
  (`\\.\pipe\…`). jcode has no live Windows e2e coverage either, so every
  client keeps its transport injectable and every socket test runs through
  `test/fake-harness.ts` (real pipe, scripted protocol).
- `npm run typecheck` must be 0 errors; `npm test` must be fully green.
  Neither implies the other — the error-frame crash compiled clean and
  killed the process on first contact with a real harness.
- PowerShell is the agent shell here: quote paths with spaces, use `&` for
  executables with spaces, avoid `tail`/`ls` aliases — prefer the file
  tools.
