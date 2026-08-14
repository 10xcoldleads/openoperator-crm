# Twilio SMS runtime contract

This module is not complete because an SDK is installed or a Settings card exists. It passes only when the following provider and CRM contracts are proved together.

## Connection

- One encrypted, workspace-owned Twilio credential and Messaging Service SID.
- Account SID and Messaging Service SID are format-validated and verified against Twilio before activation.
- Secrets are never returned, logged, backed up in plaintext, or exposed to agents.
- Disconnect is optimistic, audited, and cryptographically wipes the stored credential.

## Outbound

- Admin-only manual send in the first slice. No agent or workflow can send SMS directly; MCP can read governed custom values but has no SMS execution tool.
- Contact phone is normalized to E.164.
- Current SMS permission is required; marketing requires express evidence.
- Current local suppression is checked immediately before every send.
- One workspace idempotency key maps to one immutable request hash.
- Send uses `MessagingServiceSid`, `To`, `Body`, and a status callback URL.
- Provider acceptance is not delivery. Store queued/sent/delivered/undelivered/failed evidence separately.
- Bounded message length, rate, history, retry, and error redaction.

## Inbound and opt-out

- Validate `X-Twilio-Signature` against the exact public URL and complete form payload before mutation.
- Replay-protect by Twilio Message SID and retain the raw body only within documented bounds.
- A receipt is considered processed only after the linked CRM transaction succeeds; failed or out-of-order callbacks remain retryable.
- `OptOutType=STOP` immediately suppresses SMS locally; `START` records provider re-enable evidence but does not invent marketing consent; `HELP` does not change permission.
- Do not send a second application reply when Advanced Opt-Out already handled STOP, START, or HELP.
- A plain inbound message creates/links an SMS conversation without silently merging identities.
- Unknown senders remain quarantined until explicitly linked.

## Status callbacks

- Validate signatures and workspace/provider ownership.
- Accept monotonic provider states without allowing late callbacks to regress terminal evidence.
- Store error codes as bounded diagnostic evidence; do not treat provider error text as executable or trusted input.

## Explicit omissions

- No claim that Advanced Opt-Out is enabled until verified in the Twilio Console.
- No A2P campaign registration automation in this slice.
- No MMS, WhatsApp, toll-free verification, voice, bulk campaigns, schedules, or number purchasing.
