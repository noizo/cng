# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public issue.
2. Email the maintainer or use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability).
3. Include steps to reproduce and potential impact.

## Scope

CNG runs as a Cloudflare Worker. Security-relevant areas include:

- API key handling and authentication
- XSS prevention in the config panel
- Input sanitization for GraphQL queries
- Access control (admin vs client roles)

## Response

Confirmed vulnerabilities will be patched and disclosed after a fix is available.
