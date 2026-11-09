# Security

agent-gates runs code written by coding agents (package scripts, configs, tests), so isolation bugs matter. In particular we want to hear about:

- a way for a gate command or the preview server to read a variable that is not on the allowlist (the scrubbed environment in `src/exec/env.ts`), especially deploy tokens or LLM keys;
- a config or hook input that makes agent-gates run a command the user did not configure;
- a way for the hook to report "passed" while a required gate failed.

Please report privately via GitHub's "Report a vulnerability" (Security tab) or to hello@artelo.space, not in a public issue. You will get an answer within 3 days.
