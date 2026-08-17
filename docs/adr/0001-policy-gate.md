# ADR-0001: Human-in-the-loop policy gate lives in the Rust native-messaging bridge

## Status

Accepted

## Context

Momo is a Chrome Manifest V3 "autonomous AI browser agent". The LLM issues tool
calls that mutate the page (`click`, `type`, `navigate`) and dispatch trusted
input (`human_click`, `human_type`). These are irreversible, security-sensitive
operations, so they must not execute unless a human-in-the-loop policy approves
them.

The extension spans several JavaScript trust domains: the service worker (SW),
the side panel, content scripts injected into the page, and an offscreen document
hosting the LLM. Any of these JS contexts is only as trustworthy as the extension
bundle itself — a bug or a compromised dependency in any one of them could bypass
an in-JS safety check. The gate therefore needs a boundary that a JS-level
failure cannot silently cross.

## Decision

The authoritative policy gate lives in the Rust native-messaging host
(`agent.bridge`, `bridge/src/policy.rs`) — a separate OS-level process outside the
extension's JavaScript trust domain.

- Every DOM write tool calls `authorizeViaBridge(...)` (TypeScript,
  `src/lib/tool-registry.ts`), which forwards a `POLICY_CHECK` /
  `SIMULATE_CLICK` / `SIMULATE_TYPE` request over
  `chrome.runtime.sendNativeMessage('agent.bridge', ...)`.
- The Rust side evaluates each request in `PolicyEngine::evaluate`, in order:
  1. `check_origin` — domain allowlist. An empty allowlist fails closed (deny
     all). A wildcard entry (`*.example.com`) matches the apex plus subdomains
     only. `navigate` is gated on the destination URL; every other action is
     gated on the current page origin.
  2. `check_action_permitted` — action whitelist.
  3. `classify_risk` — derive a `RiskClass` from the action.
  4. `check_token_budget` — enforce the per-session token budget.
  5. `requires_confirmation` — apply `ConfirmationPolicy`
     (`Always`/`Sensitive`/`Never`) together with sensitive-field detection
     (`is_sensitive_field`), producing a `ConfirmationData` payload when set.
  6. `deduct_tokens` — commit the token cost.
- `evaluate` returns `allowed: bool`, `requires_confirmation`, and `risk_class`.
  The TypeScript tool blocks on `!allowed` and, when `requires_confirmation` is
  set, surfaces a confirmation request to the side panel.
- Sensitive-field detection is fail-closed: `is_sensitive_field` matches selector
  keyword fragments, and for selector-less `human_type` it consults the
  `field_is_sensitive` flag computed by inspecting `document.activeElement`, with
  `unwrap_or(true)` so a missing flag still requires confirmation.
- CDP-trusted input (`human_click`, `human_type`) is dispatched only after an
  explicit `allowed` decision.
- Audit records are written from the Rust side (`log_audit`).

## Alternatives considered

- **Policy checks entirely in TypeScript (SW).** Rejected: every JS context
  shares the extension's trust domain; an in-JS gate is not a real boundary and
  can be bypassed by a bug in the same process it guards.
- **Policy checks in content scripts.** Rejected: content scripts run in the
  page's world and are the least-trusted context; they are a data source, not a
  control point.
- **Native-messaging Rust policy engine (chosen).** Provides an OS-level trust
  boundary, fail-closed enforcement, and audit logging outside the JS runtime.

## Consequences

Positive:
- Irreversible DOM writes cannot execute without a Rust-side allow/deny decision.
- Empty-allowlist fail-closed means a default (unconfigured) install can do nothing.
- Sensitive-field confirmation and audit logging are enforced outside the JS layer.

Negative / trade-offs:
- Every write action now pays a native-messaging round-trip (added latency).
- The policy engine assumes `chrome.debugger` is the sole trusted-input path and
  does not independently verify input provenance.
- Sensitive-field detection for focused `human_type` depends on the TS side
  resolving `document.activeElement` correctly; a failure to resolve fails closed
  (confirmation required), which is safe but may over-prompt.

## References

- `bridge/src/policy.rs` — `PolicyEngine::evaluate`, `check_origin`,
  `is_sensitive_field`, `requires_confirmation`.
- `src/lib/tool-registry.ts` — `authorizeViaBridge` and the
  `click`/`type`/`navigate`/`human_click`/`human_type` tools.
- Security fixes captured in the graph: #1 (click/type gate), #2 (focused
  human_type sensitivity), #3 (confirmation events to side panel), #4 (SW
  suspension detach).
