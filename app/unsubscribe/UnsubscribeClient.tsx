"use client";

import { useEffect, useState } from "react";

export default function UnsubscribeClient() {
  const [state, setState] = useState<"working" | "done" | "error">("working"), [message, setMessage] = useState("Applying your request…");
  useEffect(() => { const token = location.hash.slice(1); const timer = setTimeout(() => { if (!token) { setState("error"); setMessage("This unsubscribe link is incomplete."); return; }
    void fetch("/v1/public/marketing/unsubscribe", { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })
      .then(async (response) => { const body = await response.json() as { message?: string; error?: string }; history.replaceState(null, "", "/unsubscribe"); if (!response.ok) throw new Error(body.error || "The request could not be completed."); setState("done"); setMessage(body.message || "You have been unsubscribed."); })
      .catch((cause) => { history.replaceState(null, "", "/unsubscribe"); setState("error"); setMessage(cause instanceof Error ? cause.message : "The request could not be completed."); }); }, 0); return () => clearTimeout(timer); }, []);
  return <main className={`unsubscribe-result ${state}`}><p>OPENOPERATOR EMAIL PREFERENCES</p><h1>{state === "working" ? "One moment." : state === "done" ? "You’re unsubscribed." : "We could not verify that link."}</h1><span>{message}</span><small>This page changes review-request and marketing email permission only. It does not delete CRM, service, or private-feedback records.</small></main>;
}
