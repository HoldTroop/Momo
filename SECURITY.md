# Security Policy

## Supported Versions

| Version | Supported          | Notes |
| ------- | ------------------ | ----- |
| 0.3.x   | ✅ Yes             | Current stable |
| 0.2.x   | ⚠️ Security fixes only | Legacy line |
| < 0.2   | ❌ No              | Please upgrade |

## Reporting a Vulnerability

Thank you for helping us maintain the security of Momo. If you discover a
security issue, we appreciate your responsible disclosure.

To report a security vulnerability, please fill out our private security form:

[Submit Security Issue](https://github.com/HoldTroop/Momo/security/advisories/new)

Please provide as much detail as possible, including steps to reproduce the
issue, potential impact, and any additional context.

## Response Timeline

- **Initial acknowledgment:** Within 48 hours of report
- **Severity assessment:** Within 1 week
- **Fix timeline:** 
  - Critical: Days (emergency patch)
  - High: 2-4 weeks
  - Medium: Next minor release
  - Low: Next major release

## Disclosure Policy

We practice coordinated disclosure with a 90-day timeline. Security researchers will be credited in release notes and CHANGELOG.md unless anonymity is requested.

During the disclosure period:
- We will work with you to understand and validate the issue
- We will develop and test a fix
- We will prepare security advisories
- We will coordinate the public disclosure timing

After the 90-day period or once a fix is released (whichever comes first), the vulnerability details may be made public.

## Security Model

Momo's security architecture is designed around a **fail-closed policy engine** that enforces authorization boundaries between untrusted and trusted components.

### Trust Boundaries

The system operates across three trust zones:

1. **Untrusted Zone (Chrome Extension):** The extension components (AgentOrchestrator, tool executors, perception layer) operate in the untrusted zone and cannot self-authorize actions.

2. **Trust Boundary (WebSocket):** All communication between the extension and bridge flows through authenticated WebSocket connections with token-based authorization.

3. **Trusted Zone (Rust Bridge):** The policy engine, audit log, and configuration management run in the trusted bridge process.

### Policy Enforcement

Every action request follows this security-gated flow:

1. Extension requests action through WebSocket
2. Policy engine evaluates against allowlists, permissions, and risk classifications
3. Decision is logged to immutable audit trail
4. Action is authorized or denied
5. If authorized, extension executes and reports outcome
6. Audit log is updated with execution result

The policy engine checks:
- **Origin allowlists:** Which domains can be automated
- **Action permissions:** Which operations are allowed
- **Token budgets:** Rate limiting and resource constraints
- **Risk classifications:** Severity-based authorization rules

### Fail-Closed Design

If the policy engine is unavailable, cannot evaluate a request, or encounters an error, all actions are **denied by default**. This fail-closed approach ensures that security cannot be bypassed through error conditions or race conditions.

For architectural details, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Security Best Practices

When deploying Momo:

### Configuration Security

- **Never commit `.env` files** containing API keys or authentication tokens
- Store sensitive configuration outside version control
- Use environment-specific configuration files with restrictive permissions
- Rotate API keys and tokens regularly

### Origin Allowlists

- **Use origin allowlists restrictively** - only authorize domains you trust
- Prefer explicit allowlists over wildcard patterns
- Regularly audit and prune unused origins from allowlists
- Document why each origin is allowlisted

### Audit Logs

- **Review audit logs regularly** at `~/.momo/policy.db`
- Monitor for unexpected authorization denials
- Investigate unusual action patterns or high-risk operations
- Retain audit logs for compliance and incident response

### Updates

- **Keep both extension and bridge updated** to receive security patches
- Subscribe to security advisories through GitHub watch
- Test updates in non-production environments first
- Review CHANGELOG.md for security-relevant changes

### Deployment

- Run the bridge with minimal necessary privileges
- Use dedicated service accounts rather than personal credentials
- Enable audit logging in production environments
- Implement network segmentation where appropriate

### Development

- Never disable policy enforcement in production
- Test security controls in development environments
- Review changes to policy configuration carefully
- Follow secure coding practices for tool implementations

## Additional Resources

- [Architecture Documentation](docs/ARCHITECTURE.md) - Security architecture diagrams
- [Security Audit Report](docs/audits/SECURITY_AUDIT_REPORT.md) - Third-party security assessment
- [Policy Gate ADR](docs/adr/0001-policy-gate.md) - Design decisions for policy engine

Thank you, The Momo team
