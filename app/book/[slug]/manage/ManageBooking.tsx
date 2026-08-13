"use client";

import { useEffect, useState } from "react";

type Appointment = { id: string; starts_at: string; ends_at: string; status: string; revision: number };
type Calendar = { slug: string; title: string; timezone: string };
type Slot = { starts_at: string; ends_at: string };

export default function ManageBooking() {
  const [token] = useState(() => typeof location === "undefined" ? "" : new URLSearchParams(location.hash.slice(1)).get("token") || "");
  const [appointment, setAppointment] = useState<Appointment | null>(null);
  const [calendar, setCalendar] = useState<Calendar | null>(null); const [slots, setSlots] = useState<Slot[]>([]); const [selected, setSelected] = useState("");
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  async function load(manageToken: string) {
    const response = await fetch("/v1/public/appointments/manage", { credentials: "omit", headers: { authorization: `Bearer ${manageToken}` } });
    const body = await response.json() as { appointment?: Appointment; calendar?: Calendar; error?: string };
    if (!response.ok || !body.appointment || !body.calendar) throw new Error(body.error || "This management link is invalid.");
    setAppointment(body.appointment); setCalendar(body.calendar);
    if (body.appointment.status === "booked") {
      const availability = await fetch(`/v1/public/booking/${encodeURIComponent(body.calendar.slug)}?days=14`, { credentials: "omit" });
      const availableBody = await availability.json() as { slots?: Slot[] }; if (availability.ok) setSlots(availableBody.slots || []);
    }
  }
  useEffect(() => {
    if (!token) Promise.resolve().then(() => setError("This management link is missing its private token."));
    else { const timer = window.setTimeout(() => void load(token).catch((reason) => setError(reason.message)), 0); return () => clearTimeout(timer); }
  }, [token]);
  function label(value: string) { return new Intl.DateTimeFormat("en-US", { timeZone: calendar?.timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
  async function mutate(action: "cancel" | "reschedule") {
    if (!appointment) return; setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/v1/public/appointments/manage", { method: "POST", credentials: "omit", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ action, starts_at: action === "reschedule" ? selected : undefined, if_revision: appointment.revision }) });
      const body = await response.json() as { appointment?: Appointment; error?: string };
      if (!response.ok || !body.appointment) throw new Error(body.error || "The appointment could not be changed.");
      setAppointment(body.appointment); setNotice(action === "cancel" ? "Appointment cancelled." : "Appointment rescheduled."); setSelected("");
      await load(token);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The appointment could not be changed."); }
    finally { setBusy(false); }
  }
  return <main className="booking-page"><section className="booking-shell booking-manage"><header><span>OPENOPERATOR / PRIVATE APPOINTMENT LINK</span><i>MANAGE</i></header>
    <div className="booking-intro"><p>{calendar?.timezone || "SECURE ACCESS"}</p><h1>{calendar?.title || "Manage appointment"}</h1></div>
    {error && <div className="public-form-error" role="alert">{error}</div>}{notice && <div className="booking-notice" role="status">{notice}</div>}
    {appointment && <div className="booking-manage-card"><div className="booking-ticket"><small>CURRENT APPOINTMENT</small><strong>{label(appointment.starts_at)}</strong><span>{appointment.status.toUpperCase()}</span></div>
      {appointment.status === "booked" && <><label>MOVE TO AN OPEN TIME<select value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">Select another time</option>{slots.map((slot) => <option key={slot.starts_at} value={slot.starts_at}>{label(slot.starts_at)}</option>)}</select></label>
        <div className="booking-actions"><button disabled={!selected || busy} onClick={() => void mutate("reschedule")}>RESCHEDULE</button><button className="danger" disabled={busy} onClick={() => void mutate("cancel")}>CANCEL APPOINTMENT</button></div></>}
    </div>}
  </section></main>;
}
