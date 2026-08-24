# quality-3: Multi-Frame Coordination

**Issue**: Single `frameId:0`, `allFrames:false` everywhere — cannot target iframes or coordinate across frames.

## Files to Modify

1. **src/sw/orchestrator.ts** (lines 586, 610, 634, 873, 886)
   - Replace hardcoded `frameId: 0` with dynamic frame selection
   - Add frame enumeration and tracking to orchestrator state
   
2. **src/content/perception.ts** (lines 43-46)
   - Extend `createTreeWalker` to recursively traverse `window.frames[]`
   - Collect frame metadata (id, src, name, origin, depth) for each accessible frame
   
3. **src/lib/tools/*.ts** (click.ts, type.ts, scroll.ts, hover.ts, press-enter.ts)
   - Add optional `frame_id?: number` parameter to all action tool schemas
   - Default to main frame (0) when omitted
   
4. **src/sw/message-router.ts**
   - Extend message dispatch to resolve and validate frame IDs
   - Handle frame-targeted `chrome.tabs.sendMessage` with `frameId` option
   
5. **bridge/src/mcp_tools.rs**
   - Add `frame_id` (optional integer) to action tool JSON schemas
   - Add new tools: `list_frames()` → frame metadata array, `switch_frame(frame_id)` → set active context

## Architecture Flow

1. **Perception**: `getPerception()` recursively walks `window.frames[]`, injecting content script into each same-origin frame via `chrome.scripting.executeScript({target: {tabId, allFrames: true}})`
2. **Frame registry**: Orchestrator maintains `Map<frameId, {origin, depth, parent}>` refreshed on each perception cycle
3. **Action dispatch**: Tools resolve `frame_id` parameter, validate against registry, then inject script into target frame
4. **Cross-origin handling**: Cross-origin frames listed in perception but marked inaccessible; actions rejected with clear error

## Security Implications

1. **Same-origin policy**: Cross-origin iframe content remains inaccessible (browser-enforced); only same-origin frames are actionable
2. **Frame ID spoofing**: Validate frame IDs exist in current registry before dispatch; reject stale/invalid IDs
3. **Permission escalation**: Malicious iframe cannot target parent/sibling frames (registry is orchestrator-controlled, not iframe-supplied)
4. **Sandboxed iframes**: Frames with `sandbox` attribute may block script injection; mark as inaccessible in perception
5. **Origin verification**: Each action logs target frame origin; HITL confirmation modal includes frame context
6. **Frame lifecycle**: Handle frame destruction gracefully (registry purged on navigation); return actionable error if frame no longer exists
