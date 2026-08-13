export type AutomationTraceStep = {
  action: string;
  label: string;
  detail: string;
  status: "normal" | "quiet" | "warning";
  stepId: string | null;
  ordinal: number | null;
};

const MAX_TRACE_STEPS = 21;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const EVENT_TYPES = new Set(["contact.workflow_event", "opportunity.workflow_event"]);

const token = (value: unknown) =>
  typeof value === "string" && SAFE_TOKEN.test(value) ? value : null;

const stepIdentity = (step: Record<string, unknown>) => {
  const stepId = token(step.step_id);
  return step.output_schema_version === 1 && stepId ? stepId : null;
};

const entityStep = (
  step: Record<string, unknown>,
  action: string,
  label: string,
  prefix: string,
  field: string,
): AutomationTraceStep => {
  const id = token(step[field]);
  return {
    action,
    label,
    detail: id ? `${prefix} ${id}` : "Stored step output is unavailable",
    status: id ? "normal" : "warning",
    stepId: stepIdentity(step),
    ordinal: null,
  };
};

function normalizeStep(step: Record<string, unknown>): AutomationTraceStep {
  const action = typeof step.action === "string" ? step.action : "";
  if (action === "branch") {
    const outcome = step.outcome === "matched" ? "MATCH" : step.outcome === "else" ? "ELSE" : null;
    return {
      action,
      label: "Branch decision",
      detail: outcome ? `Path: ${outcome}` : "Stored branch outcome is unavailable",
      status: outcome ? "quiet" : "warning",
      stepId: null,
      ordinal: null,
    };
  }
  if (action === "create_task") return entityStep(step, action, "Create task", "Task", "task_id");
  if (action === "propose_task") return entityStep(step, action, "Propose task", "Proposal", "proposal_id");
  if (action === "add_note") return entityStep(step, action, "Add note", "Note", "note_id");
  if (action === "propose_opportunity_update") {
    return entityStep(step, action, "Propose opportunity update", "Proposal", "proposal_id");
  }
  if (action === "propose_contact_update") {
    return entityStep(step, action, "Propose contact update", "Proposal", "proposal_id");
  }
  if (action === "request_agent") return entityStep(step, action, "Request agent", "Agent job", "work_item_id");
  if (action === "publish_event") {
    const eventId = token(step.event_id);
    const eventType = typeof step.event_type === "string" && EVENT_TYPES.has(step.event_type)
      ? step.event_type
      : null;
    const subscribers = typeof step.subscribers === "number" && Number.isSafeInteger(step.subscribers) &&
      step.subscribers >= 0 && step.subscribers <= 10_000
      ? step.subscribers
      : null;
    const valid = Boolean(eventId && eventType && subscribers !== null);
    return {
      action,
      label: "Publish integration event",
      detail: valid
        ? `${eventType} · Event ${eventId} · ${subscribers} subscriber${subscribers === 1 ? "" : "s"}`
        : "Stored event output is unavailable",
      status: valid ? subscribers === 0 ? "quiet" : "normal" : "warning",
      stepId: stepIdentity(step),
      ordinal: null,
    };
  }
  return {
    action: "unknown",
    label: "Unknown step",
    detail: "Stored step output is unsupported",
    status: "warning",
    stepId: null,
    ordinal: null,
  };
}

export function parseAutomationTrace(output: string): AutomationTraceStep[] {
  try {
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) return [];
    let ordinal = 0;
    return parsed
      .slice(0, MAX_TRACE_STEPS)
      .map((step) => step && typeof step === "object" && !Array.isArray(step)
        ? normalizeStep(step as Record<string, unknown>)
        : {
          action: "unknown",
          label: "Unreadable step",
          detail: "Stored step output is malformed",
          status: "warning" as const,
          stepId: null,
          ordinal: null,
        })
      .map((step) => {
        if (step.action === "branch") return step;
        ordinal += 1;
        return { ...step, ordinal };
      });
  } catch {
    return [];
  }
}
