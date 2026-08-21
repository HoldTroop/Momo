# Momo Architecture Visualizations

Interactive HTML/SVG diagrams showing how Momo's autonomous browser agent works under the hood.

## Quick Start

Open [index.html](index.html) in your browser to access the visualization gallery, or jump directly to any diagram:

1. **[Overall Architecture](overview.html)** - Complete system topology showing the 5 layers: Extension UI, Service Worker, Content Scripts, Rust Bridge, and Browser Runtime
2. **[Communication Layers](communication-layers.html)** - Deep dive into the 4 messaging protocols: chrome.runtime, WebSocket, CDP, and MCP
3. **[WebSocket Patterns](websocket-patterns.html)** - RPC, pub/sub, and command-channel flows over the extension↔bridge WebSocket
4. **[Tool Execution Flow](tool-execution-flow.html)** - Security-gated execution pipeline from MCP tool call to browser action (9 steps)
5. **[Perception System](perception-system.html)** - How Momo "sees" web pages: AX tree extraction, DOM observation, element references, and redaction
6. **[Security Architecture](security-architecture.html)** - Trust boundaries, policy engine, and the fail-closed authorization model
7. **[Operating Modes](operating-modes.html)** - Mode A (autonomous orchestration) vs Mode B (MCP client control)

## Features

- **Interactive** - Hover over components for detailed tooltips with code references
- **Filterable** - Focus on specific layers, patterns, or modes using the control buttons
- **Self-contained** - No external dependencies; all CSS and JavaScript inline
- **Theme-aware** - Respects system light/dark mode preferences
- **Responsive** - Scales to different screen sizes

## Design System

All diagrams follow a consistent design language:

- **Purple (#8B5CF6)** - Extension components
- **Blue (#3B82F6)** - Bridge components
- **Amber (#F59E0B)** - Policy, external interfaces, and trust boundaries
- **Green (#10B981)** - Browser runtime and trusted execution
- **Red (#EF4444)** - Untrusted zones and security concerns

### Visual Patterns

- **Solid borders** - Active components
- **Dashed borders** - Logical groupings or zones
- **Solid arrows** - Synchronous calls or direct messaging
- **Dashed arrows** - Asynchronous events or data flows
- **Animated lines** - Active WebSocket connections

## Technical Details

### File Structure

```
docs/architecture/
├── index.html                    # Navigation hub
├── overview.html                 # Overall architecture
├── communication-layers.html     # Messaging protocols
├── websocket-patterns.html       # WebSocket flows
├── tool-execution-flow.html      # Execution pipeline
├── perception-system.html        # Perception layer
├── security-architecture.html    # Trust boundaries
├── operating-modes.html          # Mode A vs Mode B
└── assets/
    └── styles.css               # Shared design system
```

### Technology Stack

- **SVG** for vector graphics (inline, not external files)
- **Vanilla JavaScript** for interactivity (no frameworks)
- **CSS variables** for theming
- **CSS Grid/Flexbox** for layout

### Browser Compatibility

Tested in:
- Chrome 120+
- Firefox 120+
- Safari 17+
- Edge 120+

### Accessibility

- Semantic HTML structure
- ARIA labels on interactive elements
- Keyboard navigation support
- High contrast ratios (WCAG AA)

## Editing Diagrams

All diagrams are hand-crafted SVG with inline coordinates. To edit:

1. Open the HTML file in your editor
2. Locate the `<svg>` element
3. Modify coordinates, colors, or text
4. Refresh browser to preview

**Coordinate System**: The SVG viewBox uses a 1400×1000 (or 1400×1100) coordinate system. Components are positioned absolutely within this space.

**Adding Tooltips**: Add `data-component="unique-id"` to any SVG element, then add an entry to the `componentData` object in the `<script>` section.

## Relationship to Mermaid Diagrams

The parent [ARCHITECTURE.md](../ARCHITECTURE.md) contains Mermaid diagrams that provide:
- Quick inline reference in Markdown
- GitHub preview compatibility
- Easy text-based editing

These HTML visualizations provide:
- Rich interactivity (tooltips, filtering)
- Professional presentation
- Detailed annotations
- Better visual design

Both serve complementary purposes and are kept in sync.

## Contributing

When updating the architecture:

1. **Update implementation first** - Code is the source of truth
2. **Update Mermaid diagrams** in ARCHITECTURE.md for inline reference
3. **Update these visualizations** for detailed, interactive view
4. **Keep them in sync** - All three should tell the same story

## License

Same as Momo project (see root LICENSE file).

## Questions?

See the main [ARCHITECTURE.md](../ARCHITECTURE.md) for higher-level architectural decisions and the "What's Not Shown" section for deliberately omitted details.
