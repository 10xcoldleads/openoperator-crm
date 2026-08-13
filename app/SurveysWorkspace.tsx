"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Question = { id: string; label: string; type: "short_text" | "long_text" | "email" | "single_choice" | "multi_choice" | "rating"; required: boolean; options: string[] };
type Survey = { id: string; name: string; slug: string; status: "draft" | "published" | "revoked"; title: string; description: string; questions: Question[]; success_message: string; public_path: string | null; revision: number; response_count?: number };
type Summary = { question_id: string; label: string; type: string; answered: number; counts: Array<{ option: string; count: number }> | null; average: number | null };
type Ledger = { responses: Array<{ id: string; version: number; answers: Record<string, unknown>; submitted_at: string; duration_seconds: number | null }>; version_summaries: Array<{ version: number; response_count: number; summary: Summary[] }> };

async function api<T>(path: string, init?: RequestInit) {
  const response = await fetch(path, { credentials: "include", ...init });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

export default function SurveysWorkspace({ active, canAdmin }: { active: boolean; canAdmin: boolean }) {
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<Survey | null>(null);
  const [ledger, setLedger] = useState<Ledger>({ responses: [], version_summaries: [] });
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [armed, setArmed] = useState("");
  const selected = useMemo(() => surveys.find((row) => row.id === selectedId), [surveys, selectedId]);

  const load = useCallback(async () => {
    const data = await api<{ surveys: Survey[] }>("/v1/admin/surveys");
    setSurveys(data.surveys);
    setSelectedId((current) => current && data.surveys.some((row) => row.id === current) ? current : data.surveys[0]?.id || "");
  }, []);

  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => void load().catch((cause) => setError(cause.message)), 0);
    return () => clearTimeout(timer);
  }, [active, load]);

  useEffect(() => {
    if (!active || !selectedId) return;
    let cancelled = false;
    void Promise.all([
      api<{ survey: Survey }>(`/v1/admin/surveys/${selectedId}`),
      api<Ledger>(`/v1/admin/surveys/${selectedId}/responses`),
    ]).then(([detail, responses]) => {
      if (!cancelled) { setDraft(detail.survey); setLedger(responses); }
    }).catch((cause) => { if (!cancelled) setError(cause.message); });
    return () => { cancelled = true; };
  }, [active, selectedId]);

  async function create(event: FormEvent) {
    event.preventDefault(); setWorking("create"); setError("");
    try {
      const data = await api<{ survey: Survey }>("/v1/admin/surveys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: newName, title: newTitle }) });
      setCreating(false); setNewName(""); setNewTitle(""); await load(); setSelectedId(data.survey.id); setNotice("Survey draft created.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Survey could not be created"); }
    finally { setWorking(""); }
  }

  async function save() {
    if (!draft) return; setWorking("save"); setError("");
    try {
      const data = await api<{ survey: Survey }>(`/v1/admin/surveys/${draft.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: draft.name, title: draft.title, description: draft.description, questions: draft.questions, success_message: draft.success_message, if_revision: draft.revision }) });
      setDraft(data.survey); await load(); setNotice("Draft saved. The published version did not change.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Survey could not be saved"); }
    finally { setWorking(""); }
  }

  async function lifecycle(action: "publish" | "revoke") {
    if (!draft) return;
    if (armed !== action) { setArmed(action); return; }
    setWorking(action); setError("");
    try {
      const data = await api<{ survey: Survey }>(`/v1/admin/surveys/${draft.id}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ if_revision: draft.revision, confirmation: action === "publish" ? "PUBLISH SURVEY" : "REVOKE SURVEY" }) });
      setDraft(data.survey); setArmed(""); await load(); setNotice(action === "publish" ? "Published as a new immutable version." : "Public survey access revoked.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Survey lifecycle failed"); }
    finally { setWorking(""); }
  }

  function updateQuestion(index: number, patch: Partial<Question>) {
    if (draft) setDraft({ ...draft, questions: draft.questions.map((question, position) => position === index ? { ...question, ...patch } : question) });
  }
  if (!active) return null;

  return <main className="surveys-workspace">
    <header className="surveys-hero"><div><p>VERSIONED FIELD RESEARCH</p><h1>Surveys</h1><span>Ask one clear question at a time. Published questions freeze; every response keeps the exact version it answered.</span></div>{canAdmin && <button onClick={() => setCreating(true)}>NEW SURVEY</button>}</header>
    {error && <div className="conversation-banner error">{error}</div>}{notice && <div className="conversation-banner">{notice}</div>}
    {creating && <form className="survey-create" onSubmit={create}><label>INTERNAL NAME<input required value={newName} onChange={(event) => setNewName(event.target.value)}/></label><label>PUBLIC TITLE<input required value={newTitle} onChange={(event) => setNewTitle(event.target.value)}/></label><button disabled={working === "create"}>CREATE DRAFT</button><button type="button" onClick={() => setCreating(false)}>CANCEL</button></form>}
    <div className="survey-admin-layout">
      <aside className="survey-index"><header><b>SURVEY REGISTER</b><small>{surveys.length} total</small></header>{surveys.map((survey) => <button key={survey.id} className={selectedId === survey.id ? "active" : ""} onClick={() => setSelectedId(survey.id)}><b>{survey.name}</b><span>{survey.status} · {survey.response_count || 0} responses</span></button>)}{!surveys.length && <p>No surveys yet.</p>}</aside>
      <section className="survey-blueprint">{draft && selected ? <>
        <header><div><p>SURVEY / {draft.slug}</p><h2>{draft.name}</h2></div><mark>{draft.status}</mark></header>
        <div className="survey-settings"><label>INTERNAL NAME<input disabled={!canAdmin} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })}/></label><label>PUBLIC TITLE<input disabled={!canAdmin} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })}/></label><label className="wide">INTRODUCTION<textarea disabled={!canAdmin} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })}/></label></div>
        <div className="survey-question-editor"><header><b>QUESTION SEQUENCE</b>{canAdmin && draft.questions.length < 30 && <button onClick={() => setDraft({ ...draft, questions: [...draft.questions, { id: `question_${draft.questions.length + 1}`, label: "New question", type: "short_text", required: false, options: [] }] })}>+ ADD QUESTION</button>}</header>
          {draft.questions.map((question, index) => <article key={`${question.id}:${index}`}><span>{String(index + 1).padStart(2, "0")}</span><label>QUESTION<input disabled={!canAdmin} value={question.label} onChange={(event) => updateQuestion(index, { label: event.target.value })}/></label><label>STABLE ID<input disabled={!canAdmin} value={question.id} onChange={(event) => updateQuestion(index, { id: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })}/></label><label>TYPE<select disabled={!canAdmin} value={question.type} onChange={(event) => { const type = event.target.value as Question["type"]; updateQuestion(index, { type, options: ["single_choice", "multi_choice"].includes(type) ? question.options.length >= 2 ? question.options : ["Option one", "Option two"] : [] }); }}>{["short_text", "long_text", "email", "single_choice", "multi_choice", "rating"].map((type) => <option key={type} value={type}>{type.replaceAll("_", " ")}</option>)}</select></label><label className="required"><input type="checkbox" disabled={!canAdmin} checked={question.required} onChange={(event) => updateQuestion(index, { required: event.target.checked })}/> REQUIRED</label>{["single_choice", "multi_choice"].includes(question.type) && <label className="options">OPTIONS<textarea disabled={!canAdmin} value={question.options.join("\n")} onChange={(event) => updateQuestion(index, { options: event.target.value.split("\n").map((value) => value.trim()).filter(Boolean) })}/></label>}{canAdmin && draft.questions.length > 1 && <button className="remove" onClick={() => setDraft({ ...draft, questions: draft.questions.filter((_, position) => position !== index) })}>REMOVE</button>}</article>)}
        </div>
        <label className="survey-success-copy">SUCCESS MESSAGE<input disabled={!canAdmin} value={draft.success_message} onChange={(event) => setDraft({ ...draft, success_message: event.target.value })}/></label>
        <footer>{canAdmin && <><button onClick={() => void save()}>SAVE DRAFT</button><button onClick={() => void lifecycle("publish")}>{armed === "publish" ? "CONFIRM PUBLISH SURVEY" : "PUBLISH"}</button>{draft.status === "published" && <button onClick={() => void lifecycle("revoke")}>{armed === "revoke" ? "CONFIRM REVOKE SURVEY" : "REVOKE"}</button>}</>}{draft.public_path && <a href={draft.public_path} target="_blank">OPEN PUBLIC SURVEY ↗</a>}</footer>
      </> : <p>Select a survey.</p>}</section>
      <aside className="survey-results"><header><b>RESPONSE EVIDENCE</b><small>{ledger.responses.length} shown</small></header>{ledger.version_summaries.map((group) => <section key={group.version}><h3>VERSION {group.version} · {group.response_count} RESPONSES</h3>{group.summary.map((row) => <article key={row.question_id}><b>{row.label}</b><span>{row.answered} answered</span>{row.average !== null && <strong>{row.average.toFixed(1)} / 5</strong>}{row.counts?.map((count) => <small key={count.option}>{count.option} · {count.count}</small>)}</article>)}</section>)}{ledger.responses.length > 0 && <section className="survey-response-ledger"><h3>RECENT IMMUTABLE RESPONSES</h3>{ledger.responses.slice(0, 20).map((response) => <details key={response.id}><summary>{new Date(response.submitted_at).toLocaleString()} · V{response.version}{response.duration_seconds !== null ? ` · ${response.duration_seconds}s` : ""}</summary><dl>{Object.entries(response.answers).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{Array.isArray(value) ? value.join(", ") : String(value)}</dd></div>)}</dl></details>)}</section>}{!ledger.version_summaries.length && <p>No responses yet.</p>}</aside>
    </div>
  </main>;
}
