"use client";

import { FormEvent, useEffect, useState } from "react";

type Session = { business_name: string; review_url: string; already_submitted: boolean; privacy_text: string; review_policy: string };

export default function FeedbackClient() {
  const [token, setToken] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [rating, setRating] = useState(0);
  const [feedback, setFeedback] = useState("");
  const [privacy, setPrivacy] = useState(false);
  const [website, setWebsite] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "sending" | "done" | "error">("loading");
  const [message, setMessage] = useState("Checking your private feedback link…");
  const [idempotency] = useState(() => crypto.randomUUID());

  useEffect(() => {
    const credential = location.hash.slice(1);
    history.replaceState(null, "", "/feedback");
    const timer = setTimeout(() => {
      if (!credential) { setState("error"); setMessage("This feedback link is incomplete."); return; }
      setToken(credential);
      void fetch("/v1/public/reviews/session", { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: credential }) })
        .then(async (response) => {
          const body = await response.json() as { session?: Session; error?: string };
          if (!response.ok || !body.session) throw new Error(body.error || "This feedback link could not be verified.");
          setSession(body.session);
          setState(body.session.already_submitted ? "done" : "ready");
          setMessage(body.session.already_submitted ? "Feedback was already submitted from this link." : "Your response is private CRM data and is not posted to a public review site.");
        }).catch((cause) => { setState("error"); setMessage(cause instanceof Error ? cause.message : "This feedback link could not be verified."); });
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault(); if (!rating || !privacy) return; setState("sending");
    try {
      const response = await fetch("/v1/public/reviews/feedback", { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, rating, feedback, privacy_accepted: privacy, idempotency_key: idempotency, website }) });
      const body = await response.json() as { error?: string; review_url?: string };
      if (!response.ok) throw new Error(body.error || "Feedback could not be saved.");
      if (body.review_url && session) setSession({ ...session, review_url: body.review_url, already_submitted: true });
      setState("done"); setMessage("Your private feedback was saved. Thank you.");
    } catch (cause) { setState("ready"); setMessage(cause instanceof Error ? cause.message : "Feedback could not be saved."); }
  }

  return <main className={`feedback-page ${state}`}>
    <header><p>PRIVATE FEEDBACK</p><h1>{session?.business_name || "Share your experience"}</h1><span>{message}</span></header>
    {session && <>
      <aside><b>ONE FAIR PATH</b><span>{session.review_policy}</span><small>The public destination was supplied by the business and is not ownership-verified by OpenOperator.</small></aside>
      {state !== "done" && <form onSubmit={submit}>
        <fieldset><legend>How was your experience?</legend><div className="feedback-rating">{[1, 2, 3, 4, 5].map((value) => <button type="button" key={value} className={rating === value ? "active" : ""} aria-pressed={rating === value} onClick={() => setRating(value)}><b>{value}</b><small>{value === 1 ? "Poor" : value === 5 ? "Excellent" : ""}</small></button>)}</div></fieldset>
        <label>PRIVATE FEEDBACK <span>OPTIONAL</span><textarea maxLength={2000} rows={6} value={feedback} onChange={(event) => setFeedback(event.target.value)}/></label>
        <label className="feedback-privacy"><input type="checkbox" checked={privacy} onChange={(event) => setPrivacy(event.target.checked)}/><span>{session.privacy_text}</span></label>
        <label className="feedback-honeypot" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" name="website" value={website} onChange={(event) => setWebsite(event.target.value)}/></label>
        <button disabled={!rating || !privacy || state === "sending"}>{state === "sending" ? "SAVING…" : "SAVE PRIVATE FEEDBACK"}</button>
      </form>}
      <a className="public-review-link" href={session.review_url} target="_blank" rel="noopener noreferrer">LEAVE A PUBLIC REVIEW ↗</a>
      <small className="feedback-disclosure">This same public-review link is available to everyone, for every rating. Private feedback is never posted there automatically.</small>
    </>}
  </main>;
}
