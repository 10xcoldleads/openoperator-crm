"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

type TwilioConnection = {
  id: string; label: string; account_sid: string; auth_token_prefix: string; messaging_service_sid: string;
  status: "pending" | "active" | "error"; advanced_opt_out_status: "unverified" | "enabled" | "disabled";
  last_verified_at: string | null; last_error: string | null; revision: number;
  inbound_webhook_url: string; status_callback_url: string;
};
type TwilioData = { connection: TwilioConnection | null; runtime: { encryption_configured: boolean }; compliance: { note: string } };
type CustomValue = {
  id: string; value_key: string; label: string; value: string; folder: string | null; active: boolean; revision: number; token: string;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "include", ...init });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

export default function CrmMessagingSettings({ active, canAdmin }: { active: boolean; canAdmin: boolean }) {
  const [twilio, setTwilio] = useState<TwilioData | null>(null);
  const [values, setValues] = useState<CustomValue[]>([]);
  const [twilioDraft, setTwilioDraft] = useState({ label: "Twilio Messaging", account_sid: "", auth_token: "", messaging_service_sid: "" });
  const [advancedStatus, setAdvancedStatus] = useState<"unverified" | "enabled" | "disabled">("unverified");
  const [valueDraft, setValueDraft] = useState({ value_key: "", label: "", value: "", folder: "" });
  const [editing, setEditing] = useState<CustomValue | null>(null);
  const [working, setWorking] = useState("");
  const [disconnectArmed, setDisconnectArmed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const [twilioData, customData] = await Promise.all([
        api<TwilioData>("/v1/admin/twilio-connection"),
        api<{ values: CustomValue[] }>(`/v1/admin/custom-values${canAdmin ? "?include_archived=1" : ""}`),
      ]);
      setTwilio(twilioData); setValues(customData.values);
      if (twilioData.connection) setAdvancedStatus(twilioData.connection.advanced_opt_out_status);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Messaging configuration could not be loaded"); }
  }, [canAdmin]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [active, load]);

  const connectTwilio = async (event: FormEvent) => {
    event.preventDefault(); setWorking("connect"); setError(""); setNotice("");
    try {
      await api("/v1/admin/twilio-connection", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(twilioDraft) });
      setTwilioDraft({ ...twilioDraft, account_sid: "", auth_token: "", messaging_service_sid: "" });
      setNotice("Twilio credential encrypted. Verify the Account and Messaging Service before sending."); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Twilio could not be connected"); }
    finally { setWorking(""); }
  };

  const verifyTwilio = async () => {
    if (!twilio?.connection) return;
    setWorking("verify"); setError(""); setNotice("");
    try {
      await api("/v1/admin/twilio-connection/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        expected_revision: twilio.connection.revision, advanced_opt_out_status: advancedStatus,
      }) });
      setNotice("Twilio Account and Messaging Service verified. Configure the exact inbound webhook URL in Twilio."); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Twilio verification failed"); await load(); }
    finally { setWorking(""); }
  };

  const disconnectTwilio = async () => {
    if (!twilio?.connection) return;
    if (!disconnectArmed) { setDisconnectArmed(true); return; }
    setWorking("disconnect"); setError("");
    try {
      await api("/v1/admin/twilio-connection", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({
        expected_revision: twilio.connection.revision, confirmation: "DISCONNECT TWILIO",
      }) });
      setDisconnectArmed(false); setNotice("Local Twilio authority was cryptographically erased. Revoke the token in Twilio too."); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Twilio could not be disconnected"); }
    finally { setWorking(""); }
  };

  const createValue = async (event: FormEvent) => {
    event.preventDefault(); setWorking("value-create"); setError("");
    try {
      await api("/v1/admin/custom-values", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(valueDraft) });
      setValueDraft({ value_key: "", label: "", value: "", folder: "" }); setNotice("Reusable workspace value created."); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Custom value could not be created"); }
    finally { setWorking(""); }
  };

  const saveValue = async () => {
    if (!editing) return;
    setWorking(`value:${editing.id}`); setError("");
    try {
      await api(`/v1/admin/custom-values/${editing.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({
        label: editing.label, value: editing.value, folder: editing.folder, active: editing.active, if_revision: editing.revision,
      }) });
      setEditing(null); setNotice("Custom value updated. Future messages resolve the new literal value."); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Custom value could not be updated"); }
    finally { setWorking(""); }
  };

  if (!active) return null;
  return <section className="crm-messaging-settings" aria-labelledby="crm-messaging-title">
    <header><div><p className="eyebrow">CRM MESSAGING + VARIABLES</p><h2 id="crm-messaging-title">Twilio SMS and reusable workspace values.</h2>
      <small>Twilio secrets are encrypted. Custom values are member-visible literals, never secret storage.</small></div>
      <button type="button" className="secondary" onClick={() => void load()}>REFRESH</button></header>
    {error && <div className="conversation-banner error" role="alert">{error}</div>}
    {notice && <div className="conversation-banner success" role="status">{notice}</div>}
    <div className="crm-messaging-grid">
      <section className="twilio-configuration"><p className="eyebrow">TWILIO MESSAGING SERVICE</p>
        {twilio?.connection ? <article className="twilio-connection-card">
          <div><strong>{twilio.connection.label}</strong><mark>{twilio.connection.status.toUpperCase()}</mark></div>
          <dl><div><dt>ACCOUNT</dt><dd><code>{twilio.connection.account_sid}</code></dd></div>
            <div><dt>SERVICE</dt><dd><code>{twilio.connection.messaging_service_sid}</code></dd></div>
            <div><dt>TOKEN</dt><dd><code>{twilio.connection.auth_token_prefix}</code></dd></div>
            <div><dt>VERIFIED</dt><dd>{twilio.connection.last_verified_at ? new Date(twilio.connection.last_verified_at).toLocaleString() : "Not yet"}</dd></div></dl>
          <label>ADVANCED OPT-OUT CONSOLE STATE<select value={advancedStatus} onChange={(event) => setAdvancedStatus(event.target.value as typeof advancedStatus)}>
            <option value="unverified">Not checked</option><option value="enabled">Enabled in Twilio Console</option><option value="disabled">Disabled in Twilio Console</option></select></label>
          <small>{twilio.compliance.note}</small>
          <label>INBOUND MESSAGE WEBHOOK<input readOnly value={twilio.connection.inbound_webhook_url}/></label>
          <label>STATUS CALLBACK<input readOnly value={twilio.connection.status_callback_url}/></label>
          {twilio.connection.last_error && <p className="resend-provider-error">{twilio.connection.last_error}</p>}
          {canAdmin && <div className="twilio-actions"><button type="button" onClick={() => void verifyTwilio()} disabled={Boolean(working)}>
            {working === "verify" ? "VERIFYING…" : "VERIFY ACCOUNT + SERVICE"}</button>
            <button type="button" className={disconnectArmed ? "danger-action" : "secondary"} onClick={() => void disconnectTwilio()} disabled={Boolean(working)}>
              {working === "disconnect" ? "DISCONNECTING…" : disconnectArmed ? "CONFIRM DISCONNECT" : "DISCONNECT"}</button>
            {disconnectArmed && <button type="button" className="secondary" onClick={() => setDisconnectArmed(false)}>KEEP</button>}</div>}
        </article> : canAdmin ? <form className="twilio-setup-form" onSubmit={connectTwilio}>
          <label>LABEL<input required maxLength={80} value={twilioDraft.label} onChange={(event) => setTwilioDraft({ ...twilioDraft, label: event.target.value })}/></label>
          <label>ACCOUNT SID<input required autoComplete="off" pattern="AC[0-9a-fA-F]{32}" value={twilioDraft.account_sid} onChange={(event) => setTwilioDraft({ ...twilioDraft, account_sid: event.target.value.trim() })}/></label>
          <label>AUTH TOKEN<input required type="password" autoComplete="new-password" minLength={20} maxLength={128} value={twilioDraft.auth_token} onChange={(event) => setTwilioDraft({ ...twilioDraft, auth_token: event.target.value.trim() })}/></label>
          <label>MESSAGING SERVICE SID<input required autoComplete="off" pattern="MG[0-9a-fA-F]{32}" value={twilioDraft.messaging_service_sid} onChange={(event) => setTwilioDraft({ ...twilioDraft, messaging_service_sid: event.target.value.trim() })}/></label>
          <button type="submit" disabled={Boolean(working) || !twilio?.runtime.encryption_configured}>{working === "connect" ? "ENCRYPTING…" : "ENCRYPT + CONNECT"}</button>
        </form> : <div className="empty-state">An administrator must connect Twilio.</div>}
      </section>
      <section className="custom-values-configuration"><div><p className="eyebrow">CUSTOM VALUES</p><h3>One literal, reusable everywhere.</h3></div>
        <div className="custom-value-list">{values.map((item) => <article key={item.id} className={item.active ? "" : "archived"}>
          <div><strong>{item.label}</strong><mark>{item.active ? "ACTIVE" : "ARCHIVED"}</mark></div><code>{item.token}</code><p>{item.value}</p>
          <small>{item.folder || "Unfiled"}</small>{canAdmin && <button type="button" className="secondary" onClick={() => setEditing({ ...item })}>EDIT</button>}
        </article>)}{!values.length && <div className="empty-state">No workspace custom values yet.</div>}</div>
        {canAdmin && <form className="custom-value-form" onSubmit={createValue}>
          <label>KEY<input required pattern="[a-z][a-z0-9_]{1,59}" placeholder="company_phone" value={valueDraft.value_key} onChange={(event) => setValueDraft({ ...valueDraft, value_key: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") })}/></label>
          <label>LABEL<input required maxLength={80} value={valueDraft.label} onChange={(event) => setValueDraft({ ...valueDraft, label: event.target.value })}/></label>
          <label>LITERAL VALUE<textarea required maxLength={5000} value={valueDraft.value} onChange={(event) => setValueDraft({ ...valueDraft, value: event.target.value })}/></label>
          <label>FOLDER<input maxLength={80} value={valueDraft.folder} onChange={(event) => setValueDraft({ ...valueDraft, folder: event.target.value })}/></label>
          <button type="submit" disabled={Boolean(working)}>{working === "value-create" ? "CREATING…" : "CREATE CUSTOM VALUE"}</button>
        </form>}
      </section>
    </div>
    {editing && <div className="custom-value-editor" role="dialog" aria-modal="true" aria-labelledby="custom-value-editor-title">
      <section><h3 id="custom-value-editor-title">Edit {editing.token}</h3>
        <label>LABEL<input maxLength={80} value={editing.label} onChange={(event) => setEditing({ ...editing, label: event.target.value })}/></label>
        <label>LITERAL VALUE<textarea maxLength={5000} value={editing.value} onChange={(event) => setEditing({ ...editing, value: event.target.value })}/></label>
        <label>FOLDER<input maxLength={80} value={editing.folder || ""} onChange={(event) => setEditing({ ...editing, folder: event.target.value })}/></label>
        <label className="custom-value-active"><input type="checkbox" checked={editing.active} onChange={(event) => setEditing({ ...editing, active: event.target.checked })}/> Active</label>
        <div><button type="button" onClick={() => void saveValue()} disabled={Boolean(working)}>SAVE</button><button type="button" className="secondary" onClick={() => setEditing(null)}>CANCEL</button></div>
      </section>
    </div>}
  </section>;
}
