# Frequently Asked Questions (FAQ)

## General Questions

### What is Momo?

Momo is a fully autonomous AI browser extension that executes complex multi-step browser tasks using your authenticated sessions, residential IP, and local hardware. It operates entirely locally with transparent, policy-governed interactions.

### How is it different from cloud-based automation?

Unlike cloud-based solutions, Momo runs in your real Chrome profile with access to your cookies, sessions, certificates, and behavioral history. All execution happens locally—no cloud dependency for task execution.

### What does "policy-compliant" mean?

Every action Momo performs passes through a fail-closed policy engine that checks origin allowlists, action permissions, token budgets, and risk classifications. Actions are denied by default unless explicitly authorized.

### What Chrome version do I need?

Chrome or Chromium 118 or higher with Manifest V3 and `chrome.debugger` support.

---

## Installation & Setup

### What are the prerequisites?

- **Node.js** 18 or higher
- **Rust** 1.70 or higher with Cargo
- **Chrome or Chromium** 118 or higher
- **Operating System**: Linux, macOS, or Windows

### How do I install Momo?

```bash
git clone https://github.com/HoldTroop/Momo.git
cd Momo
npm install
npm run build:bridge  # Compiles Rust bridge
npm run build         # Builds extension to dist/
```

Then load the `dist/` folder as an unpacked extension at `chrome://extensions/` with Developer mode enabled.

### Why do I need both the extension and bridge?

The extension provides browser integration and UI, while the Rust bridge enforces security policies, manages LLM inference, and maintains the audit log. The bridge is the authoritative trust boundary—the extension cannot self-authorize actions.

### Do I need an API key?

For Mode A (internal orchestration), you can use either Anthropic Claude (requires `ANTHROPIC_API_KEY`) or Ollama for local inference (no key needed). For Mode B (MCP client control), the external MCP client handles LLM inference.

### How do I configure the bridge?

The bridge accepts environment variables:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."       # Optional: for cloud LLM
export OLLAMA_BASE_URL="http://localhost:11434"  # Optional: for local inference
export MOMO_COMMAND_TIMEOUT_MS=30000        # Optional: command timeout
```

---

## Security & Privacy

### Is my data sent to the cloud?

Execution happens entirely locally. If you use Anthropic's API for LLM inference, task descriptions and page content are sent to Anthropic. If you use Ollama, everything stays on your machine. In Mode B, the external MCP client controls what data leaves your system.

### How does the policy engine work?

The policy engine in the Rust bridge evaluates every action request against:
- **Origin allowlists**: Which domains can be automated
- **Action permissions**: Which operations (click, type, navigate, scroll) are allowed
- **Token budgets**: Resource limits per task
- **Risk classifications**: Sensitive/Moderate/Low with confirmation gates

If any check fails, the action is denied. See [SECURITY.md](../SECURITY.md) for details.

### Where are audit logs stored?

Audit logs are stored in SQLite at `~/.momo/policy.db`. Every authorization decision, action execution, and outcome is logged immutably for compliance and incident response.

### What happens if the policy engine fails?

Momo uses a **fail-closed** design. If the policy engine is unavailable, encounters an error, or cannot evaluate a request, all actions are denied by default. Security cannot be bypassed through error conditions.

### What data is redacted?

Passwords, API tokens, PII (email addresses, phone numbers, SSNs), and credit card numbers are redacted before entering LLM context, persistence, or logs. See `src/lib/redaction.ts` for the complete redaction engine.

### Does Momo try to evade bot detection?

No. Momo uses Chrome's official APIs (`chrome.debugger`, CDP Input) for transparent automation. It does not manipulate TLS fingerprints, user-agent strings, or behavioral signals to evade detection.

---

## Usage

### What tasks can Momo perform?

Momo can execute any multi-step browser task: form filling, data extraction, research, shopping, booking, navigation, and more. Tasks are described in natural language like "Find the cheapest flight from SFO to NYC on Google Flights for next weekend."

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

Wildcards (`*.google.com`) match subdomains but require subdomain-bounded matching.

### What are Mode A and Mode B?

- **Mode A (Internal Orchestration)**: The bridge manages task planning, LLM inference, and execution autonomously. Start with `./bridge/target/release/agent-bridge`.
- **Mode B (MCP over stdio)**: An external MCP client controls the browser through four MCP tools. Start with `./bridge/target/release/agent-bridge --mcp`.

See [README.md](../README.md) for usage examples.

### Can I stop a task mid-execution?

Yes. The side panel UI includes a kill switch that immediately aborts the current task and triggers rollback where possible.

### How do I open the side panel?

Click the Momo extension icon in your toolbar or use the keyboard shortcut `Ctrl+Shift+Y`.

### What happens if an action fails?

Momo includes self-recovery mechanisms for stale references, navigation changes, and transient errors. If recovery fails, the task is paused and you're notified through the side panel.

---

## Troubleshooting

### Extension not connecting to bridge

**Symptoms**: Side panel shows "Disconnected" or "Connecting..."

**Solutions**:
1. Verify the bridge is running: `ps aux | grep agent-bridge`
2. Check WebSocket port availability (9090-9100): `netstat -an | grep 909`
3. Review bridge logs: `RUST_LOG=debug ./bridge/target/release/agent-bridge`
4. Ensure firewall allows localhost WebSocket connections
5. Reload the extension at `chrome://extensions/`

### Actions being denied by policy

**Symptoms**: Task fails with "Policy denied" or "Origin not allowlisted"

**Solutions**:
1. Check your origin allowlist in `~/.momo/policy.db`
2. Verify the target domain is included (e.g., `example.com` or `*.example.com`)
3. Confirm `permitted_actions` includes the required operations
4. Review audit logs: `sqlite3 ~/.momo/policy.db "SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 10;"`
5. Ensure token budget is not exhausted

### Browser automation not working

**Symptoms**: Actions execute but don't affect the page

**Solutions**:
1. Verify Chrome debugger permission was granted (check `chrome://extensions/`)
2. Ensure the page is not in a sandboxed iframe or protected context
3. Check content script injection: Open DevTools → Sources → Content Scripts
4. Review CDP connection: Look for `[CDP]` logs in the service worker console
5. Try refreshing the page and restarting the task

### Stale reference errors

**Symptoms**: `execute_action` fails with "stale_reference" error

**Solutions**:
- This is expected after DOM mutations. Re-fetch `get_interactive_elements` to get updated element references.
- Momo's orchestrator handles this automatically in Mode A; in Mode B, your MCP client must handle retries.

### Bridge fails to start

**Symptoms**: `agent-bridge` exits immediately or shows errors

**Solutions**:
1. Check Rust version: `rustc --version` (requires 1.70+)
2. Rebuild the bridge: `cd bridge && cargo clean && cargo build --release`
3. Verify SQLite is available: `sqlite3 --version`
4. Check permissions on `~/.momo/` directory
5. Review startup logs for dependency errors

---

## Development & Contributing

### How can I contribute?

Read [CONTRIBUTING.md](../CONTRIBUTING.md) for detailed guidelines. Key points:
- Use Conventional Commits (`feat:`, `fix:`, `chore:`)
- Add tests for new features (Vitest for TypeScript, Cargo test for Rust)
- Update `CHANGELOG.md` under `[Unreleased]`
- Run `npm run lint` and `npx tsc --noEmit` before submitting PRs

### How do I run tests?

```bash
# TypeScript unit tests
npm test

# Rust tests
cd bridge && cargo test

# Type checking
npx tsc --noEmit

# Linting
npm run lint
```

### Where is the architecture documented?

See [docs/ARCHITECTURE.md](ARCHITECTURE.md) for diagrams and [docs/adr/](adr/) for architecture decision records. Interactive visualizations are available at `docs/architecture/index.html`.

### How do I debug the extension?

1. Open `chrome://extensions/` and click "Inspect views: service worker"
2. Review logs with namespaced prefixes: `[Orchestrator]`, `[MessageRouter]`, `[WsClient]`, `[CDP]`, `[Perception]`
3. Enable verbose logging: Check the Console filter settings

### How do I debug the bridge?

```bash
# Enable debug logs
RUST_LOG=debug ./bridge/target/release/agent-bridge

# Filter to specific modules
RUST_LOG=agent_bridge::mcp_tools=trace ./bridge/target/release/agent-bridge
```

### Can I test the bridge without the extension?

Yes. Use the mock extension client:

```bash
node tools/mock-extension.mjs roundtrip    # Test read_page_content
node tools/mock-extension.mjs interactive  # Test get_interactive_elements
node tools/mock-extension.mjs stale        # Test stale_reference handling
```

### What's the development workflow?

```bash
# Watch mode (extension auto-rebuild)
npm run dev

# Build everything
npm run build:all

# Run tests on save
npm run test -- --watch
```

### How do I add a new MCP tool?

1. Define the tool schema in `bridge/src/mcp_tools.rs`
2. Add command handling in `bridge/src/ws_server.rs`
3. Implement executor logic in the extension's `src/lib/tool-registry.ts`
4. Add policy checks in `bridge/src/policy.rs`
5. Update tests in both `bridge/src/` and `tests/`

---

## Additional Resources

- **[README.md](../README.md)**: Project overview and quick start
- **[ARCHITECTURE.md](ARCHITECTURE.md)**: System architecture and diagrams
- **[SECURITY.md](../SECURITY.md)**: Security model and best practices
- **[CONTRIBUTING.md](../CONTRIBUTING.md)**: Contribution guidelines
- **[CHANGELOG.md](../CHANGELOG.md)**: Release history and breaking changes
- **[ADRs](adr/)**: Architecture decision records
- **[Phase 9 MCP Plan](../PHASE9_MCP_PLAN.md)**: MCP integration design

---

**Have more questions?** [Open a discussion](https://github.com/HoldTroop/Momo/discussions) or [report an issue](https://github.com/HoldTroop/Momo/issues).
