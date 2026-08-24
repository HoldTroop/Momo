# actions-6: Visual verification (screenshot comparison / OCR)

**Issue**: No screenshot capture, image comparison, or OCR tools — agent cannot verify visual state changes or read text from images/canvas.

## 1. Files to modify

- **New file**: `src/lib/tools/screenshot.ts` — `capture_screenshot` tool using `chrome.tabs.captureVisibleTab()` or CDP `Page.captureScreenshot`
- **New file**: `src/lib/tools/visual-verify.ts` — `verify_visual_change` tool comparing before/after screenshots via perceptual hash (pHash) or SSIM
- **New file**: `src/lib/ocr/tesseract-worker.ts` — Tesseract.js wrapper for OCR extraction from screenshot regions
- **New file**: `src/lib/tools/read-image-text.ts` — `read_image_text` tool exposing OCR to MCP client
- `src/lib/tool-registry.ts:37` — register new tools: `screenshotTool`, `visualVerifyTool`, `readImageTextTool`
- `src/sw/cdp-adapter.ts` — add `captureScreenshot(tabId, clip?: {x,y,width,height})` method wrapping CDP `Page.captureScreenshot`
- `bridge/src/mcp_tools.rs` — add MCP tool schemas for screenshot/verify/OCR tools

## 2. MCP tool schema & arch flow

**New tools**:
```typescript
capture_screenshot(region?: {x,y,width,height}): base64_png
verify_visual_change(before_ref: string, threshold?: number): {changed: boolean, similarity: number, diff_regions?: Box[]}
read_image_text(region?: {x,y,width,height}, lang?: string): {text: string, confidence: number, words: Word[]}
```

**Architecture flow**:
1. **Screenshot capture**: `chrome.tabs.captureVisibleTab()` for visible viewport (fast, no CDP); CDP `Page.captureScreenshot` for full-page or clipped region
2. **Comparison**: Store screenshot in orchestrator state with ref_id → on `verify_visual_change`, compute perceptual hash difference (Hamming distance) or pixel-level SSIM
3. **OCR**: Load Tesseract.js worker in service worker context → process screenshot region → return structured text + bounding boxes
4. **Caching**: Store screenshot refs in IndexedDB (blob storage) with TTL to avoid re-capture for repeated verifications

## 3. Security implications

- **Data exfiltration risk**: Screenshots may contain PII, credentials, session tokens visible on screen. Mitigation: (a) require HITL confirmation for screenshot tools if `sensitive_data_visible` heuristic fires (password fields, credit card inputs in viewport); (b) never persist screenshots beyond session lifetime; (c) log all screenshot captures in audit trail.
- **OCR credential extraction**: Agent could read visible passwords/API keys from UI. Mitigation: same HITL gate as screenshots; redact OCR results matching credential patterns before returning to LLM.
- **Side-channel timing**: Screenshot comparison timing reveals page state (visual diff takes longer). Not exploitable in single-tenant extension context.
- **Tesseract.js bundle size**: ~2MB (gzipped). Load lazily on first OCR call, not at extension startup.
- **CDP screenshot permission**: Requires `debugger` permission (already granted). `chrome.tabs.captureVisibleTab` requires `activeTab` (already granted).
