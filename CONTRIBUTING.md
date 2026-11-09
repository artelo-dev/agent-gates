# Contributing

Thanks for helping. Bug reports with a reproduction are the most useful thing you can send.

## Development

```bash
npm ci
npm test          # vitest, no network, no real tools spawned except git and node
npm run typecheck
npm run build
node dist/cli/bin.js        # agent-gates checks itself (see agent-gates.yaml)
```

Node 20.19 or newer and git are required. CI runs Linux, macOS and Windows on Node 20.19, 22 and 24. Windows jobs are allowed to fail for now.

## Ground rules

- **Fail closed.** A gate that cannot run must report `skipped` (which blocks unless `allowSkip: true`) or `error`, never `passed`.
- **No new runtime dependencies** without a very good reason. Today there is one (`yaml`).
- **Content-lint rules need both lists.** Every new rule or change to a rule comes with tests for what it must catch and for what it must leave alone (see `placeholder copy rules` in `test/cli.test.ts`). If a rule is noisy on real projects it does not ship.
- **Agent-facing text is an interface.** The hook's feedback is read by Claude or Codex. Keep it short, file:line first, and never tell the agent to weaken a check.
- Keep the JSON Schema (`schema/agent-gates.schema.json`) in sync with config options; a test checks gates and rules.

## Commits and PRs

One logical change per PR, with a test. Conventional commit prefixes (`feat:`, `fix:`, `docs:`, `ci:`) are appreciated, not required. Add a line under `## Unreleased` in `CHANGELOG.md` for anything a user would notice.
