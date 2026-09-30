# Security Policy

## Supported versions

Vorschicht is developed on `main`; fixes land there. Please test against the latest commit before
reporting.

## Reporting a vulnerability

Please **do not** open a public issue, discussion or pull request for security problems.

Report privately through GitHub's private vulnerability reporting on this repository:
**Security → Report a vulnerability**. Include a description, the commit you tested and steps to
reproduce.

You will receive an acknowledgement within **7 days**. A fix or workaround is aimed for within
**90 days** of triage, followed by a GitHub security advisory.

## Scope

In scope: the dashboard and API (passkey bootstrap and rescue, session cookies, CSRF, rate limiting,
the SSE stream), the containment hooks (`packages/shared/src/containment.ts`, `packages/core/src/hook-entry.ts`),
the secret-scan and transcript-leak scan, the MCP server, the deploy engine (rollback, migration stop),
the backup sidecar, the container images and the nginx template.

Known and tracked in the issue tracker (no need to report again): the least-privilege database role
`vorschicht_app` exists but nothing connects as it (A94); Bash inside an agent session is scoped by
whitelist, not by a namespace — the accepted limit of §6.6.

Out of scope: the terms under which Anthropic bills programmatic use of a subscription (the studio
watches for changes but cannot prevent them), and any host outside the compose stack.
