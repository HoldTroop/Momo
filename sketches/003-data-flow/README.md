## Variant: Data flow

### Design stance
Vertical execution sequence — trace a request from UI click through policy gate to persistence, with inline annotations.

### Key choices
- **Layout:** Vertical stack with layer labels, left-aligned flow
- **Typography:** Monospace 10-11px, inline annotations (12px padding)
- **Color:** Dark (#0a0a0a) + orange primary nodes, blue data nodes
- **Interaction:** Node hover lift, stats grid at bottom

### Trade-offs
- **Strong at:** Sequential understanding, showing line counts and file names, education/onboarding
- **Weak at:** Spatial relationships, doesn't show parallel paths (e.g., MCP vs internal orchestration)

### Best for
Developer onboarding, README diagrams, explaining "what happens when I click X"