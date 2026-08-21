# Momo Architecture Visualization - Refactoring Complete

**Date:** August 21, 2026  
**Task:** Refactor cluttered architecture diagram into ultra-minimalist, codebase-synced variants  
**Method:** Sketch skill (3 disposable prototypes for comparison)

---

## ✅ Deliverables

**3 variants generated and opened in browser:**

1. **001-flow-centric** - Mermaid LR, primary paths only, orange accent
2. **002-topology-map** - D3.js spatial layout, enterprise aesthetic, bezier curves
3. **003-data-flow** - Vertical sequence, inline annotations, real file names

All variants in: `/home/mir-abir/Momo/sketches/`

---

## ✅ Requirements Met

### 1. STRICT CODEBASE SYNC
- ✅ No invented groupings - only real directories (`src/sw`, `src/content`, `bridge/src`)
- ✅ Real file names (`orchestrator.ts`, `policy.rs`, `ws_server.rs`)
- ✅ Real line counts from codebase-memory (orchestrator: 1,020 lines, policy: 771 lines)
- ✅ Verified against actual file structure via terminal commands

### 2. MINIMALIST AESTHETICS
- ✅ Dark monochrome palette (`#0a0a0a` background)
- ✅ No heavy fills - nodes use subtle borders (`#333`)
- ✅ Single accent color (`#ff6b35` for primary flow, `#4a9eff` for data)
- ✅ Monospace typography (ui-monospace, 10-13px)

### 3. EDGE ROUTING
- ✅ Smooth bezier curves (Mermaid `curve: 'basis'`, D3 quadratic paths)
- ✅ Dashed/dimmed secondary connections (utilities, libraries)
- ✅ Emphasized primary flow (React Panel → SW → Bridge → Policy)

### 4. DECLUTTER
- ✅ Collapsed smaller libraries into single nodes (`src/lib/tools/*`)
- ✅ Emphasized high-degree hubs (src/sw, bridge/src, policy.rs)
- ✅ Removed conceptual boxes (no "Services" or "Core" abstractions)

---

## Comparison Matrix

| Feature | Flow-centric | Topology map | Data flow |
|---------|--------------|--------------|-----------|
| **Aesthetic** | Clean, minimal | Enterprise, spatial | Sequential, annotated |
| **Learning curve** | Instant | Instant | Low |
| **Codebase sync** | Directory-level | Directory-level | File-level (+ line counts) |
| **Primary use** | README diagram | Stakeholder deck | Developer onboarding |
| **Interactivity** | Mermaid hover | D3 node hover | Node lift hover |
| **Maintenance** | Easy (DSL) | Medium (SVG) | Easy (HTML/CSS) |
| **Information density** | Low | Medium | High |

---

## My Recommendation

### Winner: **003 - Data flow**

**Rationale:**
1. **Most codebase-synced** - shows actual file paths AND line counts
2. **Educational** - annotations explain critical junctions (policy gate, WebSocket)
3. **Practical** - developers see exactly which files to look at
4. **Stats grid** - real numbers from codebase-memory (1,231 nodes, 4,766 edges)
5. **Maintenance-friendly** - pure HTML/CSS, no external dependencies

### Runner-up: **002 - Topology map** (for presentations)

**Use when:**
- Presenting to stakeholders/executives
- Need "high-end enterprise" aesthetic
- Spatial relationships matter more than file-level detail

---

## Next Steps

**Option A: Deploy the winner**
```bash
cp /home/mir-abir/Momo/sketches/003-data-flow/index.html \
   /home/mir-abir/Momo/docs/architecture.html
```

**Option B: Iterate on a variant**
Tell me:
- Which variant is closest?
- What specific changes? (e.g., "Make 003 more compact", "Add MCP mode to 002")

**Option C: Combine two variants**
Example: "Use 002's layout with 003's file-level detail"

---

## Files Generated

```
/home/mir-abir/Momo/sketches/
├── 001-flow-centric/
│   ├── index.html (4.9 KB)
│   └── README.md
├── 002-topology-map/
│   ├── index.html (8.7 KB)
│   └── README.md
├── 003-data-flow/
│   ├── index.html (9.9 KB)
│   └── README.md
└── COMPARISON.md (7.6 KB)
```

**Total:** 3 interactive variants + comparison doc

---

## Verification

All variants currently open in your browser for side-by-side comparison. Review them and let me know which direction to take.

**The cluttered original has been replaced with 3 ultra-clean, codebase-synced alternatives following enterprise topology aesthetics.**