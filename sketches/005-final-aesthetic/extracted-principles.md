# Design Principles Extracted from 5 Reference Images

## Common Patterns Across All Images

### Layout Strategy
- **Hierarchical flow** (top-to-bottom or left-to-right)
- **Swim lanes** for logical separation
- **Center-weighted composition** with symmetrical balance
- **Generous whitespace** between elements
- **Layered depth** (foreground/background separation)

### Color Palette (Dark Theme)
**Backgrounds:**
- Deep charcoal/black: #1a1a1a to #2d2d2d
- Subtle gradients for depth

**Node Colors:**
- Primary nodes: Dark fills (#2a2a2a to #3a3a3a)
- Accent/highlight: Orange/amber (#ff6b35, #e67e22, #f39c12)
- Data/storage: Blue (#4a9eff, #3498db)
- Success: Green (#2ecc71)
- Error/warning: Red/orange (#e74c3c)

**Borders:**
- Subtle borders: #444 to #555
- Highlighted borders: Match accent colors with glow

**Text:**
- Primary: #e0e0e0 to #ffffff
- Secondary/labels: #888 to #999
- Muted: #666

### Node Styling
- **Shape**: Rounded rectangles (border-radius: 8-12px)
- **Borders**: 1-2px solid with subtle glow on important nodes
- **Fills**: Solid dark with optional subtle gradient
- **Shadows**: Soft drop-shadow (0 2px 8px rgba(0,0,0,0.3))
- **Padding**: 16-24px internal padding
- **Size variation**: Larger nodes for hubs (1.3-1.5x base size)

### Edge/Connection Styling
- **Curve type**: Smooth bezier curves or straight orthogonal (Manhattan routing)
- **Thickness**: 2-3px for primary, 1-1.5px for secondary
- **Colors**: Match source/target type (orange primary, blue data, grey utility)
- **Arrows**: Filled triangular arrowheads
- **Dash patterns**: Dashed (4,4) for secondary/optional connections
- **Glows**: Subtle glow on primary paths (drop-shadow: 0 0 6px color)
- **Animation**: Optional pulse or flow animation on active connections

### Typography
- **Font family**: Sans-serif (Inter, -apple-system, system-ui)
- **Title**: 14-16px, weight 600, letter-spacing -0.01em
- **Node labels**: 12-13px, weight 500
- **Sublabels**: 10-11px, weight 400, color #888
- **Annotations**: 9-10px, color #666

### Visual Hierarchy
**Hub emphasis techniques:**
- Larger size (1.3-1.5x)
- Brighter border colors
- Soft glow effect
- Positioned centrally in flow

**Layering:**
- Background layer: grid/pattern (optional)
- Connection layer: edges
- Node layer: boxes/shapes
- Text layer: labels on top
- Annotation layer: explanatory text

### Unique Aesthetic Elements
- **Subtle grid pattern** on background (optional)
- **Numbered sequence markers** for step-by-step flows
- **Color-coded swim lanes** with subtle background tints
- **Icon integration** (small icons in node headers)
- **Status indicators** (dots, badges on nodes)
- **Soft glows** on hover states
- **Minimal but purposeful** - every element serves function

---

## Application to Momo Architecture

### Node Mapping:
- **Hub nodes** (src/sw, bridge/ws_server, policy): Larger, orange borders, glow
- **Browser nodes** (sidepanel, content): Medium, grey borders
- **Bridge nodes** (llm.rs, mcp): Medium, subtle orange tint
- **Data nodes** (IndexedDB, SQLite): Blue borders, database icon
- **Utility nodes** (src/lib): Small, minimal styling

### Connection Mapping:
- **Primary flow** (UI → sw → bridge → policy): Thick orange with glow, animated
- **Data persistence**: Blue with subtle glow
- **Tool calls**: Grey dashed, thin
- **WebSocket**: Orange with "ws://:9090" label, pulse animation

### Layout:
- Layered horizontal spread (Browser | Bridge | Data)
- Vertical swim lanes for logical separation
- Generous spacing (150-200px between layers)
- Center-weighted with policy/llm as focal point

