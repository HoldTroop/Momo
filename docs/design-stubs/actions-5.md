# Design Stub: actions-5 — Iframe Targeting

## Files to Modify

1. **`src/lib/tools/click.ts:97`** — Replace `allFrames:false` with dynamic frame resolution
2. **`src/lib/tools/type.ts`** — Add iframe support to text input
3. **`src/lib/tools/hover.ts`** — Enable hover in nested frames
4. **`src/lib/tools/scroll.ts`** — Support scrolling within iframes
5. **`src/content/perception.ts`** — Extend element tree walker to traverse iframe boundaries
6. **`bridge/src/mcp_tools.rs`** — Add `target_frame` parameter to action tools
7. **`src/sw/message-router.ts`** — Frame context tracking and routing logic
8. **11 additional tool files** — Audit shows 14 total sites with hardcoded `allFrames:false`

## MCP Tool Schema & Architecture Flow

**New parameter**: `frame_id?: number | "auto"` on all action tools (`click`, `type`, `hover`, `scroll`, etc.)

**Flow**:
1. Perception phase: `createTreeWalker` traverses `<iframe>`/`<frame>` elements, queries each frame's document via `chrome.scripting.executeScript({allFrames:true})`
2. Element references include `frameId` in metadata: `{ref: "el_42", frameId: 0x1A2B3C4D, ...}`
3. Action dispatch: CDP commands target `frameId` explicitly via `Runtime.evaluate({executionContextId})` or `DOM.querySelector` per frame
4. **Auto-targeting**: If `frame_id:"auto"`, match element ref to stored frameId from perception

## Security Implications

- **Cross-origin iframes**: Cannot access or manipulate cross-origin iframe content (browser security model); tool must fail gracefully with clear error
- **Sandboxed iframes**: `<iframe sandbox>` restricts script execution; actions may be blocked by CSP/sandbox flags
- **Frame injection attacks**: Malicious pages with deeply nested iframes could exhaust perception resources; need depth limit (e.g., 3 levels)
- **Clickjacking vector**: Enabling iframe interaction means agent can interact with invisible/overlay frames; risk classification should flag iframe targets as `MEDIUM` or `HIGH`
- **Mitigation**: Frame depth limit, visibility check (frame must be in viewport), explicit confirmation for cross-origin frame attempts
