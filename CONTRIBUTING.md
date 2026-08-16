# Contributing to Momo

Thanks for helping build the Autonomous AI Browser Extension. This guide explains
how to build, test, commit, and release so every change stays easy to categorize
and every release gets the same treatment automatically.

## Code of conduct & principles

- This project is **policy-compliant and transparent**. Do not introduce
  anti-bot evasion, fingerprint spoofing, or deception techniques. The success
  metric is "authorized, explainable, reversible, and reliable" — not "undetected".
- Keep automation transparent: trusted input goes through the CDP `Input` API or
  the Rust `InputExecutor`; content-script fallbacks are explicitly documented as
  untrusted (`isTrusted: false`).
- Sensitive data is redacted before any LLM observation (passwords, secrets, PII,
  credit cards, tokens).

## Getting started

```bash
# Install extension dependencies
npm install

# Build the extension (Vite → dist/)
npm run build

# Build the native messaging host (Rust → bridge/target/release/agent-bridge)
npm run build:bridge

# Build everything
npm run build:all

# Watch mode
npm run dev

# Tests / lint
npm run test
npm run lint
```

Prerequisites: Node.js 18+, Rust 1.70+, Chrome/Chromium 118+ (Manifest V3,
`chrome.debugger`).

## Commit conventions

We use [Conventional Commits](https://www.conventionalcommits.org/). The prefix
drives how a change is categorized in `CHANGELOG.md` and in the auto-drafted
release notes.

| Prefix | Category | Example |
|--------|----------|---------|
| `feat:` | 🚀 Feature | `feat: add human-in-the-loop confirmation modal` |
| `fix:` | 🐛 Fix | `fix: correct watchdog alarm period` |
| `feat!` / `fix!` (or `BREAKING CHANGE:`) | 💥 Breaking | `feat!: drop legacy CDP websocket path` |
| `chore:` / `refactor:` / `docs:` / `test:` / `ci:` / `perf:` | 🧰 Chore / Internal | `chore: pin cargo dependencies` |

Format: `<type>[!][scope]: <short description>` — keep the subject under ~72
characters, and put any migration notes in the body.

Example:

```
feat!: move debugger permission to optional

BREAKING CHANGE: users must now grant the debugger permission on first CDP attach.
```

## Pull requests

1. Use the PR template (auto-loaded) and check the change-type box.
2. Label the PR (`feature`, `fix`, `bug`, `chore`, `documentation`,
   `breaking-change`, etc.) — `release-drafter` uses these labels to auto-draft
   the next release.
3. Update `CHANGELOG.md` under `[Unreleased]` for anything user-facing.
4. Reference any related issue with `Closes #<number>`.

## Releases

Releases follow the `-legacy` line naming (`v0.1.0-legacy`, `v0.2.0-legacy`, …).

Two pieces of automation handle this for you:

- **`.github/workflows/release-drafter.yml`** — continuously drafts a release
  from merged PRs, auto-categorized by label. Review it before shipping.
- **`.github/workflows/release.yml`** — on any `v*` tag push, builds the
  extension (`dist/`), packages it into a zip, and creates a **draft** release
  with auto-generated notes so a human publishes it after review.

To cut a release:

```bash
# 1. Bump version + tag (annotated)
git tag -a v0.3.0-legacy -m "v0.3.0-legacy: <summary>"

# 2. Push the tag — release.yml builds and drafts the release
git push origin v0.3.0-legacy

# 3. Review the draft release notes on GitHub, then publish
```

## Reporting issues

Use the issue templates (bug report / feature request). Include the version,
environment, and — for bugs — numbered reproduction steps and any logs.

## Project layout

```
src/
├── sw/           Service worker: orchestrator, message router, alarms, CDP adapter
├── content/      Content scripts: AX extractor, DOM observer, human input fallback
├── offscreen/    Offscreen document: LLM worker, watchdog, metrics, kill switch
├── sidepanel/    React side panel UI
└── lib/          Persistence (Dexie/WAL), task queue, tool registry, LLM client
bridge/           Rust native messaging host (CDP, InputExecutor, policy engine, LLM gateway)
tests/            Test suite
```
