# Design Stub: actions-8 — Shadow-DOM Penetration

**Item**: actions-8  
**Status**: OPEN  
**Current**: `createTreeWalker(document.body)` + `querySelector` skip shadow roots  
**Reference**: src/content/perception.ts:43-46

## 1. Files to Modify

- **src/content/perception.ts:43-57** — Replace flat `createTreeWalker` with recursive shadow-piercing traversal
- **src/lib/selector.ts** — Add shadow-path encoding (e.g., `host::shadow >> inner-selector`)
- **src/lib/tools/click.ts:154** — Replace `querySelectorAll` with shadow-piercing query
- **src/lib/tools/type.ts:157** — Replace `querySelectorAll` with shadow-piercing query
- **src/lib/tools/extract.ts:40,64** — Replace `executeScript` queries with shadow-aware version
- **src/lib/tools/shared.ts** — Add `querySelectorDeep(root, selector)` utility for shadow traversal

## 2. Architecture Flow

1. **Perception Phase**: Walker recursively descends into `el.shadowRoot` (open only; closed roots are inaccessible by design). Generate ref_ids and selectors that encode shadow boundaries (e.g., `#payment-widget::shadow >> button.submit`).
2. **Selector Resolution**: New `querySelectorDeep()` splits on `::shadow >>` delimiter, traverses each shadow boundary, then queries within final context.
3. **Tool Execution**: All tools (click, type, extract) call `querySelectorDeep()` instead of native `querySelector`.

## 3. Security Implications

- **Encapsulation bypass**: Shadow DOM intentionally hides internals; crossing boundaries may expose private implementation details or bypass API contracts.
- **Closed shadow roots**: Must gracefully skip; attempting access throws or returns null.
- **Sensitive widgets**: Payment forms, password managers, and auth widgets often use shadow DOM for isolation. Actions inside these require elevated confirmation (set `riskClass: 'dangerous'`).
- **Audit trail**: Log shadow-boundary crossings in `reportActionResult()` for post-hoc review.
- **Selector stability**: Shadow-internal selectors are fragile (no author-controlled IDs/classes). Prefer ref_id targeting where available.
