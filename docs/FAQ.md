<div align="center">

# Frequently Asked Questions

**Everything you need to know about Momo**

[![Documentation](https://img.shields.io/badge/docs-FAQ-blue.svg)](https://github.com/HoldTroop/Momo/tree/main/docs)
[![Support](https://img.shields.io/badge/support-discussions-green.svg)](https://github.com/HoldTroop/Momo/discussions)
[![Issues](https://img.shields.io/badge/report-issue-red.svg)](https://github.com/HoldTroop/Momo/issues)

</div>

---

## Table of Contents

- [General Questions](#general-questions)
- [Installation & Setup](#installation--setup)
- [Security & Privacy](#security--privacy)
- [Usage](#usage)
- [Troubleshooting](#troubleshooting)
- [Development & Contributing](#development--contributing)
- [Additional Resources](#additional-resources)

---

## General Questions

### What is Momo?

Momo is a fully autonomous AI browser extension that executes complex multi-step browser tasks using your authenticated sessions, residential IP, and local hardware. It operates entirely locally with transparent, policy-governed interactions.

**Key Features:**
- Autonomous multi-step task execution
- Local-first architecture (no cloud dependency)
- Policy-governed security with fail-closed model
- Human-in-the-loop controls for sensitive actions
- Crash-resistant with write-ahead logging

### How is it different from cloud-based automation?

Unlike cloud-based solutions, Momo runs in your real Chrome profile with access to your cookies, sessions, certificates, and behavioral history. All execution happens locally—no cloud dependency for task execution.

| Feature | Momo | Cloud-Based Solutions |
|---------|------|----------------------|
| **Execution Location** | Local browser | Remote server |
| **Session Access** | Your authenticated sessions | Separate sessions |
| **IP Address** | Your residential IP | Data center IPs |
| **Privacy** | Data stays local | Data sent to cloud |
| **Setup** | One-time local install | Cloud account required |

### What does "policy-compliant" mean?

Every action Momo performs passes through a fail-closed policy engine that checks origin allowlists, action permissions, token budgets, and risk classifications. Actions are denied by default unless explicitly authorized.

**Policy Checks:**
- **Origin allowlists**: Which domains can be automated
- **Action permissions**: Which operations (click, type, navigate, scroll) are allowed
- **Token budgets**: Resource limits per task
- **Risk classifications**: Sensitive/Moderate/Low with confirmation gates

### What Chrome version do I need?

**Requirements:**
- Chrome or Chromium **118 or higher**
- Manifest V3 support
- `chrome.debugger` API support

Check your version at `chrome://version/`

---

## Installation & Setup

### What are the prerequisites?

| Component | Requirement |
|-----------|-------------|
| **Node.js** | 18 or higher |
| **Rust** | 1.70 or higher with Cargo |
| **Chrome/Chromium** | 118 or higher |
| **Operating System** | Linux, macOS, or Windows |

### How do I install Momo?

**Quick Installation:**

```bash
# 1. Clone the repository
git clone https://github.com/HoldTroop/Momo.git
cd Momo

# 2. Install dependencies
npm install

# 3. Build the Rust bridge
npm run build:bridge

# 4. Build the extension
npm run build
```

**Load in Chrome:**
1. Open `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `dist/` folder

**Start the bridge:**
```bash
./bridge/target/release/agent-bridge
```

For detailed instructions, see the [Getting Started guide](../README.md#getting-started).

### Why do I need both the extension and bridge?

The architecture uses a **trust boundary** design:

- **Extension (Untrusted Zone)**: Provides browser integration and UI, but cannot self-authorize actions
- **Bridge (Trusted Zone)**: Enforces security policies, manages LLM inference, and maintains the audit log

The bridge is the authoritative trust boundary—the extension cannot bypass policy enforcement.

### Do I need an API key?

It depends on your usage mode:

**Mode A (Internal Orchestration):**
- **Anthropic Claude**: Requires `ANTHROPIC_API_KEY` environment variable
- **Ollama (Local)**: No key needed, runs entirely on your machine

**Mode B (MCP Client Control):**
- External MCP client handles LLM inference
- No API key needed for the bridge

### How do I configure the bridge?

The bridge accepts configuration via environment variables:

```bash
# Optional: Anthropic API key for cloud LLM (Mode A only)
export ANTHROPIC_API_KEY="sk-ant-..."

# Optional: Ollama base URL for local inference (default: http://localhost:11434)
export OLLAMA_BASE_URL="http://localhost:11434"

# Optional: Command timeout in milliseconds (default: 30000)
export MOMO_COMMAND_TIMEOUT_MS=30000
```

**Save to `.env` file** in the bridge directory:
```bash
cd bridge
cat > .env <<EOF
ANTHROPIC_API_KEY=sk-ant-...
OLLAMA_BASE_URL=http://localhost:11434
MOMO_COMMAND_TIMEOUT_MS=30000
EOF
```

---

## Security & Privacy

### Is my data sent to the cloud?

**Execution:** All task execution happens entirely locally.

**LLM Inference:**
- **Anthropic API**: Task descriptions and page content are sent to Anthropic's API
- **Ollama**: Everything stays on your machine (fully local inference)
- **Mode B**: External MCP client controls what data leaves your system

**Data Flow:**
```
Local Execution → Bridge → [Anthropic API OR Ollama Local]
```

### How does the policy engine work?

The policy engine in the Rust bridge evaluates every action request against multiple criteria:

**Evaluation Criteria:**

| Check | Description | Failure Mode |
|-------|-------------|--------------|
| **Origin Allowlist** | Which domains can be automated | Deny if not in allowlist |
| **Action Permissions** | Which operations are allowed | Deny if action not permitted |
| **Token Budget** | Resource limits per task | Deny if budget exceeded |
| **Risk Classification** | Sensitive/Moderate/Low | Require confirmation for Sensitive |

If any check fails, the action is denied. See [SECURITY.md](../SECURITY.md) for complete details.

### Where are audit logs stored?

**Location:** `~/.momo/policy.db` (SQLite database)

**What's Logged:**
- Every authorization decision (allow/deny)
- Action execution attempts
- Execution outcomes (success/failure)
- Timestamps and request metadata
- Risk classifications

**Access Audit Log:**
```bash
# View recent entries
sqlite3 ~/.momo/policy.db "SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 10;"

# Export to CSV
sqlite3 -header -csv ~/.momo/policy.db "SELECT * FROM audit_log;" > audit.csv
```

The audit log is **immutable** for compliance and incident response.

### What happens if the policy engine fails?

Momo uses a **fail-closed** design:

- If the policy engine is unavailable
- If it encounters an error
- If it cannot evaluate a request

**Result:** All actions are denied by default.

Security cannot be bypassed through error conditions.

### What data is redacted?

The redaction engine removes sensitive data before it enters LLM context, persistence, or logs:

**Redacted Data Types:**
- Passwords and passphrases
- API tokens and bearer tokens
- PII (email addresses, phone numbers, SSNs)
- Credit card numbers
- Authentication credentials

See `src/lib/redaction.ts` for the complete implementation.

### Does Momo try to evade bot detection?

**No.** Momo uses Chrome's official APIs (`chrome.debugger`, CDP Input) for transparent automation.

**What Momo Does NOT Do:**
- Manipulate TLS fingerprints
- Spoof user-agent strings
- Alter behavioral signals
- Use evasion techniques

Momo operates transparently using Chrome's supported automation APIs.

---

## Usage

### What tasks can Momo perform?

Momo can execute any multi-step browser task:

**Common Use Cases:**
- Form filling and submission
- Data extraction and scraping
- Research and information gathering
- Shopping and price comparison
- Booking and reservations
- Navigation and exploration
- Testing and quality assurance

**Example Task:**
```
"Find the cheapest flight from SFO to NYC on Google Flights for next weekend"
```

### How do I configure origin allowlists?

Edit the policy configuration via the bridge's `POLICY_SET_CONFIG` request or directly in `~/.momo/policy.db`:

```json
{
  "origin_allowlist": ["example.com", "*.google.com"],
  "permitted_actions": ["click", "type", "navigate", "scroll"],
  "confirmation_policy": "Moderate",
  "token_budget_per_task": 200000
}
```

**Wildcard Syntax:**
- `example.com` - Exact domain only
- `*.google.com` - All Google subdomains (mail.google.com, drive.google.com, etc.)
- Requires subdomain-bounded matching for security

### What are Mode A and Mode B?

Momo operates in two distinct modes:

#### Mode A: Internal Orchestration

```
User → Extension UI → Service Worker → Bridge (LLM + Policy) → Browser
```

**Features:**
- Bridge manages task planning and LLM inference
- Autonomous execution with human-in-the-loop controls
- Streaming results to side panel
- Full crash recovery

**Start Mode A:**
```bash
./bridge/target/release/agent-bridge
```

#### Mode B: MCP over stdio

```
MCP Client → Bridge (MCP Server) → WebSocket → Extension → Browser
```

**Features:**
- External MCP client controls browser through 4 MCP tools
- Policy enforcement still active
- Suitable for integration with Claude Code, custom agents

**Start Mode B:**
```bash
./bridge/target/release/agent-bridge --mcp
```

**MCP Tools:**
- `read_page_content`: Extract Markdown from current page
- `get_interactive_elements`: Get pruned AX tree with stable refs
- `execute_action`: Click, type, scroll, or navigate
- `list_tabs`: Enumerate browser tabs

See [README.md](../README.md#usage) for usage examples.

### Can I stop a task mid-execution?

**Yes.** The side panel UI includes a **kill switch** that immediately:
- Aborts the current task
- Triggers rollback where possible
- Logs the abortion to the audit trail
- Returns control to the user

**Keyboard shortcut:** `Ctrl+Shift+Y` to open side panel, then click **Stop**

### How do I open the side panel?

**Methods:**
1. Click the Momo extension icon in your toolbar
2. Use keyboard shortcut: `Ctrl+Shift+Y`
3. Right-click the extension icon → "Open Side Panel"

### What happens if an action fails?

Momo includes **self-recovery mechanisms**:

**Recovery Strategies:**
- **Stale references**: Re-fetch element references automatically
- **Navigation changes**: Detect page changes and re-orient
- **Transient errors**: Retry with exponential backoff
- **DOM mutations**: Wait for stability before re-attempting

If recovery fails after multiple attempts, the task is paused and you're notified through the side panel with a detailed error report.

---

## Troubleshooting

### Extension not connecting to bridge

**Symptoms:** Side panel shows "Disconnected" or "Connecting..."

**Solutions:**

1. **Verify bridge is running:**
   ```bash
   ps aux | grep agent-bridge
   ```

2. **Check WebSocket port availability (9090-9100):**
   ```bash
   netstat -an | grep 909
   # OR
   lsof -i :9090-9100
   ```

3. **Review bridge logs:**
   ```bash
   RUST_LOG=debug ./bridge/target/release/agent-bridge
   ```

4. **Ensure firewall allows localhost WebSocket connections:**
   - Linux: `sudo ufw allow from 127.0.0.1`
   - macOS: Check System Preferences → Security & Privacy → Firewall
   - Windows: Check Windows Defender Firewall settings

5. **Reload the extension:**
   - Open `chrome://extensions/`
   - Click the reload icon on the Momo extension card

### Actions being denied by policy

**Symptoms:** Task fails with "Policy denied" or "Origin not allowlisted"

**Solutions:**

1. **Check your origin allowlist:**
   ```bash
   sqlite3 ~/.momo/policy.db "SELECT value FROM config WHERE key='origin_allowlist';"
   ```

2. **Verify the target domain is included:**
   - `example.com` - Exact match only
   - `*.example.com` - All subdomains

3. **Confirm permitted actions:**
   ```bash
   sqlite3 ~/.momo/policy.db "SELECT value FROM config WHERE key='permitted_actions';"
   ```

4. **Review audit logs for denial reasons:**
   ```bash
   sqlite3 ~/.momo/policy.db "SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 10;"
   ```

5. **Check token budget:**
   ```bash
   sqlite3 ~/.momo/policy.db "SELECT value FROM config WHERE key='token_budget_per_task';"
   ```

6. **Test with permissive policy first:**
   ```json
   {
     "origin_allowlist": ["*"],
     "permitted_actions": ["click", "type", "navigate", "scroll"],
     "confirmation_policy": "Low",
     "token_budget_per_task": 500000
   }
   ```
   **Warning:** Only use permissive policies in development/testing environments.

### Browser automation not working

**Symptoms:** Actions execute but don't affect the page

**Solutions:**

1. **Verify Chrome debugger permission was granted:**
   - Open `chrome://extensions/`
   - Check Momo's permissions
   - Look for "debugger" in the list

2. **Ensure page is not in protected context:**
   - Sandboxed iframes may block automation
   - Chrome internal pages (chrome://) cannot be automated
   - Some enterprise policies may restrict automation

3. **Check content script injection:**
   - Open DevTools (F12)
   - Go to Sources → Content Scripts
   - Verify Momo scripts are listed

4. **Review CDP connection:**
   - Open service worker console: `chrome://extensions/` → Inspect views: service worker
   - Look for `[CDP]` logs
   - Check for connection errors

5. **Refresh and retry:**
   - Refresh the target page
   - Restart the task
   - Clear browser cache if issues persist

### Stale reference errors

**Symptoms:** `execute_action` fails with "stale_reference" error

**This is expected behavior after DOM mutations.**

**Solutions:**

**Mode A (Automatic):**
- Momo's orchestrator handles stale references automatically
- Re-fetches element references when stale
- Retries action with fresh references

**Mode B (Manual):**
Your MCP client must handle retries:

```json
// 1. Get fresh elements
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_interactive_elements"}}

// 2. Use new ref from response
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"execute_action","arguments":{"action":"click","ref":"el_47"}}}
```

**Prevention:**
- Wait for page stability before actions
- Avoid actions during loading states
- Target less dynamic page sections

### Bridge fails to start

**Symptoms:** `agent-bridge` exits immediately or shows errors

**Solutions:**

1. **Check Rust version:**
   ```bash
   rustc --version  # Should be 1.70+
   ```

2. **Rebuild the bridge:**
   ```bash
   cd bridge
   cargo clean
   cargo build --release
   ```

3. **Verify SQLite is available:**
   ```bash
   sqlite3 --version
   ```

4. **Check permissions on `~/.momo/` directory:**
   ```bash
   ls -la ~/.momo/
   # Should be readable/writable by your user
   ```

5. **Review startup logs for dependency errors:**
   ```bash
   RUST_LOG=trace ./bridge/target/release/agent-bridge
   ```

6. **Install system dependencies:**
   - **Linux:** `sudo apt-get install pkg-config libssl-dev libsqlite3-dev`
   - **macOS:** `brew install openssl sqlite`
   - **Windows:** Install Visual Studio Build Tools with C++ workload

---

## Development & Contributing

### How can I contribute?

We welcome contributions! Please read [CONTRIBUTING.md](../CONTRIBUTING.md) for detailed guidelines.

**Key Points:**
- Use Conventional Commits (`feat:`, `fix:`, `chore:`)
- Add tests for new features (Vitest for TypeScript, Cargo test for Rust)
- Update `CHANGELOG.md` under `[Unreleased]`
- Run `npm run lint` and `npx tsc --noEmit` before submitting PRs

**Contribution Areas:**
- Bug fixes and feature additions
- Documentation improvements
- Test coverage expansion
- Performance optimizations
- Security enhancements

### How do I run tests?

```bash
# TypeScript unit tests (Vitest)
npm test

# Rust unit and integration tests
cd bridge && cargo test

# Type checking
npx tsc --noEmit

# Linting
npm run lint

# Run all checks
npm run test && cd bridge && cargo test && cd .. && npx tsc --noEmit && npm run lint
```

**Current Test Coverage:**
- TypeScript: 32 tests across redaction, DOM compression, and perception layers
- Rust: 27 tests covering MCP tools, WebSocket protocol, and policy engine

### Where is the architecture documented?

**Primary Documentation:**
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) - Comprehensive architecture with Mermaid diagrams
- [docs/architecture/](architecture/) - Interactive HTML visualizations

**Architecture Decision Records:**
- [docs/adr/](adr/) - ADRs documenting key architectural decisions
- [docs/adr/0001-policy-gate.md](adr/0001-policy-gate.md) - Policy boundary design

**Audit Reports:**
- [docs/audits/SECURITY_AUDIT_REPORT.md](audits/SECURITY_AUDIT_REPORT.md) - Security assessment
- [docs/audits/TECHNICAL_AUDIT.md](audits/TECHNICAL_AUDIT.md) - Technical analysis

### How do I debug the extension?

**Service Worker Debugging:**
1. Open `chrome://extensions/`
2. Find Momo extension
3. Click **Inspect views: service worker**
4. Use Chrome DevTools console

**Log Namespaces:**
- `[Orchestrator]` - Task execution and state transitions
- `[MessageRouter]` - Message dispatch and bridge commands
- `[WsClient]` - WebSocket connection and protocol
- `[CDP]` - Chrome DevTools Protocol interactions
- `[Perception]` - DOM/AXTree extraction

**Enable Verbose Logging:**
```javascript
// In service worker console
localStorage.setItem('debug', '*');
```

### How do I debug the bridge?

```bash
# Enable debug logs
RUST_LOG=debug ./bridge/target/release/agent-bridge

# Filter to specific modules
RUST_LOG=agent_bridge::mcp_tools=trace,agent_bridge::ws_server=debug ./bridge/target/release/agent-bridge

# Save logs to file
RUST_LOG=debug ./bridge/target/release/agent-bridge 2>&1 | tee bridge.log
```

**Log Levels:**
- `error` - Errors only
- `warn` - Warnings and errors
- `info` - Informational messages
- `debug` - Detailed debugging
- `trace` - Very verbose tracing

### Can I test the bridge without the extension?

**Yes.** Use the mock extension client:

```bash
# Test read_page_content round-trip
node tools/mock-extension.mjs roundtrip

# Test get_interactive_elements
node tools/mock-extension.mjs interactive

# Test execute_action with stale_reference error
node tools/mock-extension.mjs stale

# Test command timeout
MOMO_COMMAND_TIMEOUT_MS=2000 node tools/mock-extension.mjs timeout
```

The mock client simulates WebSocket communication without requiring the full extension.

### What's the development workflow?

```bash
# 1. Watch mode (extension auto-rebuild on file changes)
npm run dev

# 2. In another terminal, run the bridge
./bridge/target/release/agent-bridge

# 3. In another terminal, run tests on save
npm run test -- --watch

# 4. Make changes, tests run automatically

# 5. Build everything when ready
npm run build:all
```

### How do I add a new MCP tool?

**Steps:**

1. **Define tool schema** in `bridge/src/mcp_tools.rs`:
   ```rust
   pub fn get_new_tool_schema() -> Value {
       json!({
           "name": "new_tool",
           "description": "Tool description",
           "inputSchema": {
               "type": "object",
               "properties": { /* ... */ }
           }
       })
   }
   ```

2. **Add command handling** in `bridge/src/ws_server.rs`:
   ```rust
   "NEW_TOOL" => handle_new_tool(params),
   ```

3. **Implement executor logic** in `src/lib/tool-registry.ts`:
   ```typescript
   export const newTool: Tool = {
       name: "new_tool",
       executor: async (params) => { /* ... */ }
   }
   ```

4. **Add policy checks** in `bridge/src/policy.rs`:
   ```rust
   fn evaluate_new_tool(&self, params: &Value) -> Result<bool>
   ```

5. **Add tests** in both `bridge/src/` and `tests/`:
   ```rust
   #[test]
   fn test_new_tool() { /* ... */ }
   ```

---

## Additional Resources

### Documentation

- **[README.md](../README.md)** - Project overview and quick start
- **[ARCHITECTURE.md](ARCHITECTURE.md)** - System architecture and diagrams
- **[SECURITY.md](../SECURITY.md)** - Security model and best practices
- **[CONTRIBUTING.md](../CONTRIBUTING.md)** - Contribution guidelines
- **[CHANGELOG.md](../CHANGELOG.md)** - Release history and breaking changes

### Interactive Resources

- **[Interactive Architecture Visualizations](architecture/index.html)** - Detailed diagrams with tooltips
- **[Architecture Decision Records](adr/)** - ADRs documenting design decisions

### Audit Reports

- **[Security Audit Report](audits/SECURITY_AUDIT_REPORT.md)** - Third-party security assessment
- **[Technical Audit](audits/TECHNICAL_AUDIT.md)** - Implementation analysis

### Design Documents

- **[Phase 9 MCP Plan](../PHASE9_MCP_PLAN.md)** - MCP integration design

### Community

- **[GitHub Discussions](https://github.com/HoldTroop/Momo/discussions)** - Ask questions, share ideas
- **[GitHub Issues](https://github.com/HoldTroop/Momo/issues)** - Report bugs, request features
- **[Pull Requests](https://github.com/HoldTroop/Momo/pulls)** - Contribute code

---

<div align="center">

**Have more questions?**

[Open a Discussion](https://github.com/HoldTroop/Momo/discussions) · [Report an Issue](https://github.com/HoldTroop/Momo/issues) · [Read the Docs](https://github.com/HoldTroop/Momo/tree/main/docs)

**Last Updated:** August 2026

</div>
