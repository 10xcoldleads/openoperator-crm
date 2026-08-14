"use client";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Item = {
  id: string;
  description: string;
  quantity: number;
  unit_amount_minor: number;
};
type Estimate = {
  id: string;
  contact_id: string;
  opportunity_id: string | null;
  estimate_number: string;
  title: string;
  seller_name: string;
  seller_email: string;
  currency: string;
  expires_on: string | null;
  notes: string;
  line_items: Item[];
  subtotal_minor: number;
  status: "draft" | "published" | "revoked";
  published_version_id: string | null;
  revision: number;
  contact_email?: string;
  contact_name?: string;
  opportunity_name?: string;
};
type Version = {
  id: string;
  estimate_id: string;
  version: number;
  published_at: string;
  published_by: string;
};
type Reply = {
  id: string;
  estimate_id: string;
  version_id: string;
  decision: "acknowledged" | "declined";
  typed_name: string;
  note: string | null;
  submitted_at: string;
};
type Contact = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
};
type Opportunity = {
  id: string;
  contact_id: string;
  name: string;
  currency: string;
  status: string;
};
type Data = {
  estimates: Estimate[];
  versions: Version[];
  responses: Reply[];
  links: { contacts: Contact[]; opportunities: Opportunity[] };
  boundaries: Record<string, boolean>;
};
type Draft = {
  contact_id: string;
  opportunity_id: string;
  title: string;
  seller_name: string;
  seller_email: string;
  currency: string;
  expires_on: string;
  notes: string;
  line_items: Item[];
};
const emptyDraft: Draft = {
  contact_id: "",
  opportunity_id: "",
  title: "",
  seller_name: "",
  seller_email: "",
  currency: "USD",
  expires_on: "",
  notes: "",
  line_items: [
    { id: "service_1", description: "", quantity: 1, unit_amount_minor: 0 },
  ],
};
async function api<T>(path: string, init?: RequestInit) {
  const response = await fetch(path, { credentials: "include", ...init });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}
const money = (minor: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
    minor / 100,
  );

export default function EstimatesWorkspace({
  active,
  canAdmin,
}: {
  active: boolean;
  canAdmin: boolean;
}) {
  const [data, setData] = useState<Data | null>(null),
    [selectedId, setSelectedId] = useState(""),
    [mode, setMode] = useState<"" | "create" | "edit">(""),
    [busy, setBusy] = useState(""),
    [armed, setArmed] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [oneTimeLink, setOneTimeLink] = useState("");
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const load = useCallback(async () => {
    const next = await api<Data>("/v1/admin/estimates");
    setData(next);
    setSelectedId((current) =>
      current && next.estimates.some((item) => item.id === current)
        ? current
        : next.estimates[0]?.id || "",
    );
  }, []);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(
      () => void load().catch((cause) => setError(cause.message)),
      0,
    );
    return () => clearTimeout(timer);
  }, [active, load]);
  const selected = useMemo(
    () => data?.estimates.find((item) => item.id === selectedId) || null,
    [data, selectedId],
  );
  const reply = data?.responses.find((item) => item.estimate_id === selectedId);
  const version = data?.versions.find(
    (item) => item.estimate_id === selectedId,
  );
  const opportunities = (data?.links.opportunities || []).filter(
    (item) => !draft.contact_id || item.contact_id === draft.contact_id,
  );
  function openEdit(item: Estimate) {
    setSelectedId(item.id);
    setDraft({
      contact_id: item.contact_id,
      opportunity_id: item.opportunity_id || "",
      title: item.title,
      seller_name: item.seller_name,
      seller_email: item.seller_email,
      currency: item.currency,
      expires_on: item.expires_on || "",
      notes: item.notes,
      line_items: item.line_items,
    });
    setMode("edit");
    setArmed("");
    setError("");
  }
  function updateItem(index: number, change: Partial<Item>) {
    setDraft((current) => ({
      ...current,
      line_items: current.line_items.map((item, i) =>
        i === index ? { ...item, ...change } : item,
      ),
    }));
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy("create");
    setError("");
    try {
      const body = await api<{ estimate: Estimate }>("/v1/admin/estimates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contact_id: draft.contact_id,
          opportunity_id: draft.opportunity_id || undefined,
          title: draft.title,
          seller_name: draft.seller_name,
          seller_email: draft.seller_email,
          currency: draft.currency,
        }),
      });
      await load();
      openEdit(body.estimate);
      setNotice(
        "Draft created. Add at least one positive line item before publishing.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Create failed");
    } finally {
      setBusy("");
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy("save");
    setError("");
    try {
      await api(`/v1/admin/estimates/${selected.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...draft,
          opportunity_id: draft.opportunity_id || null,
          expires_on: draft.expires_on || null,
          if_revision: selected.revision,
        }),
      });
      setMode("");
      await load();
      setNotice("Draft saved with deterministic minor-unit totals.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Save failed");
      await load().catch(() => undefined);
    } finally {
      setBusy("");
    }
  }
  async function lifecycle(kind: "publish" | "revoke", item: Estimate) {
    const key = `${kind}:${item.id}`;
    if (armed !== key) {
      setArmed(key);
      return;
    }
    setBusy(key);
    setError("");
    try {
      const body = await api<{
        estimate: Estimate;
        access?: {
          public_path: string;
          shown_once: boolean;
          automatic_delivery: boolean;
        };
      }>(`/v1/admin/estimates/${item.id}/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          if_revision: item.revision,
          confirmation:
            kind === "publish" ? "PUBLISH ESTIMATE" : "REVOKE ESTIMATE",
        }),
      });
      setArmed("");
      if (body.access) {
        setOneTimeLink(`${location.origin}${body.access.public_path}`);
        setNotice(
          "Published. This private link is shown once and is not emailed automatically.",
        );
      } else {
        setOneTimeLink("");
        setNotice(
          "Public access revoked immediately; immutable history remains.",
        );
      }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Action failed");
      await load().catch(() => undefined);
    } finally {
      setBusy("");
    }
  }
  if (!active) return null;
  return (
    <main className="estimates-workspace">
      <header className="estimates-hero">
        <div>
          <p>IMMUTABLE COMMERCIAL EVIDENCE</p>
          <h1>Estimates</h1>
          <span>
            Draft, publish one frozen version, collect one acknowledgement or
            decline, and revoke access.
          </span>
        </div>
        {canAdmin && (
          <button
            onClick={() => {
              setDraft(emptyDraft);
              setMode("create");
              setSelectedId("");
              setArmed("");
            }}
          >
            NEW ESTIMATE
          </button>
        )}
      </header>
      {error && <div className="conversation-banner error">{error}</div>}
      {notice && <div className="conversation-banner">{notice}</div>}
      <section className="estimates-boundary">
        <b>NOT A SIGNATURE OR INVOICE</b>
        <small>
          Acknowledgement confirms receipt only. No e-signature, contract
          execution, tax calculation, invoice, checkout, payment provider, PDF,
          or automatic delivery is included.
        </small>
      </section>
      {oneTimeLink && (
        <section
          className="estimate-secret"
          aria-label="One-time estimate link"
        >
          <div>
            <b>PRIVATE LINK · SHOWN ONCE</b>
            <code>{oneTimeLink}</code>
            <small>
              Store it securely. The raw credential is not recoverable from the
              CRM.
            </small>
          </div>
          <button
            onClick={() => void navigator.clipboard.writeText(oneTimeLink)}
          >
            COPY LINK
          </button>
          <a href={oneTimeLink} target="_blank" rel="noopener noreferrer">
            OPEN
          </a>
          <button onClick={() => setOneTimeLink("")}>I SAVED IT</button>
        </section>
      )}
      {(mode === "create" || mode === "edit") && (
        <form
          className="estimate-editor"
          onSubmit={mode === "create" ? create : save}
        >
          <header>
            <h2>
              {mode === "create"
                ? "Create estimate draft"
                : selected?.estimate_number}
            </h2>
            <small>
              Prices are entered in minor units (for USD, 12550 = $125.50).
            </small>
          </header>
          <div className="estimate-fields">
            <label>
              CONTACT
              <select
                required
                value={draft.contact_id}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    contact_id: e.target.value,
                    opportunity_id: "",
                  })
                }
              >
                <option value="">Select</option>
                {data?.links.contacts.map((item) => (
                  <option key={item.id} value={item.id}>
                    {[item.first_name, item.last_name]
                      .filter(Boolean)
                      .join(" ") || item.email}{" "}
                    · {item.email}
                  </option>
                ))}
              </select>
            </label>
            <label>
              OPPORTUNITY
              <select
                value={draft.opportunity_id}
                onChange={(e) =>
                  setDraft({ ...draft, opportunity_id: e.target.value })
                }
              >
                <option value="">None</option>
                {opportunities.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.status}
                  </option>
                ))}
              </select>
            </label>
            <label>
              TITLE
              <input
                required
                maxLength={160}
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </label>
            <label>
              SELLER NAME
              <input
                required
                maxLength={160}
                value={draft.seller_name}
                onChange={(e) =>
                  setDraft({ ...draft, seller_name: e.target.value })
                }
              />
            </label>
            <label>
              SELLER EMAIL
              <input
                required
                type="email"
                maxLength={254}
                value={draft.seller_email}
                onChange={(e) =>
                  setDraft({ ...draft, seller_email: e.target.value })
                }
              />
            </label>
            <label>
              CURRENCY
              <input
                required
                pattern="[A-Za-z]{3}"
                maxLength={3}
                value={draft.currency}
                onChange={(e) =>
                  setDraft({ ...draft, currency: e.target.value.toUpperCase() })
                }
              />
            </label>
            <label>
              EXPIRES
              <input
                type="date"
                value={draft.expires_on}
                onChange={(e) =>
                  setDraft({ ...draft, expires_on: e.target.value })
                }
              />
            </label>
          </div>
          {mode === "edit" && (
            <fieldset className="estimate-items">
              <legend>LINE ITEMS · 1–50</legend>
              {draft.line_items.map((item, index) => (
                <div key={item.id}>
                  <label>
                    DESCRIPTION
                    <input
                      required
                      maxLength={160}
                      value={item.description}
                      onChange={(e) =>
                        updateItem(index, { description: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    QUANTITY
                    <input
                      required
                      type="number"
                      min={1}
                      max={100000}
                      value={item.quantity}
                      onChange={(e) =>
                        updateItem(index, { quantity: Number(e.target.value) })
                      }
                    />
                  </label>
                  <label>
                    UNIT MINOR
                    <input
                      required
                      type="number"
                      min={1}
                      max={1000000000000}
                      value={item.unit_amount_minor}
                      onChange={(e) =>
                        updateItem(index, {
                          unit_amount_minor: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                  {draft.line_items.length > 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          line_items: draft.line_items.filter(
                            (_, i) => i !== index,
                          ),
                        })
                      }
                    >
                      REMOVE
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                disabled={draft.line_items.length >= 50}
                onClick={() => {
                  setDraft({
                    ...draft,
                    line_items: [
                      ...draft.line_items,
                      {
                        id: `item_${crypto.randomUUID().replaceAll("-", "")}`,
                        description: "",
                        quantity: 1,
                        unit_amount_minor: 0,
                      },
                    ],
                  });
                }}
              >
                ADD LINE
              </button>
            </fieldset>
          )}
          <label>
            NOTES
            <textarea
              rows={5}
              maxLength={4000}
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            />
          </label>
          <footer>
            <button disabled={!!busy}>
              {mode === "create" ? "CREATE DRAFT" : "SAVE DRAFT"}
            </button>
            <button type="button" onClick={() => setMode("")}>
              CANCEL
            </button>
          </footer>
        </form>
      )}
      <div className="estimates-layout">
        <section className="estimate-register">
          <header>
            <b>REGISTER</b>
            <small>{data?.estimates.length || 0} records</small>
          </header>
          {data?.estimates.map((item) => (
            <button
              key={item.id}
              className={selectedId === item.id ? "active" : ""}
              onClick={() => {
                setSelectedId(item.id);
                setMode("");
                setArmed("");
              }}
            >
              <span>
                <b>{item.estimate_number}</b>
                <small>
                  {item.title} · {item.contact_name || item.contact_email}
                </small>
              </span>
              <strong>{money(item.subtotal_minor, item.currency)}</strong>
              <mark>{item.status}</mark>
            </button>
          ))}
          {!data?.estimates.length && <p>No estimates yet.</p>}
        </section>
        {selected && (
          <section className="estimate-detail">
            <header>
              <div>
                <p>
                  {selected.estimate_number} · REVISION {selected.revision}
                </p>
                <h2>{selected.title}</h2>
                <small>
                  {selected.contact_name || selected.contact_email} ·{" "}
                  {selected.opportunity_name || "No opportunity"}
                </small>
              </div>
              <mark>{selected.status}</mark>
            </header>
            <dl>
              <div>
                <dt>SELLER</dt>
                <dd>
                  {selected.seller_name}
                  <small>{selected.seller_email}</small>
                </dd>
              </div>
              <div>
                <dt>EXPIRY</dt>
                <dd>{selected.expires_on || "No expiry"}</dd>
              </div>
              <div>
                <dt>PUBLICATION</dt>
                <dd>
                  {version
                    ? `V${version.version} · ${new Date(version.published_at).toLocaleString()}`
                    : "Draft not published"}
                </dd>
              </div>
              <div>
                <dt>RESPONSE</dt>
                <dd>
                  {reply ? (
                    <>
                      {reply.decision}
                      <small>
                        {reply.typed_name} ·{" "}
                        {new Date(reply.submitted_at).toLocaleString()}
                      </small>
                    </>
                  ) : (
                    "No response"
                  )}
                </dd>
              </div>
            </dl>
            <div className="estimate-lines">
              {selected.line_items.map((item) => (
                <div key={item.id}>
                  <span>
                    <b>{item.description}</b>
                    <small>
                      {item.quantity} ×{" "}
                      {money(item.unit_amount_minor, selected.currency)}
                    </small>
                  </span>
                  <strong>
                    {money(
                      item.quantity * item.unit_amount_minor,
                      selected.currency,
                    )}
                  </strong>
                </div>
              ))}
              <footer>
                <b>SUBTOTAL</b>
                <strong>
                  {money(selected.subtotal_minor, selected.currency)}
                </strong>
              </footer>
            </div>
            {selected.notes && (
              <p className="estimate-notes">{selected.notes}</p>
            )}
            {canAdmin && (
              <div className="estimate-actions">
                {selected.status === "draft" && (
                  <>
                    <button onClick={() => openEdit(selected)}>
                      EDIT DRAFT
                    </button>
                    <button
                      disabled={!!busy || selected.subtotal_minor <= 0}
                      onClick={() => void lifecycle("publish", selected)}
                    >
                      {armed === `publish:${selected.id}`
                        ? "CONFIRM PUBLISH"
                        : "PUBLISH FROZEN V1"}
                    </button>
                  </>
                )}
                {selected.status === "published" && (
                  <button
                    disabled={!!busy}
                    onClick={() => void lifecycle("revoke", selected)}
                  >
                    {armed === `revoke:${selected.id}`
                      ? "CONFIRM REVOKE"
                      : "REVOKE PUBLIC ACCESS"}
                  </button>
                )}
                {armed && (
                  <button onClick={() => setArmed("")}>
                    KEEP CURRENT STATE
                  </button>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
