---
name: ciwardclaw-maintainer
description: Workflow for maintaining CiwardClaw: investigate and patch CiwardClaw-specific regressions, run the right local verification, pack and globally install the tarball, refresh GitHub release assets, and always keep the `openclaw-latest.tgz` asset in sync with the newest packaged build.
---

# CiwardClaw Maintainer

Use this skill when the task is about maintaining `Ciward/CiwardClaw` as its own maintained distribution, not the official upstream release workflow.

This skill is for three recurring jobs:

1. **Fork development work** on `ciwardclaw-4.14`
2. **Local pack + install** validation for the forked CLI
3. **GitHub release refresh** for the fork, including the mandatory `latest` asset

## Core fork habits

- Default working branch is `ciwardclaw-4.14` unless the user explicitly says otherwise.
- Read the current file before editing it, especially README/docs files the user also edits.
- Treat user-edited content as intentional. If the user already changed or deleted something, do not restore the old version unless asked.
- Keep README-focused work grouped into a single README commit when practical.
- Use `scripts/committer "<message>" <files...>` for commits; do not hand-roll `git add`/`git commit` unless blocked.
- When a change is fork-only, keep the docs concise. README should explain the fork, not become a changelog.

## CiwardClaw development tips that keep paying off

### Provider/runtime compatibility

- For API-key OpenAI-compatible providers such as TokenLab/sub2api, do **not** assume `openai-codex-responses` will work. That transport expects ChatGPT/Codex OAuth-style token fields such as account id.
- For custom `/responses` endpoints, compare behavior with Codex request shape:
  - preserve `instructions`
  - avoid parameters the upstream rejects, such as `max_output_tokens` when the endpoint is strict
- When a provider error looks vague inside CiwardClaw, verify the real upstream/server-side message before deciding the fix. Sub2api-style proxies can reveal the real cause in server logs.
- If Gemini CLI / quota errors are classified incorrectly, inspect the exact error classifier strings before changing fallback behavior.

### Session/history/media behavior

- If image-like base64 gets preserved into session history as plain text, prefer converting explicit `data:image/...;base64,...` payloads into real image blocks before replaying history back to the model.
- When investigating heartbeat/session confusion, distinguish **session key** from **sessionId/transcript file**. `/new` can rotate the transcript while keeping the logical session key stable.
- When debugging “message spam” or unexpected auto replies, inspect the full event fan-in: background task completion, heartbeat wake, retry delivery, restart-resume, and system-event enqueue paths can all target the same user-facing session.

### Verification discipline

- Prefer the narrowest test that proves the touched behavior, then run `pnpm check`.
- Typical fork fix loop:
  1. reproduce from logs/session JSONL/config
  2. patch the smallest relevant surface
  3. run targeted tests
  4. run `pnpm check`
  5. if packaging/runtime surfaces changed, also run `pnpm pack` and a local install smoke
- For README-only edits, a repo-wide `pnpm check` may still run through the committer hook; let it.

## Pack and install workflow

When the user wants a fresh local installable CiwardClaw build:

1. Confirm the tree is in the intended state.
2. Run:

```bash
pnpm pack
```

3. Install the generated tarball globally:

```bash
npm install -g ./openclaw-<version>.tgz
```

4. Verify the installed version:

```bash
openclaw --version
```

5. If the user is testing a legacy local config, call out any config-compat warnings you observe.

## CiwardClaw release asset workflow

When the user wants the packaged CiwardClaw build uploaded or refreshed on GitHub:

### Release target

- Repo: `Ciward/CiwardClaw`
- Branch: usually `ciwardclaw-4.14`
- Stable asset names:
  - versioned: `openclaw-<version>.tgz`
  - moving alias: `openclaw-latest.tgz`

### Non-negotiable rule

**Every time the packaged fork tarball is uploaded or refreshed, also refresh `openclaw-latest.tgz`. Do not update only the versioned asset.**

This keeps the one-command install path working:

```bash
npm install -g https://github.com/Ciward/CiwardClaw/releases/latest/download/openclaw-latest.tgz
```

### Refresh procedure

Assuming `openclaw-<version>.tgz` already exists locally:

1. Check release state:

```bash
gh release view v<version> --repo Ciward/CiwardClaw --json assets,url
```

2. Copy the versioned tarball to the moving alias name:

```bash
cp -f openclaw-<version>.tgz openclaw-latest.tgz
```

3. Upload **both** assets with clobber:

```bash
gh release upload v<version> \
  openclaw-<version>.tgz \
  openclaw-latest.tgz \
  --repo Ciward/CiwardClaw \
  --clobber
```

4. Verify both assets are present and the latest link resolves:

```bash
gh release view v<version> --repo Ciward/CiwardClaw --json assets,url
curl -L -o /dev/null -sS -w '%{http_code} %{url_effective}\n' \
  https://github.com/Ciward/CiwardClaw/releases/latest/download/openclaw-latest.tgz
```

5. Clean up the temporary alias file if needed:

```bash
rm -f openclaw-latest.tgz
```

### Release notes guidance

- Keep release notes concise.
- Include the one-command latest install snippet when relevant.
- If the README/install docs mention fork installation, keep them aligned with the `openclaw-latest.tgz` URL.

## Push workflow

When the user says “push” after fork work:

1. Check branch status.
2. `git fetch fork <branch>`
3. Confirm the current branch is the intended fork branch.
4. Push to `fork`.
5. Verify the remote HEAD SHA if the push matters.

## Expected final report shape

When you finish a fork-maintainer task, report:

- current branch
- what changed
- what was packaged/uploaded/pushed
- verification run
- whether `openclaw-latest.tgz` was refreshed
- remaining risks or follow-up
