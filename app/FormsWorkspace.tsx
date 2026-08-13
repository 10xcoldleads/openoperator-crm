"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Field = { key: "email" | "first_name" | "last_name" | "phone" | "company" | "message"; label: string; type: "email" | "text" | "tel" | "textarea"; required: boolean };
type FormRecord = { id: string; name: string; slug: string; status: "draft" | "published" | "revoked"; title: string; description: string;
  fields: Field[]; consent_text: string; success_message: string; public_path: string | null; revision: number; submission_count?: number; last_submission_at?: string | null };
type Submission = { id: string; payload: Record<string, string>; email_consent: boolean; submitted_at: string };
const fieldCatalog: Field[] = [
  { key: "email", label: "Email", type: "email", required: true }, { key: "first_name", label: "First name", type: "text", required: false },
  { key: "last_name", label: "Last name", type: "text", required: false }, { key: "phone", label: "Phone", type: "tel", required: false },
  { key: "company", label: "Company", type: "text", required: false }, { key: "message", label: "How can we help?", type: "textarea", required: false },
];
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "include", ...init }); const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`); return body;
}

export default function FormsWorkspace({ active, canAdmin }: { active: boolean; canAdmin: boolean }) {
  const [forms, setForms] = useState<FormRecord[]>([]); const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<FormRecord | null>(null); const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [creating, setCreating] = useState(false); const [newName, setNewName] = useState(""); const [newTitle, setNewTitle] = useState("");
  const [working, setWorking] = useState(""); const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [armed, setArmed] = useState("");
  const selected = useMemo(() => forms.find((form) => form.id === selectedId) || null, [forms, selectedId]);
  const load = useCallback(async () => {
    const data = await api<{ forms: FormRecord[] }>("/v1/admin/forms"); setForms(data.forms);
    setSelectedId((current) => current && data.forms.some((form) => form.id === current) ? current : data.forms[0]?.id || "");
  }, []);
  useEffect(() => { if (!active) return; const timer = window.setTimeout(() => void load().catch((cause) => setError(cause.message)), 0); return () => clearTimeout(timer); }, [active, load]);
  useEffect(() => {
    if (!active || !selectedId) return; let cancelled = false;
    void Promise.all([api<{ form: FormRecord }>(`/v1/admin/forms/${selectedId}`), api<{ submissions: Submission[] }>(`/v1/admin/forms/${selectedId}/submissions`)]).then(([detail, history]) => {
      if (!cancelled) { setDraft(detail.form); setSubmissions(history.submissions); }
    }).catch((cause) => { if (!cancelled) setError(cause.message); }); return () => { cancelled = true; };
  }, [active, selectedId]);
  async function create(event: FormEvent) {
    event.preventDefault(); setWorking("create"); setError(""); try {
      const data = await api<{ form: FormRecord }>("/v1/admin/forms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: newName, title: newTitle }) });
      setCreating(false); setNewName(""); setNewTitle(""); await load(); setSelectedId(data.form.id); setNotice("Draft form created.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Form could not be created"); } finally { setWorking(""); }
  }
  async function save() {
    if (!draft) return; setWorking("save"); setError(""); try {
      const data = await api<{ form: FormRecord }>(`/v1/admin/forms/${draft.id}`, { method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: draft.name, title: draft.title, description: draft.description, fields: draft.fields,
          consent_text: draft.consent_text, success_message: draft.success_message, if_revision: draft.revision }) });
      setDraft(data.form); await load(); setNotice("Draft saved. Published visitors still see the last immutable version.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Draft could not be saved"); } finally { setWorking(""); }
  }
  async function lifecycle(action: "publish" | "revoke") {
    if (!draft) return; if (armed !== action) { setArmed(action); return; } setWorking(action); setError(""); try {
      const data = await api<{ form: FormRecord }>(`/v1/admin/forms/${draft.id}/${action}`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ if_revision: draft.revision, confirmation: action === "publish" ? "PUBLISH FORM" : "REVOKE FORM" }) });
      setDraft(data.form); setArmed(""); await load(); setNotice(action === "publish" ? "Published as a new immutable version." : "Public access revoked immediately.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Lifecycle action failed"); } finally { setWorking(""); }
  }
  function toggleField(field: Field) {
    if (!draft || field.key === "email") return; const exists = draft.fields.some((item) => item.key === field.key);
    setDraft({ ...draft, fields: exists ? draft.fields.filter((item) => item.key !== field.key) : [...draft.fields, fieldCatalog.find((item) => item.key === field.key)!] });
  }
  if (!active) return null;
  return <main className="forms-workspace"><header className="forms-hero"><div><p className="eyebrow">VERSIONED PUBLIC INTAKE</p><h1>Forms</h1>
    <p>Build the capture contract first. Publish an immutable version only when its fields, privacy acknowledgement, and optional email consent are ready.</p></div>
    {canAdmin && <button onClick={() => setCreating(true)}>NEW FORM</button>}</header>
    {error && <div className="conversation-banner error" role="alert">{error}</div>}{notice && <div className="conversation-banner success" role="status">{notice}</div>}
    {creating && <form className="form-create-strip" onSubmit={create}><label>INTERNAL NAME<input required maxLength={120} value={newName} onChange={(event) => setNewName(event.target.value)} /></label>
      <label>PUBLIC HEADLINE<input required maxLength={160} value={newTitle} onChange={(event) => setNewTitle(event.target.value)} /></label>
      <button disabled={working === "create"}>CREATE DRAFT</button><button type="button" className="secondary" onClick={() => setCreating(false)}>CANCEL</button></form>}
    <div className="forms-layout"><aside className="forms-index"><header><b>FORM REGISTER</b><small>{forms.length} total</small></header>
      {forms.map((form) => <button key={form.id} className={selectedId === form.id ? "active" : ""} onClick={() => setSelectedId(form.id)}>
        <span><b>{form.name}</b><mark className={form.status}>{form.status}</mark></span><small>{form.submission_count || 0} submissions · rev {form.revision}</small></button>)}
      {!forms.length && <div className="empty-state">No forms yet. Create one to define the first secure intake path.</div>}</aside>
      <section className="form-blueprint">{draft && selected ? <><header><div><p>FORM / {draft.slug}</p><h2>{draft.name}</h2></div><mark className={draft.status}>{draft.status}</mark></header>
        <div className="form-editor"><label>INTERNAL NAME<input value={draft.name} maxLength={120} disabled={!canAdmin} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          <label>PUBLIC HEADLINE<input value={draft.title} maxLength={160} disabled={!canAdmin} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
          <label className="wide">DESCRIPTION<textarea value={draft.description} maxLength={1000} disabled={!canAdmin} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
          <fieldset className="wide"><legend>CAPTURE FIELDS</legend><div className="field-palette">{fieldCatalog.map((field) => {
            const included = draft.fields.some((item) => item.key === field.key); return <button type="button" key={field.key} className={included ? "included" : ""}
              disabled={!canAdmin || field.key === "email"} onClick={() => toggleField(field)}><span>{included ? "✓" : "+"}</span>{field.label}<small>{field.key === "email" ? "REQUIRED" : included ? "IN FORM" : "ADD"}</small></button>; })}</div></fieldset>
          <label className="wide">OPTIONAL EMAIL CONSENT<textarea value={draft.consent_text} maxLength={800} disabled={!canAdmin} onChange={(event) => setDraft({ ...draft, consent_text: event.target.value })} /></label>
          <label className="wide">SUCCESS MESSAGE<input value={draft.success_message} maxLength={300} disabled={!canAdmin} onChange={(event) => setDraft({ ...draft, success_message: event.target.value })} /></label></div>
        <footer>{canAdmin && <><button onClick={() => void save()} disabled={Boolean(working)}>SAVE DRAFT</button>
          <button className={armed === "publish" ? "confirm" : "secondary"} onClick={() => void lifecycle("publish")} disabled={Boolean(working)}>{armed === "publish" ? "CONFIRM PUBLISH NEW VERSION" : "PUBLISH"}</button>
          {draft.status === "published" && <button className={armed === "revoke" ? "danger-action" : "secondary"} onClick={() => void lifecycle("revoke")} disabled={Boolean(working)}>{armed === "revoke" ? "CONFIRM REVOKE PUBLIC FORM" : "REVOKE"}</button>}</>}
          {draft.public_path && <a href={draft.public_path} target="_blank" rel="noreferrer">OPEN PUBLIC FORM ↗</a>}</footer></> : <div className="empty-state">Select a form to inspect its capture contract.</div>}</section>
      <aside className="form-ledger"><header><b>SUBMISSION LEDGER</b><small>Latest 100</small></header>{submissions.map((submission) => <article key={submission.id}>
        <b>{submission.payload.email}</b><p>{submission.payload.message || [submission.payload.first_name, submission.payload.last_name].filter(Boolean).join(" ") || "No message"}</p>
        <small>{new Date(submission.submitted_at).toLocaleString()} · email {submission.email_consent ? "opted in" : "not opted in"}</small></article>)}
        {!submissions.length && <div className="empty-state">No submissions recorded for this form.</div>}</aside></div>
  </main>;
}
