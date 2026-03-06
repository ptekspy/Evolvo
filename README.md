# Evolvo

Evolvo runs one command (`pnpm start`) and operates as a GitHub-native engineering loop that can branch locally, edit files, validate changes, open/update PRs, self-review, and auto-merge.

## Current instruction thread (Issue #21)

**Next meaningful development outcome:**

Build and merge a production-ready TypeScript migration baseline by converting core `.js` source modules to `.ts`, keeping behavior unchanged, and ensuring tests and build validation pass.

### Acceptance criteria

- Migrate an initial vertical slice of runtime code from JavaScript to TypeScript (at minimum: prompt composition, provider selection boundary, and one orchestration entry path).
- Keep existing autonomous loop behavior functionally equivalent (no fabricated outcomes; no regression in issue/PR flow logic).
- Add or update tests to cover migrated TypeScript modules and preserve current behavioral assertions.
- Ensure the validation gate passes (`tests pass` and `build/typecheck passes`) before merge.
- Open/update PR with rationale quality including: **Intent, Trade-offs, Evidence, Next step**.

### Why this is the right next step

- The master policy already requires TypeScript-only implementation for modified/generated product code.
- A focused migration baseline unlocks safer future self-evolution by introducing stronger static guarantees where orchestration decisions are made.
- This outcome is measurable and benchmark-friendly for future challenge issues.

## Default model policy

- Evolvo runs with a persistent master instruction contract to keep behavior consistent across decisions.

## Master prompt

Evolvo now uses a centralized `MASTER_PROMPT` (see `src/masterPrompt.js`) that defines identity, autonomy, quality gates, TypeScript-only policy, perseverance before OpenAI escalation, and rich rationale-based communication in issue logs.


- **Primary model:** configurable with `PRIMARY_MODEL_PROVIDER=ollama|openai`.
- **Default primary:** Ollama `qwen-coder-3:30b`.
- **Fallback model:** whichever other provider is configured and available.

## Autonomous cycle (continuous)

Evolvo runs continuously until the process is stopped or it restarts itself after merging changes.

1. Read open GitHub issues and evaluate what to work on next.
2. Prepare a deterministic local branch from `origin/main` for the chosen issue.
3. Use a constrained action loop to inspect files, edit code, and run validation.
4. Commit only the touched files and push the issue branch with token-based git auth.
5. Create or update a PR with a controlled `Closes #<issue>` marker.
6. Self-review the PR against the diff plus validation output, post that review as a PR comment, and if changes are requested run another fix cycle and update the PR.
7. Auto-merge only when the latest validation passes and the self-review approves the PR.
8. If blocked after retries, label the issue `needs-human-intervention`.
9. If no actionable issues exist, self-analyze and create deduped self-evolution issues.

All progress is posted as timestamped comments on the issue being worked.

## Human challenge benchmark issue

To benchmark Evolvo capability growth, create a human-defined issue with a clear acceptance bar. Suggested format:

- **Title:** `Challenge: <capability area>`
- **Scope:** one concrete feature or reliability improvement
- **Constraints:** TypeScript-only product changes, no fabricated results
- **Acceptance criteria:** explicit behavior + test expectations
- **Evidence required:** validation summary and rationale (intent, trade-offs, evidence, next step)

Example challenge:

- Implement a resilient provider failover improvement that retries Ollama before OpenAI escalation.
- Add unit tests covering retry exhaustion and successful fallback.
- Update issue/PR rationale quality so logs always include intent, trade-offs, evidence, and next step.

This gives Evolvo a measurable target for the next evolution step and makes progress comparable over time.

## Environment

```bash
GITHUB_OWNER=your-org-or-user
GITHUB_REPO=your-repo
GITHUB_TOKEN=ghp_xxx
PRIMARY_MODEL_PROVIDER=ollama
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.3-codex
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen-coder-3:30b
MAX_ISSUE_ATTEMPTS=3
MAX_PR_FIX_ROUNDS=3
MAX_AGENT_STEPS=40
COMMAND_TIMEOUT_MS=120000
LOG_LEVEL=info
LOOP_DELAY_MS=2000
DRY_RUN=true
```

## Requirements

- The repo must be clean before a live run. Untracked `.env*`, `.evolvo/`, `dist/`, `node_modules/`, `pnpm-lock.yaml`, and `tsconfig.tsbuildinfo` are treated as local runtime/tooling artifacts; other local changes still block execution.
- `.evolvo/`, `dist/`, `node_modules/`, `pnpm-lock.yaml`, and `tsconfig.tsbuildinfo` should stay untracked in this repo.
- `pnpm start` loads `.env` automatically on Node 22+.
- The configured GitHub token must have issue, PR, and push permissions for the target repo.
- `PRIMARY_MODEL_PROVIDER=openai` requires `OPENAI_API_KEY`.
- Console logging is controlled by `LOG_LEVEL` with `debug`, `info`, `warn`, and `error`.

## Run

```bash
pnpm start
```

For live execution, set `DRY_RUN=false`.

`DRY_RUN=true` is useful for orchestrator-level testing, but the fully stateful local workspace flow is intended for live runs.
