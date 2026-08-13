# Architecture

## Product boundary

OpenOperator models a revenue operation as a sequence of attributable events around a workspace-scoped record graph.

```text
forms / imports / APIs
          │
          ▼
  isolated intake Worker ──► contacts ──► opportunities ──► appointments/tasks
          │                     │                │                  │
          └──────────────► activity ledger ◄────┴──────────────────┘
                                │
                                ▼
                       bounded automation runner
                           │             │
                           ▼             ▼
                      direct actions   human-gated proposals
                                           │
                                           ▼
                                     agent work queue
```

## Invariants

1. Every business row belongs to exactly one workspace.
2. Authorization is checked at request time; workspace IDs from clients are never trusted alone.
3. Mutations and their audit evidence commit together.
4. Concurrent edits use record revisions or updated timestamps.
5. Automation inputs, actions, output sizes, and run counts are allowlisted and bounded.
6. Agent credentials grant named tools, not broad database or shell access.
7. Agent output cannot directly perform sensitive writes.
8. Public ingestion exposes no CRM reads.
9. Provider secrets are encrypted or hashed and omitted from ordinary reads and logs.
10. Optional features remain visibly unavailable until a real health check passes.

## Cloudflare components

- Workers serve the application/API and the separately deployable intake boundary.
- D1 holds relational, workspace-scoped operational data and migration history.
- Durable Objects provide serialized rate-gate behavior where configured.
- Cron triggers drive bounded schedulers and retry/health sweeps.
- Static assets are packaged with the application Worker.

Queues and R2 are optional future substitutions for high-volume delivery and large-object storage; the core repository does not require them merely to appear cloud-native.

## Integration policy

Adapters implement setup, health, execute, and revoke contracts. OAuth providers should own refresh tokens whenever possible. API keys are server-only. Webhook destinations use HTTPS validation, allowlists, signing, replay IDs, and bounded retries.
