"use client";

import { FormEvent, useEffect, useState } from "react";

type Field = { key: string; label: string; type: "email" | "text" | "tel" | "textarea"; required: boolean };
type PublishedForm = { slug: string; version: number; title: string; description: string; fields: Field[]; consent_text: string; success_message: string };

export default function PublicForm({ slug }: { slug: string }) {
  const [form, setForm] = useState<PublishedForm | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [emailConsent, setEmailConsent] = useState(false);
  const [website, setWebsite] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/v1/public/forms/${encodeURIComponent(slug)}`, { credentials: "omit" }).then(async (response) => {
      const body = await response.json() as { form?: PublishedForm; error?: string };
      if (cancelled) return;
      if (!response.ok || !body.form) setError(body.error || "This form is not available."); else setForm(body.form);
    }).catch(() => { if (!cancelled) setError("This form could not be loaded."); });
    return () => { cancelled = true; };
  }, [slug]);

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setSending(true);
    try {
      const response = await fetch(`/v1/public/forms/${encodeURIComponent(slug)}/submissions`, {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "omit",
        body: JSON.stringify({ values, privacy_accepted: privacyAccepted, email_consent: emailConsent, website,
          idempotency_key: `public:${crypto.randomUUID()}` }),
      });
      const body = await response.json() as { error?: string; success_message?: string };
      if (!response.ok) { setError(body.error || "Your request could not be sent."); return; }
      setSuccess(body.success_message || form?.success_message || "Your request was received.");
    } catch { setError("Your request could not be sent. Check your connection and try again."); }
    finally { setSending(false); }
  }

  return <main className="public-form-page"><section className="public-form-card">
    <header><span>OPENOPERATOR / SECURE INTAKE</span><i aria-hidden="true">{form ? `V${form.version}` : "…"}</i></header>
    {success ? <div className="public-form-success" role="status"><b>✓</b><h1>Received.</h1><p>{success}</p></div> : <>
      <div className="public-form-intro"><p>DIRECT LINE</p><h1>{form?.title || "Loading form…"}</h1><p>{form?.description}</p></div>
      {error && <div className="public-form-error" role="alert">{error}</div>}
      {form && <form onSubmit={submit}>
        {form.fields.map((field) => <label key={field.key}>{field.label.toUpperCase()}{field.required && <b> REQUIRED</b>}
          {field.type === "textarea" ? <textarea required={field.required} maxLength={4000} value={values[field.key] || ""}
            onChange={(event) => setValues({ ...values, [field.key]: event.target.value })} /> :
            <input type={field.type} required={field.required} maxLength={field.key === "email" ? 254 : 200} value={values[field.key] || ""}
              onChange={(event) => setValues({ ...values, [field.key]: event.target.value })} />}</label>)}
        <input className="form-honeypot" tabIndex={-1} autoComplete="off" aria-hidden="true" value={website} onChange={(event) => setWebsite(event.target.value)} />
        <fieldset><legend>YOUR CHOICES</legend>
          <label className="public-form-check"><input type="checkbox" required checked={privacyAccepted} onChange={(event) => setPrivacyAccepted(event.target.checked)} />
            <span>I acknowledge that my information will be used to respond to this request. <b>Required.</b></span></label>
          <label className="public-form-check"><input type="checkbox" checked={emailConsent} onChange={(event) => setEmailConsent(event.target.checked)} />
            <span>{form.consent_text} <b>Optional.</b></span></label>
        </fieldset>
        <button type="submit" disabled={sending}>{sending ? "SENDING…" : "SEND REQUEST"}<span>→</span></button>
        <small>Protected by replay controls, rate limits, and versioned consent evidence.</small>
      </form>}
    </>}
  </section></main>;
}
