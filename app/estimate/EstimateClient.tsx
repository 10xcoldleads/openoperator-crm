"use client";
import { FormEvent, useEffect, useRef, useState } from "react";
type Item = {
  id: string;
  description: string;
  quantity: number;
  unit_amount_minor: number;
};
type Estimate = {
  estimate_number: string;
  title: string;
  seller_name: string;
  seller_email: string;
  recipient_name: string;
  recipient_email: string;
  currency: string;
  expires_on: string | null;
  notes: string;
  line_items: Item[];
  subtotal_minor: number;
  published_at: string;
};
type Reply = {
  decision: string;
  typed_name: string;
  note: string | null;
  submitted_at: string;
};
const money = (minor: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
    minor / 100,
  );
export default function EstimateClient() {
  const idempotencyKey = useRef(crypto.randomUUID());
  const [token, setToken] = useState(""),
    [estimate, setEstimate] = useState<Estimate | null>(null),
    [reply, setReply] = useState<Reply | null>(null),
    [disclosure, setDisclosure] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [form, setForm] = useState({
      decision: "acknowledged",
      typed_name: "",
      note: "",
      privacy_accepted: false,
      website: "",
    });
  useEffect(() => {
    const timer = setTimeout(() => {
      const raw = location.hash.slice(1);
      history.replaceState(null, "", "/estimate");
      if (!raw) {
        setError("This private estimate link is missing.");
        return;
      }
      setToken(raw);
      void fetch("/v1/public/estimates/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: raw }),
      })
        .then(async (response) => {
          const body = (await response.json()) as {
            error?: string;
            estimate: Estimate;
            response: Reply | null;
            disclosure: string;
          };
          if (!response.ok)
            throw new Error(body.error || "Estimate unavailable");
          setEstimate(body.estimate);
          setReply(body.response);
          setDisclosure(body.disclosure);
        })
        .catch((cause) => setError(cause.message));
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/v1/public/estimates/respond", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...form,
          token,
          idempotency_key: idempotencyKey.current,
        }),
      });
      const body = (await response.json()) as { error?: string; response: Reply };
      if (!response.ok) throw new Error(body.error || "Response failed");
      setReply(body.response);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Response failed");
    } finally {
      setBusy(false);
    }
  }
  if (error && !estimate)
    return (
      <main className="public-estimate-state">
        <h1>Estimate unavailable.</h1>
        <p>{error}</p>
      </main>
    );
  if (!estimate)
    return (
      <main className="public-estimate-state">
        <h1>Opening private estimate…</h1>
      </main>
    );
  return (
    <main className="public-estimate">
      <header>
        <div>
          <p>{estimate.estimate_number} · FROZEN</p>
          <h1>{estimate.title}</h1>
          <span>Prepared for {estimate.recipient_name}</span>
        </div>
        <strong>{money(estimate.subtotal_minor, estimate.currency)}</strong>
      </header>
      <section className="public-estimate-parties">
        <div>
          <b>FROM</b>
          <span>{estimate.seller_name}</span>
          <a href={`mailto:${estimate.seller_email}`}>
            {estimate.seller_email}
          </a>
        </div>
        <div>
          <b>TO</b>
          <span>{estimate.recipient_name}</span>
          <small>{estimate.recipient_email}</small>
        </div>
        <div>
          <b>EXPIRES</b>
          <span>{estimate.expires_on || "No expiry stated"}</span>
          <small>
            Published {new Date(estimate.published_at).toLocaleDateString()}
          </small>
        </div>
      </section>
      <section className="public-estimate-lines">
        {estimate.line_items.map((item) => (
          <div key={item.id}>
            <span>
              <b>{item.description}</b>
              <small>
                {item.quantity} ×{" "}
                {money(item.unit_amount_minor, estimate.currency)}
              </small>
            </span>
            <strong>
              {money(item.quantity * item.unit_amount_minor, estimate.currency)}
            </strong>
          </div>
        ))}
        <footer>
          <b>SUBTOTAL</b>
          <strong>{money(estimate.subtotal_minor, estimate.currency)}</strong>
        </footer>
      </section>
      {estimate.notes && (
        <section className="public-estimate-notes">
          <b>NOTES</b>
          <p>{estimate.notes}</p>
        </section>
      )}
      <aside>
        <b>RECEIPT, NOT SIGNATURE</b>
        <p>{disclosure}</p>
      </aside>
      {reply ? (
        <section className="public-estimate-complete">
          <b>RESPONSE RECORDED</b>
          <h2>{reply.decision}</h2>
          <p>
            {reply.typed_name} · {new Date(reply.submitted_at).toLocaleString()}
          </p>
          {reply.note && <small>{reply.note}</small>}
        </section>
      ) : (
        <form onSubmit={submit}>
          <h2>Confirm receipt</h2>
          <p>
            This response does not sign a contract, accept legal terms, or
            authorize payment.
          </p>
          <div role="group" aria-label="Estimate response">
            <label>
              <input
                type="radio"
                name="decision"
                value="acknowledged"
                checked={form.decision === "acknowledged"}
                onChange={(e) => setForm({ ...form, decision: e.target.value })}
              />{" "}
              ACKNOWLEDGED
            </label>
            <label>
              <input
                type="radio"
                name="decision"
                value="declined"
                checked={form.decision === "declined"}
                onChange={(e) => setForm({ ...form, decision: e.target.value })}
              />{" "}
              DECLINED
            </label>
          </div>
          <label>
            YOUR FULL NAME
            <input
              required
              maxLength={160}
              value={form.typed_name}
              onChange={(e) => setForm({ ...form, typed_name: e.target.value })}
            />
          </label>
          <label>
            OPTIONAL NOTE
            <textarea
              rows={4}
              maxLength={2000}
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            />
          </label>
          <label className="estimate-privacy">
            <input
              required
              type="checkbox"
              checked={form.privacy_accepted}
              onChange={(e) =>
                setForm({ ...form, privacy_accepted: e.target.checked })
              }
            />
            <span>
              I understand my name, decision, note, time, and bounded request
              metadata will be stored privately as receipt evidence.
            </span>
          </label>
          <label className="estimate-honeypot" aria-hidden="true">
            Website
            <input
              tabIndex={-1}
              autoComplete="off"
              value={form.website}
              onChange={(e) => setForm({ ...form, website: e.target.value })}
            />
          </label>
          {error && <div className="conversation-banner error">{error}</div>}
          <button disabled={busy}>
            {busy ? "RECORDING…" : "RECORD RESPONSE"}
          </button>
        </form>
      )}
    </main>
  );
}
