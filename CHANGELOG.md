# Changelog

## Unreleased

- JSON Schema for `agent-gates.yaml` (`schema/agent-gates.schema.json`), referenced from the file `init` writes: editor autocomplete and typo checks.
- GitHub Actions annotations: failures appear inline on the PR diff (`--no-annotations` to disable).
- Build script runs on Windows `cmd.exe`; CI matrix for Linux, macOS, Windows.

## 0.1.0

First public release.

- CLI: `agent-gates` (run), `init`, `detect`, `hook claude`.
- Gates: tsc, eslint, build, tests, content-lint, axe, visual, lighthouse, playwright smoke (from a spec), custom commands.
- Claude Code Stop hook with working-tree fingerprinting and a consecutive-block limit.
- `AGENTS.md` definition-of-done block and a GitHub Actions workflow from `init`.
- Content-lint baseline for existing repos; respects `.gitignore`; catches "Placeholder …" and "Your text here" copy.
- `next typegen` before tsc on Next.js projects without generated route types.
