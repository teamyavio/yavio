# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Yavio, please report it responsibly. **Do not open a public GitHub issue.**

### Contact

Email: **security@yavio.ai**

### What to include

- Description of the vulnerability
- Steps to reproduce
- Affected versions
- Potential impact
- Suggested fix (if any)

### Response timeline

| Step | Target |
|------|--------|
| Acknowledgment | Within 24 hours |
| Initial assessment | Within 3 days |
| Fix released | Within 7 days for critical issues |

### Process

1. Report the vulnerability via email to security@yavio.ai
2. We will acknowledge receipt within 24 hours
3. We will investigate and keep you updated on progress
4. Once a fix is ready, we will coordinate disclosure with you
5. We will credit you in the release notes (unless you prefer to remain anonymous)

## Scope

This policy covers:

- `@yavio/sdk` (npm package)
- `@yavio/cli` (npm package)
- `yavio/dashboard` (Docker image)
- `yavio/ingest` (Docker image)
- The Yavio Cloud service at `*.yavio.ai`

## Out of Scope

- Vulnerabilities in third-party dependencies (report these upstream, but let us know if they affect Yavio)
- Social engineering attacks
- Denial of service attacks
- Issues in environments running unsupported or heavily modified versions

## Security Best Practices for Self-Hosters

- Always run behind a TLS-terminating reverse proxy in production
- Set strong, unique values for `NEXTAUTH_SECRET`, `JWT_SECRET`, `API_KEY_HASH_SECRET`, and `ENCRYPTION_KEY`
- Never expose database ports (5432, 8123, 9000) to the public internet
- Keep Docker images updated (`yavio update`)
- Review the [deployment documentation](https://docs.yavio.ai/self-hosting/production) for production hardening
