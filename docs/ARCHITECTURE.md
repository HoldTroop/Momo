# Momo Architecture

This document provides architectural diagrams for the Momo autonomous AI browser agent.

## Interactive Visualizations

For detailed, interactive architecture diagrams with tooltips and explanations:

**[📊 View Interactive Architecture Visualizations →](architecture/index.html)**

The interactive diagrams include:
- **Overall Architecture** - Complete system topology (5 layers, 12 components)
- **Communication Layers** - Messaging patterns (chrome.runtime, WebSocket, CDP, MCP)
- **WebSocket Patterns** - RPC, pub/sub, and command-channel flows
- **Tool Execution Flow** - Security-gated execution pipeline (9 steps)
- **Perception System** - How Momo "sees" web pages (AX tree, redaction, stable refs)
- **Security Architecture** - Trust boundaries and fail-closed model
- **Operating Modes** - Mode A (autonomous) vs Mode B (MCP client control)

---

## Component Architecture

Shows the major components and how they connect across the Chrome Extension, Rust Bridge, and Browser Runtime layers. This diagram answers "What are the pieces and how do they talk to each other?"

```mermaid
graph TD
    subgraph Extension["Chrome Extension (Manifest V3)"]
        UI[Side Panel<br/>React UI]
        SW[Service Worker<br/>AgentOrchestrator<br/>MessageRouter]
        CS[Content Scripts<br/>Perception Layer<br/>AX Extractor]
        Lib[Shared Libraries<br/>Tools, Persistence, Redaction]
    end

    subgraph Bridge["Rust Bridge (Tokio)"]
        WS[WebSocket Server<br/>ConnectionManager]
        Policy[Policy Engine<br/>Allowlist, Audit Log]
        LLM[LLM Gateway<br/>Anthropic/Ollama]
        MCP[MCP Server<br/>stdio/JSON-RPC]
    end

    subgraph Browser["Browser Runtime"]
        CDP[Chrome DevTools Protocol]
        DOM[Web Pages]
        Storage[IndexedDB/SQLite]
    end

    subgraph External["External Clients"]
        User[User<br/>Mode A]
        MCPClient[MCP Client<br/>Mode B]
    end

    User -->|task input| UI
    UI <-->|messages| SW
    SW <-->|WebSocket| WS
    SW <-->|inject/query| CS
    SW -->|CDP commands| CDP
    CS <-->|extract| DOM
    SW <-->|persist| Storage
    
    WS <-->|authorize| Policy
    WS <-->|plan/infer| LLM
    Policy <-->|audit log| Storage
    
    MCPClient <-->|stdio| MCP
    MCP <-->|commands| WS
    
    CDP -->|trusted input| DOM

    classDef ui fill:#e6f1fb,stroke:#185fa5,color:#0c447c
    classDef core fill:#eaf3de,stroke:#3b6d11,color:#27500a
    classDef policy fill:#fef3e8,stroke:#d97706,color:#92400e
    classDef external fill:#faeeda,stroke:#854f0b,color:#633806

    class UI,User ui
    class SW,CS,Lib,WS,LLM,MCP core
    class Policy,Storage policy
    class CDP,DOM,MCPClient external
```

**Key insights**:
- Momo operates in two modes: Mode A (internal orchestration) and Mode B (MCP client control)
- The Service Worker is the orchestration hub, coordinating between UI, content scripts, CDP, and the bridge
- The Rust bridge provides policy enforcement, LLM inference, and MCP protocol support
- All components use WebSocket for extension↔bridge communication

## MCP Tool Flow

Shows the complete request/response cycle when an MCP client executes a tool (e.g., `execute_action`). This diagram answers "What happens during a typical MCP tool call?"

```mermaid
sequenceDiagram
    autonumber
    participant MCP as MCP Client
    participant Bridge as Rust Bridge
    participant WS as WebSocket
    participant SW as Service Worker
    participant CS as Content Script
    participant Page as Web Page

    Note over MCP,Bridge: Mode B: MCP over stdio

    MCP->>Bridge: tools/call<br/>(execute_action)
    activate Bridge
    
    Bridge->>Bridge: Policy check<br/>(origin allowlist)
    
    Bridge->>WS: Command<br/>(request_id, params)
    activate WS
    
    WS->>SW: execute_action
    activate SW
    
    SW->>CS: Extract elements<br/>(perception layer)
    activate CS
    CS->>Page: Read AX tree + DOM
    Page-->>CS: Interactive elements
    CS-->>SW: ref_id_map
    deactivate CS
    
    SW->>Page: CDP Input.dispatchMouseEvent<br/>(trusted click)
    Page-->>SW: Action result
    
    SW->>WS: CommandResult<br/>(success/error)
    deactivate SW
    
    WS-->>Bridge: Result payload
    deactivate WS
    
    Bridge->>Bridge: Log audit entry
    
    Bridge-->>MCP: tools/call response
    deactivate Bridge

    Note over Bridge: Audit log records:<br/>origin, action, outcome, risk_class
```

**Key insights**:
- All MCP tools use the command-channel pattern: bridge issues a Command with request_id, extension replies with CommandResult
- Policy checks happen before the extension receives the command
- The audit log records both the authorization decision AND the execution outcome
- Content scripts extract stable element references (el_XX) to ensure actions target the correct elements even after DOM mutations

## Policy Boundary

Shows the trust model and how the policy engine enforces security constraints. This diagram answers "How does the fail-closed security model work?"

```mermaid
graph LR
    subgraph Untrusted["Untrusted (Extension)"]
        Orch[AgentOrchestrator]
        Tools[Tool Executors]
        Perc[Perception Layer]
    end

    subgraph TrustBoundary["Trust Boundary"]
        WS[WebSocket<br/>Auth Token]
    end

    subgraph Trusted["Trusted (Bridge)"]
        Policy[Policy Engine]
        Audit[Audit Log<br/>SQLite]
        Config[Policy Config<br/>Allowlist]
    end

    Orch -->|1. Request action| WS
    WS -->|2. Evaluate| Policy
    Policy <-->|read| Config
    Policy -->|3. Log decision| Audit
    Policy -->|4. Authorize/Deny| WS
    WS -->|5. Execute if authorized| Orch
    Orch -->|6. Report outcome| WS
    WS -->|7. Update audit| Audit

    classDef untrusted fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
    classDef boundary fill:#fef3c7,stroke:#d97706,color:#78350f
    classDef trusted fill:#d1fae5,stroke:#059669,color:#064e3b

    class Orch,Tools,Perc untrusted
    class WS boundary
    class Policy,Audit,Config trusted
```

**Key insights**:
- The extension (untrusted zone) never self-authorizes actions
- All actions flow through the bridge's policy engine for evaluation
- The policy engine checks origin allowlists, action permissions, token budgets, and risk classifications
- The audit log is immutable and records every authorization decision
- The extension reports back the real execution outcome (success/failure) so the audit log can be corrected

## What's Not Shown

To keep these diagrams lean and focused, the following details are intentionally omitted:
- Individual tool implementations (navigate, click, type, scroll)
- Specific library dependencies (Dexie, Readability, Turndown)
- State management internals (checkpoints, WAL, task queue)
- Human intervention modals and confirmation flows
- Redaction engine and sensitive data handling
- Alarm manager, port manager, and other lifecycle utilities

These implementation details are important but don't define architectural boundaries.

## Editing These Diagrams

All diagram source files are in `docs/diagrams/*.mmd` and can be edited directly or pasted into [mermaid.live](https://mermaid.live) for interactive preview and tweaking.

To re-render after edits:
```bash
npx mmdc -i docs/diagrams/component-architecture.mmd -o docs/diagrams/component-architecture.svg
```
