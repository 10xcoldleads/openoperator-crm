# Security policy

## Supported version

Security fixes target the latest `main` branch until versioned releases begin.

## Report a vulnerability

Do not open a public issue containing an exploit, credential, customer record, or production URL. Use GitHub's private vulnerability reporting for the repository. Maintainers should acknowledge a complete report within five business days.

## Deployment requirements

- Put the interactive CRM behind an identity-aware access boundary.
- Keep the public intake Worker separate from CRM read/admin routes.
- Use unique production secrets with at least 32 bytes of entropy.
- Store secrets only with Cloudflare secret bindings or an equivalent managed secret store.
- Restrict `ADMIN_EMAILS`; never ship the example owner address to production.
- Replace example domains and verify callback URLs before enabling OAuth.
- Apply D1 migrations before traffic and back up before upgrades.
- Configure outbound destination allowlists and retain SSRF protections.
- Rotate source, agent, webhook, scheduler, OAuth, and recovery credentials independently.
- Review provider data-processing, retention, consent, messaging, recording, and payment obligations before enabling an integration.

## Trust model

CRM text, imported fields, webhook bodies, email previews, agent output, and website content are untrusted data. They cannot grant tool authority. Agents receive bounded projections and may create proposals; sensitive CRM changes require an authorized human decision.
