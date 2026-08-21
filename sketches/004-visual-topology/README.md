## Variant: Visual Topology

### Design stance
Enterprise visual topology map with D3.js force simulation, real spatial layout, and striking aesthetics.

### Key choices
- **Layout:** D3.js force-directed graph with fixed anchor points (stratified layers)
- **Typography:** ui-monospace, node labels with sublabels
- **Color:** Deep dark (#121212) + glowing orange (#ff6b35) for primary flow + blue (#4a9eff) for data
- **Interaction:** Pan/zoom, node hover with lift effect, animated pulse on primary edges

### Key features
- ✅ **Real spatial layout** - horizontal spread, not vertical stack
- ✅ **Smooth bezier curves** - quadratic paths, not text arrows
- ✅ **Glowing effects** - drop-shadow filters on hubs and primary edges
- ✅ **Animated pulse** - WebSocket edges animate to show active flow
- ✅ **Hub emphasis** - larger circles (60px) for src/sw, bridge/src/ws_server, policy
- ✅ **Pan/zoom** - full interactive canvas control

### Trade-offs
- ✅ **Strong:** Visually striking, spatial relationships clear, hub nodes emphasized
- ⚠️ **Moderate:** Requires D3.js (180KB), more complex than static diagrams

### Best for
Modern enterprise dashboards, architecture presentations where visual impact matters