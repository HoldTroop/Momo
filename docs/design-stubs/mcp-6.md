# Design Stub: mcp-6 — capture_viewport Tool

**Issue**: Fifth MCP tool (`capture_viewport` for screenshot + VLM analysis) absent from tool registry (only 10/11 tools present).

## 1. Files to Modify

- **src/lib/tools/capture-viewport.ts** — new file, tool implementation
- **src/lib/tool-registry.ts:15-120** — register `capture_viewport` in schema
- **bridge/src/mcp_tools.rs:45-300** — add Rust MCP handler `handle_capture_viewport`
- **bridge/src/mcp_stdio.rs:60-80** — wire tool into protocol dispatch
- **src/types/tools.ts** — add `CaptureViewportParams` and `CaptureViewportResult` types

## 2. MCP Tool Schema & Architecture Flow

```typescript
interface CaptureViewportParams {
  prompt?: string;          // Optional VLM question (default: "Describe this page")
  viewport?: { x, y, w, h }; // Optional region (default: full viewport)
  include_raw?: boolean;     // Return base64 screenshot alongside analysis
}
```

**Flow**: MCP client → TypeScript handler → CDP `Page.captureScreenshot` → VLM API (Claude Vision) → structured response → MCP client

## 3. Security Implications

- **PII leakage**: Screenshots expose passwords, financial data, health records → requires HIGH-risk confirmation gate
- **External data exposure**: Screenshot sent to VLM API (Anthropic/external service) → user consent mandatory
- **Prompt injection**: VLM `prompt` parameter is untrusted input → sanitize/validate before API call
- **Rate limiting**: VLM calls are expensive → enforce per-session quota (suggest 10/hour)
- **Storage**: Do NOT persist screenshots to disk/WAL (ephemeral only) unless user explicitly enables session recording
- **Confirmation policy**: Override to `always` for any page with `input[type=password]` or financial domains
