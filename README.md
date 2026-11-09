# agent-gates

[![ci](https://github.com/artelo-dev/agent-gates/actions/workflows/ci.yml/badge.svg)](https://github.com/artelo-dev/agent-gates/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/agent-gates)](https://www.npmjs.com/package/agent-gates) [![license](https://img.shields.io/npm/l/agent-gates)](LICENSE)

Hard quality gates for any coding agent. Your agent says it's done. `agent-gates` checks whether that's true.

```
$ npx agent-gates
✓ tsc            2.0s  no type errors
✓ eslint         2.3s  no lint problems
✗ content-lint   0.0s  3 content problems (placeholder-text: 2, empty-href: 1)
    src/components/Promo.tsx:4  placeholder copy: "Placeholder" — <p className="text-[15px] font-medium text-fg">Placeholder promo headline.</p> [placeholder-text]
    src/components/Promo.tsx:5  placeholder copy: "Placeholder" — <p className="text-[13px] text-dim">Placeholder supporting line.</p> [placeholder-text]
    src/components/Promo.tsx:6  empty or "#" href: "href=\"#\"" — <a href="#" className="text-fg">Learn more</a> [empty-href]
✓ build          3.9s  build succeeded
✓ visual         3.9s  3 screenshots at 375/768/1440px

FAILED · 4 passed, 1 failed · report: .agent-gates/last/gates.json
```

Coding agents get you most of the way there. What's left over is a build that fails, a type error, "Lorem ipsum" or "Placeholder headline" in the copy, a `href="#"`, or a page that scrolls sideways on a phone. `agent-gates` runs the checks that catch those things and exits non-zero when any of them fail. The verdict comes from a script, so the agent can't argue its way to "done".

- **Works with any agent.** Claude Code gets a Stop hook that keeps Claude working until the gates pass. Codex, Gemini CLI, Cursor and other agents get a definition of done in `AGENTS.md`. CI runs the same command.
- **Zero config to start.** With no config file it detects what your project has (a tsconfig, an eslint config, `build` and `test` scripts) and runs those gates.
- **Fail closed.** A gate that can't run, because a tool or browser is missing, counts as failed. It never passes quietly.
- **Works on an existing repo from the first run.** `init` records the TODOs and placeholders you already have in a baseline, so only new ones fail.
- **Local, no account, no telemetry.** It's a Node CLI with one dependency (`yaml`).

## Quick start

```bash
npx agent-gates            # run the gates it detects
npx agent-gates detect     # show which gates apply here and why
npx agent-gates init --all # write agent-gates.yaml, plus the Claude hook, AGENTS.md block and CI workflow
```

Requires Node.js 20.19 or newer and git. You can also add it to the project with `npm i -D agent-gates`. `init` then points the hook at your local install instead of `npx --yes agent-gates@<version>`.

Exit codes are `0` when everything passed, `1` when a gate failed, and `2` for a usage or config error.

## Claude Code: no more premature "done"

```bash
npx agent-gates init --claude
```

This adds a [Stop hook](https://code.claude.com/docs/en/hooks) to `.claude/settings.json`. When Claude tries to finish, the gates run. If they fail, Claude gets the failures as file:line items and keeps working:

```
Stop hook feedback:
agent-gates: the task is not done. These checks fail (attempt 1 of 3):

[content-lint] 2 content problems (lorem: 1, empty-href: 1)
  - src/components/Promo.tsx:10:11: lorem ipsum placeholder text: "Lorem ipsum" [lorem]
  - src/components/Promo.tsx:12:12: empty or "#" href: "href=\"#\"" [empty-href]

Fix the causes and finish again; the checks re-run automatically.
```

That transcript is from a real Claude Code session. That time Claude had been asked for lorem ipsum, so it stopped and told the user the request and the gate conflict (see below). In another session it had been asked for "placeholder copy" and wrote "Placeholder headline". The hook blocked the stop, Claude replaced the copy with real sentences, the gates passed on the next stop, and the turn ended.

The hook is built not to get in the way:

- **No re-runs on idle turns.** It fingerprints the working tree (git diff + untracked files). When Claude only answered a question and nothing changed, the hook returns right away without running anything.
- **Fast feedback.** The quick gates (tsc, eslint, content-lint) always run. After a failure the expensive ones (build, tests, browser) are skipped until the next stop, so Claude hears about a type error in seconds, not after a full build. Use `--no-fail-fast` to run everything every time.
- **No endless loops.** After 3 consecutive blocked stops (`--max-blocks`) Claude is allowed to stop, and you get a warning. If Claude tries to stop again without changing anything, it is let go and you are told why.
- **Claude can push back.** If the gates conflict with what you asked for (for example "just use lorem ipsum for now"), Claude tells you about the conflict instead of quietly weakening the check.

Hook options are `--max-blocks <n>` (default 3), `--no-fail-fast` and `--output context|block`. `context`, the default, continues the turn and shows the failures as "Stop hook feedback". `block` uses `decision: "block"`.

## Codex, Gemini CLI, Cursor, Aider and others

```bash
npx agent-gates init --agents-md
```

This adds a short "Definition of done" block to `AGENTS.md`: the task isn't done until `agent-gates` exits 0, and the agent must not weaken a gate to get there. Agents that read `AGENTS.md` run it before they report back. Codex and Gemini CLI have native stop hooks too. Support for those is planned, but it hasn't been tested yet, so it isn't shipped.

## CI

```bash
npx agent-gates init --github
```

This writes `.github/workflows/agent-gates.yml`: install, then the Playwright browser if browser gates are on, then `agent-gates`, then upload the report and screenshots as an artifact. Inside GitHub Actions every failure is also printed as an `::error` annotation, so it shows up on the right line of the PR diff (turn it off with `--no-annotations`). In any other CI, run `npx agent-gates` and check the exit code.

## Gates

| Gate | Fails when | Needs |
|---|---|---|
| `tsc` | any type error | `tsconfig.json`. For Next.js 15.5+ it runs `next typegen` first, so route types exist on a fresh clone |
| `eslint` | any lint error | an eslint config |
| `build` | the `build` script fails | a `build` script |
| `tests` | the `test` script fails | a real `test` script (npm's placeholder doesn't count) |
| `content-lint` | lorem ipsum, TODO/FIXME/TBD, `example.com`, empty or `#` links, `{PLACEHOLDER}` / `{{slot}}`, "Placeholder …" copy, "Your text here" | nothing (built in) |
| `axe` | critical or serious accessibility violations | `@playwright/test`, `@axe-core/playwright`, a `start` script |
| `visual` | horizontal overflow at 375 / 768 / 1440 px (screenshots saved) | `@playwright/test`, a `start` script |
| `lighthouse` | performance < 90, accessibility < 95, SEO < 95 | `lighthouse`, Chrome |
| `playwright` | a generated smoke test fails: every section from your spec is on the page, and every form fills and submits | `--spec <file>` with `pages[].sections[]` |

Browser gates run only after `build` passes. They start the app with your `start` script on port 3100, unless you set `server.command` or `server.url`. Content-lint scans what git tracks, so build output and anything else in `.gitignore` is skipped. Your own text about placeholders, in Markdown files and code comments, doesn't count. Only copy that ships does.

You can also run a subset: `npx agent-gates tsc eslint content-lint`. `--fail-fast` skips the expensive gates after the first failure, which is the hook's default.

## Configuration

`agent-gates.yaml` (written by `init`; every key is optional). The file starts with a `yaml-language-server` comment that points at [`schema/agent-gates.schema.json`](schema/agent-gates.schema.json), so VS Code (YAML extension) and JetBrains IDEs autocomplete keys and flag typos like `alowSkip`.

```yaml
server:
  port: 3100                 # or: command: "pnpm start", url: http://127.0.0.1:3000

gates:
  tsc:
    allowSkip: false         # a gate that cannot run fails (default)
  eslint:
    enabled: false           # off, never blocks
  content-lint:
    baseline: agent-gates.baseline.json
    exclude: ["legal/**"]    # globs, added to the defaults
    disableRules: [todo]     # lorem, todo, example-domain, empty-href, placeholder, placeholder-text, fill-in-text
    patterns: ["\\bAcme Corp\\b"]   # extra forbidden regexes
  lighthouse:
    required: false          # reported, never blocks
    thresholds: { performance: 80, accessibility: 95, seo: 95 }
  visual:
    viewports: [390, 1280]
    routes: [/, /pricing]
  my-check:                  # any command becomes a gate
    command: "pnpm run check:links"

env: [NEXT_PUBLIC_SITE_URL]  # extra variables passed to gate commands
```

To suppress a single line, put `content-lint-ignore` on it. To skip a whole file, put `content-lint-ignore-file` in its first 5 lines. To re-record the baseline after a cleanup, run `npx agent-gates init --force`.

## Security

The gates run code that an agent wrote: package scripts, configs, tests. Gate commands and the preview server get a scrubbed environment (PATH, HOME, TMPDIR, LANG, CI, NODE_ENV, PORT and a few tool paths). They never inherit your shell's `process.env`. Deploy tokens and LLM keys (`VERCEL_*`, `ANTHROPIC_*`, `OPENAI_*`, `AWS_*`, `GITHUB_TOKEN`, …) are refused even if you list them under `env:`.

## Library use

```ts
import { createGateRunner, loadGatesConfig } from 'agent-gates';

const config = await loadGatesConfig('agent-gates.yaml');
const report = await createGateRunner().run([], config, { runId: 'r1', cwd: process.cwd(), artifactsDir: '.agent-gates/last' });
if (!report.passed) process.exit(1);
```

## Status

This is version 0.1. The test suite passes on macOS and Linux (Node 20.19+), and it has been run against Next.js projects. Windows is not supported yet: CI runs it, but it is allowed to fail. Browser gates assume a Node web app with a `start` script. Issues and PRs are welcome.

agent-gates is the quality-gate layer of [Artelo](https://artelo.space), a local harness that takes a brief to a deployed project with the coding agents you already pay for. This part is free and MIT.

## License

MIT
