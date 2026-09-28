---
name: gen-docs
description: Update Kimi Code CLI user documentation after meaningful code changes that affect product behavior or user experience.
---

# Gen Docs

## Overview

This repository maintains bilingual user documentation under `docs/`. `docs/en/` and `docs/zh/` are mirrored pairs for most pages; update both in the same change. **Changelog is the exception** — English is the source, and Chinese is translated from English.

Use this skill to update the corresponding documentation whenever the codebase has changes that affect product behavior or user experience.

For a **full pre-release audit** of all pages (detecting hallucinations and coverage gaps), run this same workflow with the scope widened to every docs section — read each page, verify every claim against the implementation, and check both locales against the `docs/AGENTS.md` checklist.

## Prerequisites

This skill depends on the following being in place. If any are missing, stop and report to the user before continuing:

- `docs/` directory with `docs/zh/`, `docs/en/`, and `docs/.vitepress/config.ts` set up (VitePress site).
- `docs/AGENTS.md` style guide — defines source-of-truth rules, terminology table, typography, and writing style.
- `translate-docs` skill in `.agents/skills/` — handles bilingual synchronization.

## Workflow

1. **Inspect changes**

   - `git log main..HEAD --oneline` — commits on the current branch
   - `git diff main..HEAD --stat` — file-level scope
   - `ls .changeset/*.md` (excluding `README.md`) — pending changeset entries
   - Read `apps/kimi-code/CHANGELOG.md` and any subpackage `packages/*/CHANGELOG.md` for already-recorded entries.

2. **Understand user-facing impact**

   For each change, read the actual implementation when needed; **do not infer behavior from commit messages or PR titles alone**. Skip:

   - Internal refactors with no externally visible behavior change
   - Tests, CI, type-only changes
   - Tooling / build-system changes that do not change how users invoke the CLI

   If after the scan you conclude there is no user-facing impact, say so and stop.

3. **Changelog (post-release only)**

   Never hand-edit `docs/en/release-notes/changelog.md`, and never copy unreleased changeset drafts (`.changeset/*.md`) into it. The docs changelog is synced only after a release succeeds: invoke the `sync-changelog` skill, which copies the new version blocks from `apps/kimi-code/CHANGELOG.md` (the only upstream source) into the English page and translates the increment into Chinese on a dedicated branch and PR.

   If this change does not ship with a release — no published tag and no new version blocks at the top of `apps/kimi-code/CHANGELOG.md` — there is nothing to sync; continue with step 4.

4. **Update user docs**

   Following the rules in `docs/AGENTS.md`, edit the affected pages in whichever locale you are working in, then sync the mirror. Match terminology with the term table in `docs/AGENTS.md` and the existing wording in surrounding pages.

   Cover all relevant sections:

   - Guides (getting-started, use cases, interaction, sessions, IDE integration)
   - Customization (skills, agents, MCP, hooks, plugins, etc.)
   - Configuration (config files, env vars, providers, data locations)
   - Reference (CLI subcommands, slash commands, keyboard shortcuts)

5. **Sync bilingual content**

   Invoke the `translate-docs` skill to sync the updated non-changelog pages between `docs/en/` and `docs/zh/` — every page edited in step 4 gets its mirror updated in the same change.

   The changelog pair stays out of scope: both `docs/en/release-notes/changelog.md` and its Chinese mirror are written only by the `sync-changelog` skill during a release sync.

## Rules and conventions

- **Locale sync**: Non-changelog pages stay mirrored between `docs/en/` and `docs/zh/`. Changelog flows English → Chinese.
- **Terminology**: Use the term table in `docs/AGENTS.md` exactly. Do not invent new translations or use synonyms.
- **Scope discipline**: Only update sections affected by the recent changes. Do not opportunistically rewrite unrelated docs.
- **Public examples**: Never write real internal endpoints, key names, account names, or service names into docs. Use neutral placeholders such as `https://api.example.com/v1`, `https://registry.example.com/v1/models/api.json`, `example.test`, and `YOUR_API_KEY`.
- **Do not edit auto-synced files**: `docs/en/release-notes/changelog.md` is written only by the `sync-changelog` skill after a release; any manual edit will be overwritten by the next sync.

## Common mistakes

- Describing what code changed instead of what the user can now do (or can no longer do).
- Adding a new section heading per feature instead of weaving the change into existing prose.
- Updating only one locale and leaving its mirror stale.
- Editing only the mirror to fix wording that should be corrected in the locale you changed first.
- Inventing new terminology that drifts from the `docs/AGENTS.md` term table.
- Using real internal values in examples instead of neutral `example` placeholders.
