# Design Stub: actions-4 — Tab Switching Tool

**Issue**: No `switch_to_tab`/`activate_tab`; only `list_tabs` (message-router.ts + mcp_tools.rs)  
**Classification**: code | OPEN

## 1. Files to Modify

- **NEW** `src/lib/tools/switch-tab.ts` — Core tab-switching logic (validate tabId, activate via chrome.tabs API)
- **MODIFY** `src/lib/tool-registry.ts:L40-50` — Register `switch_to_tab` tool
- **MODIFY** `bridge/src/mcp_tools.rs:L180-200` — Add `switch_to_tab` MCP tool handler (adjacent to existing `list_tabs`)
- **MODIFY** `src/sw/message-router.ts:L140-160` — Route `switch_to_tab` action to background (not content script)
- **MODIFY** `src/sw/orchestrator.ts:L300-320` — Update active `context.tabId` after successful switch

## 2. MCP Tool Schema

```rust
switch_to_tab {
  tab_id: number              // Chrome tab ID from list_tabs result
}
```

**Flow**: MCP → Bridge → Extension background → `chrome.tabs.update(tabId, {active: true})` + `chrome.windows.update(windowId, {focused: true})` → Update orchestrator context → Return success/error

**Response**: `{ switched: true, tab_id: number, title: string, url: string }`

## 3. Security Implications

- **Context switching risk**: MODERATE — Changes active tab/window, breaking orchestrator invariant (single-tab assumption)
- **Tab ID validation**: Must verify `tabId` exists and is controlled by extension (not arbitrary tab injection)
- **Window focus race**: `chrome.windows.update` may fail if window minimized/closed; requires error handling
- **Perception staleness**: After switch, cached perception for old tab is invalid; must trigger fresh `perceive_page`
- **Multi-tab coordination**: Exposes underlying issue (quality-3, roadmap-2) — orchestrator assumes `frameId:0` single-context model
- **Confirmation policy**: `confirmation_policy: "sensitive"` — switching tabs can navigate away from important work
