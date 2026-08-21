# Momo Documentation

Comprehensive technical documentation for Momo, an autonomous AI browser agent built as a Chrome Manifest V3 extension with a Rust bridge and MCP server integration.

## 📚 Documentation Overview

This directory contains architecture documentation, design decisions, audit reports, and interactive visualizations explaining how Momo works under the hood.

---

## 🏗️ Architecture Documentation

### Core Architecture

- **[ARCHITECTURE.md](ARCHITECTURE.md)** - Main architectural overview with Mermaid diagrams covering the complete system topology, component architecture, MCP tool flow, and policy boundaries

### Interactive Visualizations

The `architecture/` directory contains professionally designed, interactive HTML/SVG diagrams deployed to **Wasmer Edge** for public access:

- **[Index](architecture/index.html)** - Navigation hub for all visualizations
- **[Overall Architecture](architecture/overview.html)** - Complete 5-layer system topology (Extension, Service Worker, Content Scripts, Bridge, Browser Runtime)
- **[Communication Layers](architecture/communication-layers.html)** - Deep dive into 4 messaging protocols: chrome.runtime, WebSocket, CDP, and MCP
- **[WebSocket Patterns](architecture/websocket-patterns.html)** - RPC, pub/sub, and command-channel flows over the extension↔bridge WebSocket
- **[Tool Execution Flow](architecture/tool-execution-flow.html)** - Security-gated execution pipeline from MCP tool call to browser action (9 steps)
- **[Perception System](architecture/perception-system.html)** - How Momo "sees" web pages: AX tree extraction, DOM observation, element references, and redaction
- **[Security Architecture](architecture/security-architecture.html)** - Trust boundaries, policy engine, and fail-closed authorization model
- **[Operating Modes](architecture/operating-modes.html)** - Mode A (autonomous orchestration) vs Mode B (MCP client control)

**Features:**
- Interactive tooltips with code references on hover
- Filterable views for specific layers or patterns
- Self-contained with no external dependencies
- Theme-aware (respects system light/dark mode)
- Responsive design for different screen sizes

See [architecture/README.md](architecture/README.md) for implementation details, design system, and editing guidelines.

---

## 📋 Architecture Decision Records (ADRs)

Documented technical decisions with context, rationale, and consequences:

- **[ADR-0001: Policy Gate in Rust Bridge](adr/0001-policy-gate.md)** - Why the human-in-the-loop policy gate lives in the Rust bridge process outside the JavaScript trust domain, not in the extension itself

Future ADRs will document additional architectural decisions as the project evolves.

---

## 🔍 Audit Reports

Comprehensive security and technical assessments:

- **[Security Audit Report](audits/SECURITY_AUDIT_REPORT.md)** - Security analysis covering trust boundaries, attack surface, permissions model, data handling, and threat mitigation strategies
- **[Technical Audit](audits/TECHNICAL_AUDIT.md)** - Technical deep-dive into code quality, architecture patterns, performance characteristics, and improvement recommendations

---

## 📐 Diagram Sources

Mermaid source files for architecture diagrams (`.mmd` format):

- **[component-architecture.mmd](diagrams/component-architecture.mmd)** - Major components and connections across Extension, Bridge, and Browser layers
- **[mcp-tool-flow.mmd](diagrams/mcp-tool-flow.mmd)** - MCP tool request flow from client through bridge to browser execution
- **[policy-boundary.mmd](diagrams/policy-boundary.mmd)** - Policy enforcement boundaries and authorization gates

These files can be rendered using Mermaid CLI, GitHub's built-in renderer, or various Mermaid-compatible tools.

---

## 🎯 Quick Navigation

**New to Momo?** Start here:
1. [ARCHITECTURE.md](ARCHITECTURE.md) - Get the big picture
2. [Interactive visualizations](architecture/index.html) - Explore components visually
3. [ADR-0001](adr/0001-policy-gate.md) - Understand the security model

**Deepening understanding:**
- [Technical Audit](audits/TECHNICAL_AUDIT.md) - Implementation analysis
- [Security Audit](audits/SECURITY_AUDIT_REPORT.md) - Security model and threats

**Making changes:**
- [architecture/README.md](architecture/README.md) - How to update diagrams
- ADRs - Document new architectural decisions

---

## 🤝 Contributing to Documentation

### When to Update Documentation

Documentation should be updated when:
- Architectural patterns change
- New components or layers are added
- Security boundaries are modified
- Communication protocols evolve
- Operating modes are expanded

### Update Process

1. **Code is the source of truth** - Always update implementation first
2. **Update Mermaid diagrams** in ARCHITECTURE.md for inline reference
3. **Update HTML visualizations** in `architecture/` for detailed, interactive views
4. **Create ADRs** for significant architectural decisions
5. **Keep everything in sync** - All documentation should tell the same story

### Creating New ADRs

Follow the template pattern from ADR-0001:
- **Title**: ADR-NNNN: Brief descriptive title
- **Status**: Proposed | Accepted | Deprecated | Superseded
- **Context**: What problem needs solving?
- **Decision**: What was decided?
- **Consequences**: What are the tradeoffs?

Place new ADRs in `adr/` with sequential numbering.

### Editing Interactive Visualizations

See [architecture/README.md](architecture/README.md) for:
- Coordinate system and SVG structure
- Color palette and design patterns
- Adding tooltips and interactive elements
- Testing across browsers

---

## 📦 File Structure

```
docs/
├── README.md                          # This file
├── ARCHITECTURE.md                    # Main architecture overview
├── adr/                               # Architecture Decision Records
│   └── 0001-policy-gate.md
├── architecture/                      # Interactive HTML visualizations
│   ├── README.md
│   ├── IMPLEMENTATION.md
│   ├── index.html                     # Navigation hub
│   ├── overview.html
│   ├── communication-layers.html
│   ├── websocket-patterns.html
│   ├── tool-execution-flow.html
│   ├── perception-system.html
│   ├── security-architecture.html
│   └── operating-modes.html
├── audits/                            # Security and technical audits
│   ├── SECURITY_AUDIT_REPORT.md
│   └── TECHNICAL_AUDIT.md
└── diagrams/                          # Mermaid source files
    ├── component-architecture.mmd
    ├── mcp-tool-flow.mmd
    └── policy-boundary.mmd
```

---

## 🌐 Deployment

The interactive HTML visualizations in `architecture/` are deployed to **Wasmer Edge** for public access, allowing stakeholders, contributors, and users to explore Momo's architecture without cloning the repository.

Deployment is handled via the Wasmer CLI and configured in the project's deployment scripts.

---

## 📄 License

All documentation is part of the Momo project and follows the same license. See the root [LICENSE](../LICENSE) file for details.

---

## 💬 Questions or Feedback?

- Found an error in the documentation? Open an issue
- Have suggestions for improvement? Submit a pull request
- Need clarification? Check the [Technical Audit](audits/TECHNICAL_AUDIT.md) or [Security Audit](audits/SECURITY_AUDIT_REPORT.md) for detailed analysis

**Last updated**: August 2026
