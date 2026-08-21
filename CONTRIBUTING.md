<div align="center">

# Contributing to Momo

**Building the future of autonomous browser automation together**

[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/HoldTroop/Momo/pulls)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org)
[![Code of Conduct](https://img.shields.io/badge/code%20of%20conduct-contributor%20covenant-purple.svg)](CODE_OF_CONDUCT.md)

</div>

---

## Welcome Contributors

Thank you for your interest in contributing to Momo, the autonomous AI browser extension. This guide will help you understand our development process, coding standards, and how to submit high-quality contributions.

Whether you're fixing a bug, adding a feature, improving documentation, or enhancing tests, your contribution is valued and appreciated.

---

## Table of Contents

- [Code of Conduct & Principles](#code-of-conduct--principles)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Commit Conventions](#commit-conventions)
- [Pull Request Process](#pull-request-process)
- [Release Process](#release-process)
- [Reporting Issues](#reporting-issues)
- [Project Structure](#project-structure)
- [Testing Guidelines](#testing-guidelines)
- [Documentation Standards](#documentation-standards)

---

## Code of Conduct & Principles

### Community Standards

For community behavior standards and reporting guidelines, see our [Code of Conduct](CODE_OF_CONDUCT.md).

All contributors are expected to adhere to our code of conduct to maintain a welcoming, inclusive, and respectful community.

### Project Principles

This project is built on core principles that guide all contributions:

#### 1. Policy-Compliant and Transparent

- **Do not introduce** anti-bot evasion, fingerprint spoofing, or deception techniques
- Success metric is **"authorized, explainable, reversible, and reliable"** — not "undetected"
- All automation must be transparent and use official Chrome APIs

#### 2. Trusted Input Execution

- Trusted input goes through CDP `Input` API or Rust `InputExecutor`
- Content-script fallbacks must be explicitly documented as untrusted (`isTrusted: false`)
- Never bypass the policy engine for action authorization

#### 3. Data Privacy and Security

- Sensitive data must be redacted before any LLM observation
- Redact: passwords, secrets, PII, credit cards, tokens, API keys
- See `src/lib/redaction.ts` for implementation details

#### 4. Fail-Closed Security Model

- Default deny for all actions
- Policy engine is authoritative
- Security cannot be bypassed through error conditions

---

## Getting Started

### Prerequisites

Before you begin, ensure you have the following installed:

| Requirement | Version | Check Command |
|-------------|---------|---------------|
| **Node.js** | 18 or higher | `node --version` |
| **Rust** | 1.70 or higher | `rustc --version` |
| **Chrome/Chromium** | 118 or higher | `chrome://version/` |
| **Git** | Any recent version | `git --version` |

### Initial Setup

```bash
# 1. Fork the repository on GitHub
# Click the "Fork" button at https://github.com/HoldTroop/Momo

# 2. Clone your fork
git clone https://github.com/YOUR_USERNAME/Momo.git
cd Momo

# 3. Add upstream remote
git remote add upstream https://github.com/HoldTroop/Momo.git

# 4. Install dependencies
npm install

# 5. Build the Rust bridge
npm run build:bridge

# 6. Build the extension
npm run build

# 7. Load extension in Chrome
# Open chrome://extensions/, enable Developer mode, click "Load unpacked", select dist/
```

### Development Commands

```bash
# Build everything (extension + bridge)
npm run build:all

# Build extension only (Vite → dist/)
npm run build

# Build Rust bridge only (Cargo → target/release/agent-bridge)
npm run build:bridge

# Watch mode (auto-rebuild on file changes)
npm run dev

# Run tests
npm run test

# Run tests in watch mode
npm run test -- --watch

# Linting
npm run lint

# Type checking
npx tsc --noEmit

# Rust tests
cd bridge && cargo test
```

---

## Development Workflow

### 1. Create a Feature Branch

```bash
# Update your local main branch
git checkout main
git pull upstream main

# Create a new feature branch
git checkout -b feature/your-feature-name
```

### 2. Make Your Changes

- Write clean, readable code following the project's style
- Add tests for new functionality
- Update documentation as needed
- Ensure all tests pass

### 3. Test Your Changes

```bash
# Run all tests
npm run test
cd bridge && cargo test && cd ..

# Type checking
npx tsc --noEmit

# Linting
npm run lint

# Manual testing
# Load the extension in Chrome and test the functionality
```

### 4. Commit Your Changes

Follow our [commit conventions](#commit-conventions) (detailed below).

### 5. Push and Create PR

```bash
# Push your branch to your fork
git push origin feature/your-feature-name

# Create a Pull Request on GitHub
# Navigate to https://github.com/HoldTroop/Momo/pulls
```

---

## Commit Conventions

We use [Conventional Commits](https://www.conventionalcommits.org/) for clear, structured commit history. This convention drives automatic `CHANGELOG.md` generation and release note categorization.

### Commit Format

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Commit Types

| Type | Category | When to Use | Example |
|------|----------|-------------|---------|
| `feat:` | **Feature** | New feature or capability | `feat: add human-in-the-loop confirmation modal` |
| `fix:` | **Fix** | Bug fix | `fix: correct watchdog alarm period` |
| `docs:` | **Documentation** | Documentation only changes | `docs: update installation guide` |
| `style:` | **Style** | Code style changes (formatting, semicolons) | `style: format with prettier` |
| `refactor:` | **Refactor** | Code restructuring without behavior change | `refactor: extract policy engine to separate module` |
| `perf:` | **Performance** | Performance improvements | `perf: optimize DOM compression algorithm` |
| `test:` | **Test** | Adding or updating tests | `test: add unit tests for redaction engine` |
| `chore:` | **Chore** | Build process, tooling, dependencies | `chore: update dependencies` |
| `ci:` | **CI/CD** | CI configuration changes | `ci: add automated release workflow` |

### Breaking Changes

For breaking changes, add `!` after the type or include `BREAKING CHANGE:` in the footer:

```bash
# Method 1: Using !
feat!: move debugger permission to optional

BREAKING CHANGE: users must now grant the debugger permission on first CDP attach.

# Method 2: Using footer
feat: redesign policy configuration format

BREAKING CHANGE: The policy configuration schema has changed. Migration guide in docs/MIGRATION.md
```

### Commit Message Guidelines

**Good commit messages:**
```
feat: add WebSocket reconnection with exponential backoff

Implements automatic reconnection when the bridge connection drops.
Includes exponential backoff (1s, 2s, 4s, 8s, max 30s) and connection
state tracking in the UI.

Closes #123
```

**What to avoid:**
```
fix: bug fix              # Too vague
Update code               # No type prefix
feat: add stuff and fix things  # Multiple changes in one commit
```

### Commit Best Practices

1. **One logical change per commit** - Don't mix refactoring with new features
2. **Keep commits atomic** - Each commit should be self-contained
3. **Write clear descriptions** - Explain what and why, not how
4. **Reference issues** - Use `Closes #123` or `Fixes #456`
5. **Keep subject line under 72 characters**
6. **Use imperative mood** - "Add feature" not "Added feature"

---

## Pull Request Process

### Before Submitting

**Pre-submission checklist:**

- [ ] Code follows project style and conventions
- [ ] All tests pass (`npm test` and `cargo test`)
- [ ] Type checking passes (`npx tsc --noEmit`)
- [ ] Linting passes (`npm run lint`)
- [ ] Documentation is updated (if applicable)
- [ ] `CHANGELOG.md` is updated under `[Unreleased]` (for user-facing changes)
- [ ] Commit messages follow conventional commits format
- [ ] Branch is up to date with `main`

### PR Template

When you create a pull request, our template will guide you through providing:

1. **Summary** - Clear description of what the PR does and why
2. **Type of Change** - Feature, bug fix, breaking change, or chore
3. **Related Issue** - Link to related issue(s) with `Closes #123`
4. **Testing** - How you tested the changes
5. **Screenshots** - If applicable (UI changes)
6. **Notes for Reviewers** - Anything reviewers should know

### PR Labels

Apply appropriate labels to help categorize your PR:

| Label | Purpose |
|-------|---------|
| `feature` | New feature or enhancement |
| `fix` | Bug fix |
| `bug` | Bug report or investigation |
| `documentation` | Documentation improvements |
| `chore` | Maintenance, dependencies, tooling |
| `breaking-change` | Breaking changes requiring version bump |
| `security` | Security-related changes |
| `performance` | Performance improvements |

### Review Process

1. **Automated Checks** - CI runs tests, type checking, and linting
2. **Code Review** - Maintainers review code quality and design
3. **Feedback** - Address reviewer comments and suggestions
4. **Approval** - At least one maintainer approval required
5. **Merge** - Maintainer will merge when approved

### After Your PR is Merged

- **Delete your feature branch** (optional but recommended)
- **Update your local repository**:
  ```bash
  git checkout main
  git pull upstream main
  ```
- **Celebrate!** Your contribution is now part of Momo

---

## Release Process

Momo follows semantic versioning with a `-legacy` suffix for the current release line.

### Version Format

```
v<major>.<minor>.<patch>-legacy

Example: v0.3.0-legacy
```

### Release Workflow

Releases are automated via GitHub Actions (`.github/workflows/release.yml`):

**Steps:**

1. **Create annotated tag:**
   ```bash
   git tag -a v0.3.0-legacy -m "v0.3.0-legacy: Add MCP integration and policy improvements"
   ```

2. **Push tag to GitHub:**
   ```bash
   git push origin v0.3.0-legacy
   ```

3. **Automated build** - GitHub Actions builds the extension and bridge

4. **Draft release created** - Auto-generated release notes from PRs and commits

5. **Review and publish** - Maintainer reviews draft and publishes

### What Gets Released

- **Extension bundle** - Built extension in `dist/` as a ZIP file
- **Release notes** - Auto-generated from conventional commits
- **CHANGELOG.md** - Updated with release details
- **Git tag** - Immutable reference to the release commit

### Release Note Categories

Based on commit types, release notes are organized into:

- **Breaking Changes** - `feat!`, `fix!`, or `BREAKING CHANGE:` footer
- **Features** - `feat:` commits
- **Fixes** - `fix:` commits
- **Chore / Internal** - `chore:`, `refactor:`, `docs:`, `test:`, `ci:`, `perf:`

---

## Reporting Issues

### Before Opening an Issue

1. **Search existing issues** - Your issue may already be reported
2. **Check documentation** - Review docs for known issues or solutions
3. **Try latest version** - Ensure you're on the most recent release

### Issue Templates

We provide templates for common issue types:

#### Bug Report Template

- **Summary** - Brief description of the bug
- **Steps to Reproduce** - Numbered steps to reproduce the issue
- **Expected Behavior** - What should happen
- **Actual Behavior** - What actually happens
- **Environment** - Chrome version, OS, Momo version
- **Logs** - Relevant error logs or screenshots

#### Feature Request Template

- **Summary** - Brief description of the feature
- **Motivation** - Why this feature would be valuable
- **Proposed Solution** - How you envision the feature working
- **Alternatives Considered** - Other approaches you've thought about

### Issue Labels

Maintainers will add labels to triage issues:

| Label | Meaning |
|-------|---------|
| `bug` | Something isn't working |
| `enhancement` | New feature or improvement |
| `documentation` | Documentation improvements |
| `good first issue` | Good for newcomers |
| `help wanted` | Extra attention needed |
| `question` | Further information requested |
| `wontfix` | This will not be worked on |

---

## Project Structure

Understanding the codebase structure helps you navigate and contribute effectively:

```
Momo/
├── src/                          # Chrome extension source (TypeScript)
│   ├── sw/                       # Service worker components
│   │   ├── orchestrator.ts       # Task orchestration and state machine
│   │   ├── message-router.ts     # Message dispatch and bridge commands
│   │   ├── cdp-adapter.ts        # Chrome DevTools Protocol wrapper
│   │   ├── ws-client.ts          # WebSocket client with reconnection
│   │   ├── alarm-manager.ts      # Persistent alarms for task resumption
│   │   └── index.ts              # Service worker entry point
│   ├── content/                  # Content scripts (ISOLATED world)
│   │   ├── perception.ts         # Readability + Turndown + ref-id injection
│   │   ├── ax-extractor.ts       # Accessibility tree extraction
│   │   ├── dom-observer.ts       # MutationObserver for page changes
│   │   └── human-input.ts        # Untrusted input fallback
│   ├── sidepanel/                # React side panel UI
│   │   └── index.tsx             # Streaming chat, task controls
│   └── lib/                      # Shared libraries
│       ├── tool-registry.ts      # Tool definitions and executors
│       ├── persistence.ts        # Dexie IndexedDB with WAL
│       ├── redaction.ts          # Secret/PII redaction engine
│       ├── selector.ts           # Element selection heuristics
│       └── task-queue.ts         # Task queuing and scheduling
├── bridge/                       # Rust backend (Tokio + Axum)
│   └── src/
│       ├── main.rs               # Entry point, dual-mode routing
│       ├── ws_server.rs          # WebSocket server
│       ├── mcp_stdio.rs          # MCP stdio transport
│       ├── mcp_tools.rs          # MCP tool schemas
│       ├── policy.rs             # Policy engine
│       ├── llm.rs                # LLM gateway
│       └── types.rs              # Shared types
├── docs/                         # Documentation
│   ├── ARCHITECTURE.md           # System architecture
│   ├── FAQ.md                    # Frequently asked questions
│   ├── adr/                      # Architecture decision records
│   └── audits/                   # Security and technical audits
├── tests/                        # Integration tests
├── tools/                        # Development utilities
├── manifest.json                 # Chrome extension manifest
├── vite.config.ts                # Vite build configuration
├── package.json                  # Node.js dependencies
├── tsconfig.json                 # TypeScript configuration
└── CONTRIBUTING.md               # This file
```

### Key Directories

- **`src/sw/`** - Service worker is the orchestration hub
- **`src/content/`** - Content scripts run in page context
- **`src/lib/`** - Shared utilities used across components
- **`bridge/src/`** - Rust bridge enforces policy and manages LLM
- **`docs/`** - All documentation lives here

---

## Testing Guidelines

### Test Coverage Goals

We aim for comprehensive test coverage across all components:

**Current Coverage:**
- TypeScript: 32 tests across redaction, DOM compression, perception
- Rust: 27 tests covering MCP tools, WebSocket, policy engine

### Writing Tests

#### TypeScript Tests (Vitest)

Tests are co-located with source files:

```typescript
// src/lib/redaction.test.ts
import { describe, it, expect } from 'vitest';
import { redactText } from './redaction';

describe('redaction', () => {
  it('should redact passwords', () => {
    const input = 'password: secret123';
    const result = redactText(input);
    expect(result).toBe('password: [REDACTED]');
  });
});
```

#### Rust Tests (Cargo)

```rust
// bridge/src/policy.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_allowlist_exact_match() {
        let policy = PolicyEngine::new();
        assert!(policy.is_allowed("example.com"));
    }
}
```

### Running Tests

```bash
# TypeScript tests
npm test

# Rust tests
cd bridge && cargo test

# Watch mode (auto-run on file changes)
npm run test -- --watch

# Coverage report
npm run test -- --coverage
```

### Test Best Practices

1. **Test behavior, not implementation** - Focus on inputs and outputs
2. **One assertion per test** - Keep tests focused and clear
3. **Use descriptive test names** - `should redact credit card numbers`
4. **Mock external dependencies** - Don't hit real APIs in tests
5. **Test edge cases** - Empty inputs, null values, boundary conditions

---

## Documentation Standards

### When to Update Documentation

Documentation should be updated when:
- Adding new features or capabilities
- Changing existing behavior
- Fixing bugs that affect user experience
- Modifying architecture or design patterns
- Adding new configuration options

### Documentation Files

| File | Purpose |
|------|---------|
| `README.md` | Project overview, quick start, features |
| `docs/ARCHITECTURE.md` | System architecture and diagrams |
| `docs/FAQ.md` | Frequently asked questions |
| `CONTRIBUTING.md` | This file - contribution guidelines |
| `CHANGELOG.md` | Release history and changes |
| `SECURITY.md` | Security policy and reporting |

### Documentation Style Guide

1. **Be clear and concise** - Use simple language, avoid jargon
2. **Use examples** - Show code snippets and command examples
3. **Keep it current** - Update docs with code changes
4. **No emojis** - Maintain professional appearance
5. **Use proper markdown** - Headers, code blocks, tables, links
6. **Include badges** - Shield.io badges for key information

---

## Getting Help

### Community Resources

- **[GitHub Discussions](https://github.com/HoldTroop/Momo/discussions)** - Ask questions, share ideas
- **[GitHub Issues](https://github.com/HoldTroop/Momo/issues)** - Report bugs, request features
- **[Documentation](docs/)** - Comprehensive guides and references
- **[FAQ](docs/FAQ.md)** - Common questions and answers

### Contact

For questions about contributing:
- Open a [Discussion](https://github.com/HoldTroop/Momo/discussions)
- Comment on relevant [Issues](https://github.com/HoldTroop/Momo/issues)
- Review existing [Pull Requests](https://github.com/HoldTroop/Momo/pulls)

---

## Recognition

All contributors are recognized in our release notes and commit history. Significant contributions may be highlighted in project announcements.

We deeply appreciate your time and effort in making Momo better!

---

<div align="center">

**Thank you for contributing to Momo!**

[Code of Conduct](CODE_OF_CONDUCT.md) · [Security Policy](SECURITY.md) · [License](LICENSE.md)

**Made with focus by the Momo community**

</div>
