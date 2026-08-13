"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Slot = { starts_at: string; ends_at: string };
type Calendar = { slug: string; title: string; description: string; timezone: string; duration_minutes: number };

export default function PublicBooking({ slug }: { slug: string }) {
  const [calendar, setCalendar] = useState<Calendar | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [phone, setPhone] = useState("");
  const [privacy, setPrivacy] = useState(false); const [website, setWebsite] = useState("");
  const [error, setError] = useState(""); const [sending, setSending] = useState(false); const [manageLink, setManageLink] = useState("");

  function load() {
    void fetch(`/v1/public/booking/${encodeURIComponent(slug)}?days=14`, { credentials: "omit" }).then(async (response) => {
      const body = await response.json() as { calendar?: Calendar; slots?: Slot[]; error?: string };
      if (!response.ok || !body.calendar) throw new Error(body.error || "This calendar is unavailable.");
      setCalendar(body.calendar); setSlots(body.slots || []);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "This calendar could not be loaded."));
  }
  useEffect(() => {
    let cancelled = false;
    void fetch(`/v1/public/booking/${encodeURIComponent(slug)}?days=14`, { credentials: "omit" }).then(async (response) => {
      const body = await response.json() as { calendar?: Calendar; slots?: Slot[]; error?: string };
      if (!response.ok || !body.calendar) throw new Error(body.error || "This calendar is unavailable.");
      if (!cancelled) { setCalendar(body.calendar); setSlots(body.slots || []); }
    }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "This calendar could not be loaded."); });
    return () => { cancelled = true; };
  }, [slug]);
  const days = useMemo(() => Object.entries(slots.reduce<Record<string, Slot[]>>((result, slot) => {
    const key = new Intl.DateTimeFormat("en-CA", { timeZone: calendar?.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(slot.starts_at));
    (result[key] ||= []).push(slot); return result;
  }, {})), [slots, calendar?.timezone]);
  function slotLabel(value: string, options: Intl.DateTimeFormatOptions) {
    return new Intl.DateTimeFormat("en-US", { timeZone: calendar?.timezone, ...options }).format(new Date(value));
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setSending(true);
    try {
      const response = await fetch(`/v1/public/booking/${encodeURIComponent(slug)}/appointments`, {
        method: "POST", credentials: "omit", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, phone: phone || undefined, visitor_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          starts_at: selected, privacy_accepted: privacy, website, idempotency_key: `booking:${crypto.randomUUID()}` }),
      });
      const body = await response.json() as { error?: string; manage_token?: string };
      if (!response.ok || !body.manage_token) throw new Error(body.error || "The booking could not be completed.");
      const link = `${location.origin}/book/${encodeURIComponent(slug)}/manage#token=${encodeURIComponent(body.manage_token)}`;
      setManageLink(link); setSlots([]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The booking could not be completed."); load(); }
    finally { setSending(false); }
  }
  return <main className="booking-page"><section className="booking-shell">
    <header><span>OPENOPERATOR / APPOINTMENT DESK</span><i>{calendar ? `${calendar.duration_minutes} MIN` : "LOADING"}</i></header>
    {manageLink ? <div className="booking-confirmation" role="status"><span>CONFIRMED</span><h1>Your time is reserved.</h1><p>Keep this private link to reschedule or cancel your appointment.</p><a href={manageLink}>MANAGE APPOINTMENT <b>→</b></a></div> : <>
      <div className="booking-intro"><p>AVAILABLE TIME / {calendar?.timezone || "—"}</p><h1>{calendar?.title || "Loading calendar…"}</h1><p>{calendar?.description}</p></div>
      {error && <div className="public-form-error" role="alert">{error}</div>}
      {calendar && <div className="booking-grid"><section className="booking-slots" aria-label="Available appointment times">
        {days.length ? days.map(([day, daySlots]) => <div className="booking-day" key={day}><h2>{slotLabel(daySlots[0].starts_at, { weekday: "short", month: "short", day: "numeric" })}</h2>
          <div>{daySlots.map((slot) => <button type="button" aria-pressed={selected === slot.starts_at} className={selected === slot.starts_at ? "selected" : ""} key={slot.starts_at} onClick={() => setSelected(slot.starts_at)}>
            {slotLabel(slot.starts_at, { hour: "numeric", minute: "2-digit" })}</button>)}</div></div>) : <p className="booking-empty">No open times in the next 14 days.</p>}
      </section><form onSubmit={submit}>
        <div className="booking-ticket"><small>SELECTED APPOINTMENT</small><strong>{selected ? slotLabel(selected, { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Choose a time"}</strong><span>{calendar.timezone}</span></div>
        <label>NAME <b>REQUIRED</b><input required maxLength={160} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>EMAIL <b>REQUIRED</b><input required type="email" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>PHONE <input type="tel" maxLength={50} value={phone} onChange={(event) => setPhone(event.target.value)} /></label>
        <input className="form-honeypot" tabIndex={-1} autoComplete="off" aria-hidden="true" value={website} onChange={(event) => setWebsite(event.target.value)} />
        <label className="public-form-check"><input required type="checkbox" checked={privacy} onChange={(event) => setPrivacy(event.target.checked)} /><span>I agree that my information will be used to schedule and manage this appointment. <b>Required.</b></span></label>
        <button disabled={!selected || sending}>{sending ? "RESERVING…" : "RESERVE TIME"}<span>→</span></button>
        <small>No marketing consent is requested by this booking form.</small>
      </form></div>}
    </>}
  </section></main>;
}
