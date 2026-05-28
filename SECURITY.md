# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |
| < 1.0   | No        |

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Email: security@meranews.app

Please include:
- A description of the vulnerability
- Steps to reproduce the issue
- The affected app version (visible in Settings)
- Your contact details (if you would like to be credited)

We will acknowledge your report within **5 business days** and aim to ship a fix within **30 days** for critical issues. We will credit reporters in release notes unless anonymity is requested.

## Scope

**In scope:**
- Authentication flows (Better Auth OTP, session management)
- E2EE inference path (XChaCha20-Poly1305 + X25519 ECDH key exchange)
- Secure key storage (expo-secure-store)
- Push notification handling
- GraphQL API calls and query construction

**Out of scope:**
- Backend infrastructure (this repo is the mobile app only; backend issues belong in the server repo)
- Social engineering attacks
- Denial-of-service against the app store
- Vulnerabilities in third-party dependencies that are already publicly known and tracked upstream

## Private Reporting via GitHub

To use GitHub's private vulnerability reporting, click the **"Report a vulnerability"** button on the Security tab of this repository. GitHub activates private advisory submission when this `SECURITY.md` file is present.
