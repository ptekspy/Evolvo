# Evolvo

Evolvo runs one command (`pnpm start`) and operates as a fully autonomous GitHub-native engineering loop.

## Default model policy

- Evolvo runs with a persistent master instruction contract to keep behavior consistent across decisions.

## Master prompt

Evolvo now uses a centralized `MASTER_PROMPT` (see `src/masterPrompt.js`) that defines identity, autonomy, quality gates, TypeScript-only policy, perseverance before OpenAI escalation, and rich rationale-based communication in issue logs.


- **Primary model:** Ollama `qwen-coder-3:30b`.
- **Escalation model:** OpenAI `gpt-5.3-codex` only when the primary model fails/stalls.

## Autonomous cycle (continuous)

Evolvo runs continuously until the process is stopped or it restarts itself after merging changes.

1. Read open GitHub issues and evaluate what to work on next.
2. It can pick any actionable issue (not strictly oldest-first), or decide to create a new self-evolution issue.
3. Work one chosen issue with retries.
4. If blocked after retries, label issue `needs-human-intervention`.
5. Once completed, find linked PR, self-review it, fix if requested, and review again.
6. If approved, merge to `main`, `git pull --rebase origin main`, and restart itself.
7. If no actionable issues exist, self-analyze and create new self-evolution issues.

All progress is posted as timestamped comments on the issue being worked (issue event log behavior).

## Environment

```bash
GITHUB_OWNER=your-org-or-user
GITHUB_REPO=your-repo
GITHUB_TOKEN=ghp_xxx
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.3-codex
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen-coder-3:30b
MAX_ISSUE_ATTEMPTS=3
MAX_PR_FIX_ROUNDS=3
LOOP_DELAY_MS=2000
DRY_RUN=true
```

## Run

```bash
pnpm start
```

In `DRY_RUN=true`, Evolvo prints side effects instead of mutating GitHub or local git state.
