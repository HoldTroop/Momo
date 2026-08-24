# actions-7: Network interception / request-response verification

**Issue**: No network interception or request/response verification — agent cannot observe API calls, verify fetch results, or mock responses.

## 1. Files to modify

- **New file**: `src/lib/tools/network-observe.ts` — `observe_network` tool enabling CDP `Fetch.enable` / `Network.enable` for request/response capture
- **New file**: `src/lib/tools/network-verify.ts` — `verify_request` / `verify_response` tools checking URL patterns, status codes, headers, body content
- **New file**: `src/lib/tools/network-mock.ts` — `mock_response` tool using CDP `Fetch.fulfillRequest` to inject test data
- `src/sw/cdp-adapter.ts` — add `enableNetworkInterception(tabId)`, `getNetworkLog(tabId, filter?)`, `fulfillRequest(requestId, response)` methods
- `src/sw/orchestrator.ts` — add network event buffer (last N requests per tab) with filtering by URL pattern, method, status
- `src/lib/tool-registry.ts:37` — register `networkObserveTool`, `networkVerifyTool`, `networkMockTool`
- `bridge/src/mcp_tools.rs` — add MCP tool schemas for network interception tools

## 2. MCP tool schema & arch flow

**New tools**:
```typescript
observe_network(url_pattern?: string, duration_ms?: number): request_id[]
verify_request(url_pattern: string, timeout_ms?: number): {found: boolean, method: string, headers: object, body?: string}
verify_response(url_pattern: string, expected_status?: number): {matched: boolean, status: number, body: string, latency_ms: number}
mock_response(url_pattern: string, status: number, body: string, headers?: object): mock_id
```

**Architecture flow**:
1. **Enable interception**: CDP `Fetch.enable` with URL patterns → all matching requests fire `Fetch.requestPaused` events
2. **Request buffering**: Service worker listens to `Fetch.requestPaused` + `Network.responseReceived` → stores {url, method, status, headers, body} in orchestrator per-tab buffer (ring buffer, max 100 entries)
3. **Verification**: Tool queries buffer by URL pattern → returns matching request/response or waits (with timeout) for next match
4. **Mocking**: On `Fetch.requestPaused`, check mock registry → if URL matches, call `Fetch.fulfillRequest` with synthetic response; else `Fetch.continueRequest`

## 3. Security implications

- **Credential leakage**: Network logs capture Authorization headers, cookies, API keys in requests. Mitigation: (a) redact `Authorization`, `Cookie`, `X-API-Key` headers before returning to LLM; (b) require HITL confirmation to disable redaction for debugging.
- **Response tampering**: `mock_response` can inject arbitrary data into page context, potentially XSS or auth bypass. Mitigation: (a) mark mocked responses in network log; (b) HITL confirmation required for any mock affecting authentication endpoints (login, token refresh).
- **CORS bypass**: CDP interception operates before CORS checks, could leak cross-origin responses. Mitigation: respect same-origin policy in tool responses — only return full response body for same-origin requests unless user explicitly allows cross-origin.
- **Performance impact**: Network interception adds latency (~5-20ms per request). Disable by default; enable only when network tools invoked; auto-disable after 60s idle or on tab navigation.
- **Request ID collision**: CDP requestId is tab-scoped. Network buffer must key by `(tabId, requestId)` to avoid cross-tab confusion.
