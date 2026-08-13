"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Consent = {
  status: "unknown" | "opted_in" | "opted_out";
  basis: "unknown" | "express" | "contractual" | "inbound_request" | "manual_suppression";
  evidence: string | null;
  captured_at: string | null;
  revision: number;
};
type Thread = {
  id: string; contact_id: string | null; participant_email: string; subject: string;
  status: "open" | "closed"; last_message_at: string; unread_count: number; revision: number;
  contact_name: string | null; consent: Consent;
};
type Message = {
  id: string; direction: "inbound" | "outbound"; provider: string; from_email: string; to_email: string;
  subject: string; body_text: string; purpose: string; status: string; error: string | null;
  sent_by: string | null; occurred_at: string;
};
type ContactOption = { id: string; email: string; first_name?: string | null; last_name?: string | null };
type Mailbox = { id: string; alias: string; status: string };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "include", ...init });
  const body = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

export default function ConversationsWorkspace({ active }: { active: boolean }) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [compose, setCompose] = useState({ contact_id: "", subject: "", text: "", purpose: "transactional" });
  const [contactConsent, setContactConsent] = useState<Consent | null>(null);
  const [consent, setConsent] = useState({ status: "opted_in", basis: "express", evidence: "", captured_at: new Date().toISOString().slice(0, 16) });
  const [sendArmed, setSendArmed] = useState(false);

  const selected = useMemo(() => threads.find((thread) => thread.id === selectedId) || null, [threads, selectedId]);

  const loadThreads = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const data = await api<{ threads: Thread[] }>("/v1/admin/conversations?limit=100");
      setThreads(data.threads);
      setSelectedId((current) => current && data.threads.some((thread) => thread.id === current)
        ? current : data.threads[0]?.id || null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Conversations could not be loaded"); }
    finally { setLoading(false); }
  }, []);

  const loadContext = useCallback(async () => {
    try {
      const [contactData, mailboxData] = await Promise.all([
        api<{ contacts: ContactOption[] }>("/v1/admin/contacts?limit=100"),
        api<{ connections: Mailbox[] }>("/v1/admin/mailbox-connections"),
      ]);
      setContacts(contactData.contacts || []);
      setMailboxes((mailboxData.connections || []).filter((mailbox) => mailbox.status === "active"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Conversation context could not be loaded"); }
  }, []);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => { void loadThreads(); void loadContext(); }, 0);
    return () => window.clearTimeout(timer);
  }, [active, loadContext, loadThreads]);

  useEffect(() => {
    if (!active || !selectedId) return;
    let cancelled = false;
    void api<{ messages: Message[] }>(`/v1/admin/conversations/${selectedId}`).then((data) => {
      if (!cancelled) setMessages(data.messages);
    }).catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Thread could not be loaded"); });
    return () => { cancelled = true; };
  }, [active, selectedId]);

  useEffect(() => {
    if (!active || !compose.contact_id) return;
    let cancelled = false;
    void api<{ consent: Consent }>(`/v1/admin/contacts/${compose.contact_id}/communication-consent`).then((data) => {
      if (!cancelled) setContactConsent(data.consent);
    }).catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Permission could not be loaded"); });
    return () => { cancelled = true; };
  }, [active, compose.contact_id]);

  const syncMailboxes = async () => {
    if (!mailboxes.length) { setError("Connect an active Gmail or Outlook mailbox first."); return; }
    setWorking("sync"); setError(""); setNotice("");
    try {
      const results = await Promise.all(mailboxes.map((mailbox) => api<{ imported: number; repeated: number }>(
        `/v1/admin/mailbox-connections/${mailbox.id}/sync-conversations`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ limit: 25, confirmation: "SYNC EMAIL METADATA" }),
        })));
      setNotice(`Mailbox sync complete: ${results.reduce((sum, result) => sum + result.imported, 0)} new, ${results.reduce((sum, result) => sum + result.repeated, 0)} already recorded.`);
      await loadThreads();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Mailbox sync failed"); }
    finally { setWorking(""); }
  };

  const updateThread = async () => {
    if (!selected) return;
    setWorking("thread"); setError("");
    try {
      await api(`/v1/admin/conversations/${selected.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: selected.status === "open" ? "closed" : "open", mark_read: true, if_revision: selected.revision }),
      });
      await loadThreads();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Conversation could not be updated"); }
    finally { setWorking(""); }
  };

  const recordPermission = async () => {
    if (!compose.contact_id || !consent.evidence.trim()) { setError("Choose a contact and describe the permission evidence."); return; }
    const capturedAt = new Date(consent.captured_at);
    if (!consent.captured_at || !Number.isFinite(capturedAt.getTime())) { setError("Enter a valid permission timestamp."); return; }
    setWorking("consent"); setError(""); setNotice("");
    try {
      await api(`/v1/admin/contacts/${compose.contact_id}/communication-consent`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
          status: consent.status, basis: consent.status === "opted_out" ? "manual_suppression" : consent.basis,
          evidence: consent.evidence.trim(), captured_at: capturedAt.toISOString(),
          ...(contactConsent?.revision ? { if_revision: contactConsent.revision } : {}),
        }),
      });
      setNotice(consent.status === "opted_out" ? "Email suppression recorded." : "Email permission evidence recorded.");
      const refreshed = await api<{ consent: Consent }>(`/v1/admin/contacts/${compose.contact_id}/communication-consent`);
      setContactConsent(refreshed.consent); await loadThreads();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Permission could not be recorded"); }
    finally { setWorking(""); }
  };

  const send = async () => {
    if (!sendArmed) { setSendArmed(true); return; }
    if (!compose.contact_id || !compose.subject.trim() || !compose.text.trim()) {
      setError("Choose a contact and complete the subject and message."); setSendArmed(false); return;
    }
    setWorking("send"); setError(""); setNotice("");
    try {
      const data = await api<{ thread_id: string }>("/v1/admin/conversations/send", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          ...compose, ...(selected?.contact_id === compose.contact_id && selected.status === "open" ? { thread_id: selected.id } : {}),
          subject: compose.subject.trim(), text: compose.text.trim(),
          idempotency_key: `ui:${crypto.randomUUID()}`, confirmation: "SEND EMAIL",
        }),
      });
      setCompose({ ...compose, subject: "", text: "" }); setSendArmed(false);
      setNotice("Email sent and recorded in the conversation ledger.");
      await loadThreads(); setSelectedId(data.thread_id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Email could not be sent"); setSendArmed(false); }
    finally { setWorking(""); }
  };

  if (!active) return null;
  return <main className="conversation-workspace" aria-labelledby="conversations-title">
    <header className="conversation-hero"><div><p className="eyebrow">CONSENT-AWARE EMAIL</p>
      <h1 id="conversations-title">Conversations</h1>
      <p>One persisted inbox for confirmed mailbox metadata and human-sent email. Sending is blocked unless current permission evidence exists.</p></div>
      <div><button type="button" className="secondary" onClick={() => void loadThreads()} disabled={loading}>REFRESH</button>
        <button type="button" onClick={() => void syncMailboxes()} disabled={working === "sync"}>{working === "sync" ? "SYNCING…" : "SYNC MAILBOXES"}</button></div>
    </header>
    {error && <div className="conversation-banner error" role="alert">{error}</div>}
    {notice && <div className="conversation-banner success" role="status">{notice}</div>}
    <div className="conversation-layout">
      <aside className="conversation-list" aria-label="Conversation threads">
        <header><b>{threads.length} THREAD{threads.length === 1 ? "" : "S"}</b><small>{loading ? "Loading…" : "Newest first"}</small></header>
        {threads.map((thread) => <button type="button" key={thread.id} className={thread.id === selectedId ? "active" : ""}
          onClick={() => setSelectedId(thread.id)}><span><strong>{thread.contact_name || thread.participant_email}</strong>
            {thread.unread_count > 0 && <mark>{thread.unread_count}</mark>}</span><b>{thread.subject}</b>
          <small>{new Date(thread.last_message_at).toLocaleString()} · {thread.status}</small></button>)}
        {!loading && !threads.length && <div className="empty-state">No persisted conversations yet. Sync a connected mailbox or send a permitted email.</div>}
      </aside>
      <section className="conversation-thread" aria-label="Selected conversation">
        {selected ? <><header><div><p className="eyebrow">{selected.participant_email}</p><h2>{selected.subject}</h2>
          <small>Permission: {selected.consent.status.replace("_", " ")} · {selected.consent.basis.replaceAll("_", " ")}</small></div>
          <button type="button" className="secondary" onClick={() => void updateThread()} disabled={working === "thread"}>
            {selected.status === "open" ? "CLOSE & MARK READ" : "REOPEN"}</button></header>
          <div className="conversation-messages">{messages.map((message) => <article key={message.id} className={message.direction}>
            <header><b>{message.direction === "inbound" ? message.from_email : `Sent by ${message.sent_by || "operator"}`}</b>
              <mark className={message.status}>{message.status.toUpperCase()}</mark></header>
            <p>{message.body_text || "No preview content was provided."}</p><small>{new Date(message.occurred_at).toLocaleString()} · {message.provider}</small>
            {message.error && <em>{message.error}</em>}</article>)}</div></> : <div className="empty-state">Select a thread to inspect its persisted message ledger.</div>}
      </section>
      <aside className="conversation-compose" aria-label="Compose consent-aware email"><h2>Compose</h2>
        <label>CONTACT<select value={compose.contact_id} onChange={(event) => {
          setContactConsent(null); setCompose({ ...compose, contact_id: event.target.value });
        }}>
          <option value="">Choose a contact</option>{contacts.filter((contact) => contact.email).map((contact) => <option key={contact.id} value={contact.id}>
            {[contact.first_name, contact.last_name].filter(Boolean).join(" ") || contact.email} · {contact.email}</option>)}</select></label>
        <p className="consent-state">Current permission: <b>{contactConsent?.status.replace("_", " ") || "choose a contact"}</b>
          {contactConsent?.basis && contactConsent.basis !== "unknown" ? ` · ${contactConsent.basis.replaceAll("_", " ")}` : ""}</p>
        <label>PURPOSE<select value={compose.purpose} onChange={(event) => setCompose({ ...compose, purpose: event.target.value })}>
          <option value="transactional">Transactional</option><option value="marketing">Marketing (express opt-in only)</option></select></label>
        <label>SUBJECT<input value={compose.subject} maxLength={200} onChange={(event) => setCompose({ ...compose, subject: event.target.value })}/></label>
        <label>MESSAGE<textarea value={compose.text} maxLength={10000} onChange={(event) => setCompose({ ...compose, text: event.target.value })}/></label>
        <button type="button" onClick={() => void send()} disabled={working === "send"}>{working === "send" ? "SENDING…" : sendArmed ? "CONFIRM SEND EMAIL" : "REVIEW & SEND"}</button>
        <details><summary>Record permission evidence</summary>
          <label>STATUS<select value={consent.status} onChange={(event) => setConsent({ ...consent,
            status: event.target.value, basis: event.target.value === "opted_out" ? "manual_suppression" : "express" })}>
            <option value="opted_in">Opted in</option><option value="opted_out">Opted out / suppress</option></select></label>
          <label>BASIS<select value={consent.basis} onChange={(event) => setConsent({ ...consent, basis: event.target.value })}>
            {consent.status === "opted_out" ? <option value="manual_suppression">Manual suppression</option> : <>
              <option value="express">Express opt-in</option><option value="contractual">Contractual</option><option value="inbound_request">Inbound request</option></>}</select></label>
          <label>CAPTURED AT<input type="datetime-local" value={consent.captured_at} onChange={(event) => setConsent({ ...consent, captured_at: event.target.value })}/></label>
          <label>EVIDENCE<textarea value={consent.evidence} maxLength={500} onChange={(event) => setConsent({ ...consent, evidence: event.target.value })}/></label>
          <button type="button" className="secondary" onClick={() => void recordPermission()} disabled={working === "consent"}>RECORD PERMISSION</button>
        </details>
      </aside>
    </div>
  </main>;
}
