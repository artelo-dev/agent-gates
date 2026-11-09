# Changelog

## 0.1.0

First public release.

- CLI: `agent-gates` (run), `init`, `detect`, `hook claude`.
- Gates: tsc, eslint, build, tests, content-lint, axe, visual, lighthouse, playwright smoke (from a spec), custom commands.
- Claude Code Stop hook with working-tree fingerprinting and a consecutive-block limit.
- `AGENTS.md` definition-of-done block and a GitHub Actions workflow from `init`.
- Content-lint baseline for existing repos; respects `.gitignore`; catches "Placeholder …" and "Your text here" copy.
- `next typegen` before tsc on Next.js projects without generated route types.
