import { describe, expect, it } from "vitest";
import { parseAutomationTrace } from "../app/automationTrace";

describe("automation run trace normalization", () => {
  it("renders fixed workflow event evidence without exposing arbitrary fields", () => {
    const trace = parseAutomationTrace(JSON.stringify([
      { action: "branch", outcome: "matched", ignored: "secret" },
      {
        action: "publish_event",
        event_id: "workflow-event-123",
        event_type: "contact.workflow_event",
        subscribers: 1,
        step_id: "notify_crm",
        output_schema_version: 1,
        raw_payload: "<script>exfiltrate()</script>",
      },
    ]));
    expect(trace).toEqual([
      expect.objectContaining({ label: "Branch decision", detail: "Path: MATCH", status: "quiet", ordinal: null }),
      expect.objectContaining({
        label: "Publish integration event",
        detail: "contact.workflow_event · Event workflow-event-123 · 1 subscriber",
        status: "normal",
        stepId: "notify_crm",
        ordinal: 1,
      }),
    ]);
    expect(JSON.stringify(trace)).not.toContain("raw_payload");
    expect(JSON.stringify(trace)).not.toContain("exfiltrate");
  });

  it("distinguishes a valid zero-subscriber no-op", () => {
    expect(parseAutomationTrace(JSON.stringify([{
      action: "publish_event",
      event_id: "workflow-event-0",
      event_type: "opportunity.workflow_event",
      subscribers: 0,
    }]))[0]).toEqual(expect.objectContaining({
      detail: "opportunity.workflow_event · Event workflow-event-0 · 0 subscribers",
      status: "quiet",
    }));
  });

  it.each([
    { event_id: "<script>", event_type: "contact.workflow_event", subscribers: 1 },
    { event_id: "event-1", event_type: "contact.deleted", subscribers: 1 },
    { event_id: "event-1", event_type: "contact.workflow_event", subscribers: -1 },
    { event_id: "event-1", event_type: "contact.workflow_event", subscribers: 1.5 },
    { event_id: "event-1", event_type: "contact.workflow_event", subscribers: "1" },
  ])("fails closed for malformed publish output %#", (fields) => {
    expect(parseAutomationTrace(JSON.stringify([{ action: "publish_event", ...fields }]))[0]).toEqual(
      expect.objectContaining({ detail: "Stored event output is unavailable", status: "warning" }),
    );
  });

  it("bounds output, preserves malformed positions, and rejects non-arrays", () => {
    const oversized = Array.from({ length: 30 }, () => ({ action: "add_note", note_id: "note-1" }));
    expect(parseAutomationTrace(JSON.stringify(oversized))).toHaveLength(21);
    expect(parseAutomationTrace(JSON.stringify([null, "bad", { action: "made_up", payload: "private" }]))).toEqual([
      expect.objectContaining({ label: "Unreadable step", status: "warning" }),
      expect.objectContaining({ label: "Unreadable step", status: "warning" }),
      expect.objectContaining({ label: "Unknown step", status: "warning" }),
    ]);
    expect(parseAutomationTrace("{}")).toEqual([]);
    expect(parseAutomationTrace("not-json")).toEqual([]);
  });
});
