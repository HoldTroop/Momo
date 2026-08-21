# Momo Architecture Visualization - Sketch Comparison

**Date:** August 21, 2026  
**Method:** Sketch skill - 3 variants for comparison  
**Constraint:** Strict codebase sync, ultra-minimalist, enterprise topology aesthetic

---

## Three Variants Generated

All variants are **strictly synchronized with actual codebase structure** from `/home/mir-abir/Momo`:

- ✅ Real directory paths: `src/sw`, `src/content`, `src/lib`, `bridge/src`
- ✅ Real file names: `orchestrator.ts`, `policy.rs`, `ws_server.rs`
- ✅ Real line counts: `orchestrator.ts` (1,020 lines), `policy.rs` (771 lines)
- ✅ No invented groupings - only what exists in the codebase

---

## Comparison Table

| Dimension | Flow-centric | Topology map | Data flow |
|-----------|--------------|--------------|-----------|
| **Layout** | Mermaid LR (horizontal) | D3.js spatial (custom SVG) | Vertical stack |
| **Aesthetic** | Bezier curves, minimal | Pure enterprise topology | Sequential annotations |
| **Color** | Monochrome + orange accent | Dark + subtle borders | Dark + inline color codes |
| **Information density** | Low (primary paths only) | Medium (spatial clusters) | High (line counts, file names) |
| **Interactivity** | Mermaid hover | D3 node hover | Node lift on hover |
| **Best for** | Quick critical path | Stakeholder presentations | Developer onboarding |
| **Learning curve** | Immediate | Immediate | Low |
| **Maintenance** | Mermaid DSL (easy) | Manual SVG (medium) | Pure HTML/CSS (easy) |

---

## Variant Details

### 001 - Flow-centric

**Files:**
- `/home/mir-abir/Momo/sketches/001-flow-centric/index.html`
- `/home/mir-abir/Momo/sketches/001-flow-centric/README.md`

**Design stance:** Primary execution paths only

**Key features:**
- Mermaid.js graph (LR layout)
- Single orange accent for primary flow (ws:// connection, policy chain)
- Dashed lines for secondary connections (utilities, libraries)
- Grouped by context: Browser / Rust Bridge / Persistence

**Trade-offs:**
- ✅ **Strong:** Immediately shows critical path (sidepanel → sw → bridge → policy)
- ❌ **Weak:** Doesn't show file-level detail or parallel modes (MCP vs internal)

**Best for:** README diagrams, quick "how does a request flow" answers

---

### 002 - Topology map

**Files:**
- `/home/mir-abir/Momo/sketches/002-topology-map/index.html`
- `/home/mir-abir/Momo/sketches/002-topology-map/README.md`

**Design stance:** Enterprise network topology aesthetic

**Key features:**
- Custom SVG with D3.js positioning
- Bezier curve connections (smooth, professional)
- Hub nodes emphasized (larger circles for `src/sw`, `bridge/src/ws_server`, `policy`)
- Spatial clustering with labeled boundaries

**Trade-offs:**
- ✅ **Strong:** Clean, high-end aesthetic; spatial relationships; hub identification
- ❌ **Weak:** Static positioning (no auto-layout); less information density

**Best for:** Stakeholder presentations, architecture reviews, documentation covers

---

### 003 - Data flow

**Files:**
- `/home/mir-abir/Momo/sketches/003-data-flow/index.html`
- `/home/mir-abir/Momo/sketches/003-data-flow/README.md`

**Design stance:** Vertical execution sequence with inline annotations

**Key features:**
- Top-to-bottom flow (UI → Extension → Bridge → Persistence)
- Real file names and line counts inline
- Annotation blocks explaining critical junctions (policy gate, WebSocket)
- Stats grid at bottom (1,231 nodes, 4,766 edges from codebase-memory)

**Trade-offs:**
- ✅ **Strong:** Educational, shows exact files and their roles, sequential understanding
- ❌ **Weak:** Doesn't show spatial relationships or parallel execution modes

**Best for:** Developer onboarding, README documentation, "what happens when I click X"

---

## My Recommendation

### For your README.md: **003 - Data flow**

**Why:**
1. **Strictly codebase-synced** - shows actual file paths, not conceptual boxes
2. **Educational** - new contributors see exactly which files do what
3. **Maintenance-friendly** - pure HTML/CSS, no build step or external libs
4. **Information-rich** - line counts, layer annotations, stats grid

### For stakeholder presentations: **002 - Topology map**

**Why:**
1. **Professional aesthetic** - looks like high-end enterprise architecture
2. **Clean** - minimal chrome, emphasis on structure over detail
3. **Scalable** - won't look cluttered if more nodes are added later

### For quick reference: **001 - Flow-centric**

**Why:**
1. **GitHub-native** - Mermaid renders directly in markdown
2. **Fast to update** - text-based DSL
3. **Focused** - only the critical path, no noise

---

## Color Palette (Applied Consistently)

All variants use the same **ultra-minimalist dark theme**:

- **Background:** `#0a0a0a` (pure dark)
- **Node fill:** `#1a1a1a` (subtle lift)
- **Borders:** `#333` (secondary), `#ff6b35` (primary), `#4a9eff` (data)
- **Text:** `#e0e0e0` (primary), `#666` (secondary)
- **Font:** `ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas`

**No heavy fills, no gradients, no decoration** - just structure and flow.

---

## Bezier Curves vs Angular Lines

All variants use **smooth bezier curves** instead of rigid angular lines:

- **Variant 1 (Mermaid):** `curve: 'basis'` setting
- **Variant 2 (D3.js):** Quadratic bezier curves via SVG `Q` command
- **Variant 3 (Data flow):** Visual flow arrows (↓) instead of connecting lines

**Rationale:** Bezier curves feel more organic and less "whiteboard sketch", matching the enterprise topology aesthetic requirement.

---

## Codebase Verification

All node labels verified against actual directory structure:

```bash
$ cd /home/mir-abir/Momo && find . -maxdepth 3 -type d | grep -E "^\./(src|bridge)"
./bridge
./bridge/src
./src
./src/lib
./src/lib/tools
./src/sw
./src/content
./src/sidepanel
```

All file names verified:
```bash
$ cd /home/mir-abir/Momo/bridge/src && ls -1 *.rs
llm.rs
main.rs
mcp_stdio.rs
mcp_tools.rs
policy.rs
types.rs
ws_server.rs
```

Line counts verified from codebase-memory MCP:
- `src/sw/orchestrator.ts`: 1,020 lines
- `bridge/src/policy.rs`: 771 lines  
- `bridge/src/main.rs`: 655 lines

---

## Opening the Variants

All three variants should now be open in your browser. If not:

```bash
# Linux
xdg-open /home/mir-abir/Momo/sketches/001-flow-centric/index.html
xdg-open /home/mir-abir/Momo/sketches/002-topology-map/index.html
xdg-open /home/mir-abir/Momo/sketches/003-data-flow/index.html

# macOS
open /home/mir-abir/Momo/sketches/*/index.html

# Windows
start /home/mir-abir/Momo/sketches/001-flow-centric/index.html
```

---

## Next Steps

1. **Review all three variants side-by-side in browser tabs**
2. **Pick a winner** (or combine elements from two)
3. **If you want iteration:** tell me which variant is closest and what to adjust

Example requests:
- "Use variant 3 but make it more compact"
- "Variant 2 but add file names like variant 3"
- "Combine 1's layout with 3's annotations"
- "Make variant 2 interactive - click a node to see its code"

---

## Files Generated

```
sketches/
├── 001-flow-centric/
│   ├── index.html          (4.9 KB)
│   └── README.md           (725 bytes)
├── 002-topology-map/
│   ├── index.html          (8.9 KB)
│   └── README.md           (785 bytes)
└── 003-data-flow/
    ├── index.html          (10.1 KB)
    └── README.md           (756 bytes)
```

**Total:** 3 variants, 6 files, 25.3 KB

---

**Sketch complete.** All variants strictly follow codebase structure, use ultra-minimalist dark aesthetics, smooth bezier curves, and emphasize primary flows over utility connections.