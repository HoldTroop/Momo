## Variant: Topology map

### Design stance
Enterprise network topology aesthetic — nodes positioned spatially with bezier curves, minimal chrome, D3.js force simulation style.

### Key choices
- **Layout:** Custom SVG with D3.js, spatial clustering (Browser / Bridge layers)
- **Typography:** ui-monospace 10-11px, node labels with sub-labels
- **Color:** Pure dark (#0a0a0a) with subtle borders (#333), orange accent for bridge layer
- **Interaction:** Node hover highlights, hub nodes (larger circles)

### Trade-offs
- **Strong at:** Clean, professional aesthetic; spatial relationships; hub identification
- **Weak at:** Static positioning (no force simulation), less information density

### Best for
High-level overview presentations, stakeholder reviews, documentation covers