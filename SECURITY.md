<div align="center">

# Security Policy

**Momo's fail-closed policy engine and security practices**

![Security](https://img.shields.io/badge/security-first-brightgreen)
[![Report Vulnerability](https://img.shields.io/badge/report-vulnerability-critical)](https://github.com/HoldTroop/Momo/security/advisories/new)

</div>

---

## Security First

Momo is designed with security as a foundational principle. We employ a **fail-closed policy engine** architecture that ensures all automation is explicitly authorized through a trusted boundary. This document outlines our security practices, how to report vulnerabilities, and what to expect from our response process.

---

## Supported Versions

| Version | Supported          | Notes |
| ------- | ------------------ | ----- |
| 0.3.x   | Yes             | Current stable |
| 0.2.x   | Security fixes only | Legacy line |
| < 0.2   | No              | Please upgrade |

---

## Reporting a Vulnerability

Thank you for helping us maintain the security of Momo. If you discover a security issue, we appreciate your responsible disclosure.

### Reporting Channels

**Primary Method (Preferred):**
- [GitHub Security Advisories](https://github.com/HoldTroop/Momo/security/advisories/new) - Private, tracked, and integrated with our workflow

**Alternative Contact:**
- **Email:** security@holdtroop.dev
- **PGP Key:** Available at [https://holdtroop.dev/security.asc](https://holdtroop.dev/security.asc) for encrypted communications

**Emergency Contact (Critical Vulnerabilities Only):**
- For actively exploited or critical vulnerabilities requiring immediate attention, email security@holdtroop.dev with subject line "URGENT SECURITY"
- Response time: Within 4 hours during business hours (UTC+6, 9:00-17:00)

### What to Include

Please provide as much detail as possible:
- Description of the vulnerability
- Steps to reproduce the issue
- Proof of concept (if available)
- Potential impact and attack scenarios
- Affected versions
- Any suggested mitigations or fixes
- Your contact information for follow-up

---

## Severity Classification

We use a severity matrix based on CVSS 3.1 scoring with Momo-specific considerations:

### Critical (CVSS 9.0-10.0)
**Examples:**
- Remote code execution in the bridge process
- Bypass of the policy engine allowing unauthorized system access
- Credential theft from secure storage
- Privilege escalation from extension to host system

**Response Time:** Emergency patch within 24-48 hours  
**Public Disclosure:** After patch is released

### High (CVSS 7.0-8.9)
**Examples:**
- Authentication bypass in WebSocket communication
- Injection vulnerabilities in tool executors
- Origin allowlist bypass enabling unauthorized domain automation
- Memory corruption vulnerabilities

**Response Time:** Patch within 2-4 weeks  
**Public Disclosure:** Coordinated with fix release

### Medium (CVSS 4.0-6.9)
**Examples:**
- Information disclosure of non-sensitive data
- Denial of service requiring local access
- Audit log tampering or bypass
- CSRF in policy configuration

**Response Time:** Fix in next minor release (4-8 weeks)  
**Public Disclosure:** With release notes

### Low (CVSS 0.1-3.9)
**Examples:**
- Minor information leaks
- UI spoofing without security impact
- Issues requiring significant user interaction
- Theoretical vulnerabilities with no known exploit

**Response Time:** Fix in next major release or minor release  
**Public Disclosure:** With release notes

---

## Response Timeline

- **Initial acknowledgment:** Within 48 hours of report
- **Severity assessment:** Within 1 week (including preliminary CVSS scoring)
- **Regular updates:** Every 2 weeks during fix development
- **Fix timeline:** Based on severity classification above
- **CVE assignment:** For High and Critical vulnerabilities (coordinated with MITRE)

---

## Disclosure Policy

We practice coordinated disclosure with a **90-day timeline** from initial report to public disclosure. Security researchers will be credited in release notes, CHANGELOG.md, and our Security Hall of Fame unless anonymity is requested.

### Disclosure Process

During the 90-day disclosure period:
1. **Week 1:** Acknowledge report, assign severity, begin investigation
2. **Weeks 2-6:** Develop and test fix, create security advisory
3. **Weeks 6-8:** Release patched version, notify affected users
4. **Week 12-13:** Public disclosure (or sooner if fix is released)

**Example Timeline:**
- **Day 0:** Vulnerability reported
- **Day 2:** Acknowledged and assigned to security team
- **Day 7:** Severity confirmed (e.g., High), fix timeline communicated
- **Day 21:** Patch developed and tested
- **Day 28:** Security release 0.3.5 published
- **Day 28+:** Public advisory published, CVE assigned
- **Day 90:** Full technical details disclosed (if not already public)

### Researcher Recognition

Security researchers who responsibly disclose vulnerabilities will receive:
- Public credit in release notes (unless anonymity requested)
- Entry in our [Security Hall of Fame](#security-hall-of-fame)
- Direct communication with the development team
- Advance notification of the fix release

We do not currently offer a bug bounty program but deeply appreciate the security research community's contributions.

---

## Security Team

### Security Contact

**Primary Contact:** Momo Security Team  
**Email:** security@holdtroop.dev  
**Response Availability:** Monday-Friday, 9:00-17:00 UTC+6 (Bangladesh Time)  
**Weekend/After-hours:** Emergency issues only

**Team Members:**
- Security Lead: [To be assigned]
- Development Team: Core maintainers review all security issues

For general questions about security practices (non-vulnerability), please open a public GitHub Discussion.

---

## Out of Scope

The following are generally **NOT** considered security vulnerabilities:

### Excluded Issues

- **Social engineering or phishing** not directly exploiting Momo code
- **Denial of service** requiring physical access to the user's machine
- **Issues in outdated or unsupported versions** (< 0.2.x)
- **Vulnerabilities in third-party dependencies** already publicly disclosed (please report to the upstream project, we'll track and update)
- **Vulnerabilities requiring user to install malicious extensions** or software
- **Issues in browsers or operating systems** not caused by Momo
- **Theoretical vulnerabilities** without practical exploitation path
- **Self-XSS** requiring the user to paste malicious code
- **Reports from automated scanners** without validation or proof of exploitability

### Not Vulnerabilities

- Missing security headers in local development server
- Rate limiting bypass in local-only development mode
- Configuration options that allow users to reduce their own security (documented behaviors)
- Failure of the extension to work on intentionally blocked sites

If you're uncertain whether an issue qualifies, please report it anyway. We'll evaluate and provide guidance.

---

## Security Testing Guidelines

We encourage security research on Momo, but please follow these guidelines:

### Responsible Testing

**Allowed:**
- Testing on your own local installation
- Automated scanning with reasonable rate limits
- Testing in isolated development environments
- Analyzing publicly available source code

**Not Allowed:**
- Testing on other users' installations without permission
- Attempting to access others' policy databases or audit logs
- Denial of service attacks
- Social engineering of Momo users or developers
- Testing on production systems you don't own

### Test Environment Setup

For security research, we recommend:
1. Install Momo from source on a dedicated test machine or VM
2. Use isolated browser profiles for extension testing
3. Run the bridge in a containerized environment
4. Enable verbose logging for detailed security analysis
5. Refer to [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for setup instructions

If you need assistance setting up a test environment, contact us at security@holdtroop.dev.

---

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

---

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

---

## Past Security Advisories

We maintain a record of all security advisories:

**GitHub Security Advisories Page:**  
[https://github.com/HoldTroop/Momo/security/advisories](https://github.com/HoldTroop/Momo/security/advisories)

### Summary of Past Issues

As of August 2026, no security vulnerabilities have been publicly disclosed. This section will be updated as security advisories are published.

### Security Hall of Fame

We thank the following security researchers for their responsible disclosure:

*No entries yet - be the first to help secure Momo!*

---

## Security Updates and Notifications

### How to Stay Informed

- **GitHub Watch:** Enable "Custom" watch and select "Security alerts" on the repository
- **GitHub Releases:** Security releases are marked with the `security` label
- **RSS Feed:** Subscribe to [GitHub releases RSS](https://github.com/HoldTroop/Momo/releases.atom)
- **Security Advisories:** Automatically notify repository watchers
- **CHANGELOG.md:** All security fixes documented with `[SECURITY]` prefix

### Recommended Actions

1. **Watch this repository** for security alerts
2. **Enable automatic updates** for the extension (if using Chrome Web Store)
3. **Subscribe to release notifications** to stay informed of patches
4. **Review the CHANGELOG** before updating to understand what changed

### Security Release Versioning

Security releases follow our standard semantic versioning but are expedited:
- **Patch releases** (0.3.x → 0.3.y) include security fixes
- **Security-only releases** may be published between regular releases
- **Backports** to supported legacy versions (0.2.x) for critical issues

---

## Additional Resources

- [Architecture Documentation](docs/ARCHITECTURE.md) - Security architecture diagrams
- [Security Audit Report](docs/audits/SECURITY_AUDIT_REPORT.md) - Third-party security assessment
- [Policy Gate ADR](docs/adr/0001-policy-gate.md) - Design decisions for policy engine
- [Development Guide](docs/DEVELOPMENT.md) - Secure development practices

---

## Questions?

For security-related questions that are not vulnerability reports:
- **Public discussions:** [GitHub Discussions](https://github.com/HoldTroop/Momo/discussions)
- **Security practices:** security@holdtroop.dev
- **General support:** [GitHub Issues](https://github.com/HoldTroop/Momo/issues)

<div align="center">

**Thank you for helping keep Momo and our community safe.**

[Code of Conduct](CODE_OF_CONDUCT.md) · [Contributing](CONTRIBUTING.md) · [License](LICENSE.md)

*Last updated: August 2026*
*The Momo Security Team*

</div>

