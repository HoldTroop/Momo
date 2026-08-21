## Variant: Flow-centric

### Design stance
Primary execution paths only — emphasize the WebSocket connection and policy chain while dimming utility connections.

### Key choices
- **Layout:** Mermaid graph LR (left-to-right flow)
- **Typography:** ui-monospace, 11-13px, minimal weight variation
- **Color:** Monochrome (#0a0a0a bg) + single accent (#ff6b35 for primary flow)
- **Interaction:** Mermaid hover states, legend for connection types

### Trade-offs
- **Strong at:** Showing the critical path (sidepanel → sw → bridge → policy)
- **Weak at:** Showing file-level detail, library relationships, state management

### Best for
Quick understanding of "how does a user action reach the LLM and get authorized?"