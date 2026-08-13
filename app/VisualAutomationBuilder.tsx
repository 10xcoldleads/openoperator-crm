"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow,
  ReactFlowProvider, type Edge, type Node, type NodeProps, type OnNodeDrag,
  useEdgesState, useNodesState, useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  automationCatalog,
  type AutomationConditionField,
  type AutomationOperator,
  type AutomationTriggerId,
} from "@/contracts/productCatalog";

export type WorkflowCondition = {
  field: AutomationConditionField | `custom:${string}`;
  operator: AutomationOperator;
  value: string | number | boolean;
};
type WorkflowActionIdentity = { step_id?: string; output_schema_version?: 1 };
export type WorkflowAction = WorkflowActionIdentity & (
  | { type: "create_task"; title: string; priority: "low" | "normal" | "high" | "urgent"; due_in_minutes: number; approval_required?: boolean }
  | { type: "add_note"; body: string }
  | { type: "update_opportunity"; field: "next_step" | "owner" | "probability"; value: string | number; approval_required: true }
  | { type: "update_contact"; field: "stage" | "status" | "owner" | `custom:${string}`; value: string | number | boolean; approval_required: true }
  | { type: "request_agent"; objective: "lead_research" | "deal_review" | "follow_up_draft" | "call_brief"; instructions: string; preferred_provider: "any" | "openclaw" | "hermes" }
  | { type: "publish_event" });
export type WorkflowDefinition = {
  trigger_type: AutomationTriggerId;
  conditions: WorkflowCondition[];
  actions: WorkflowAction[];
  else_actions: WorkflowAction[];
  max_runs_per_record: number;
};

type BuilderProps = {
  name: string; definition: WorkflowDefinition; disabled?: boolean;
  onNameChange: (name: string) => void;
  onChange: (definition: WorkflowDefinition) => void;
  onSave: () => void; onClose: () => void; saveLabel: string;
  stages: Array<{ id: string; name: string }>;
  availableAgentProviders: Array<"openclaw" | "hermes">;
  observedAgentProviders: Array<"openclaw" | "hermes">;
  agentAccessEnabled: boolean;
  outboundWebhookEventTypes: string[];
  customFields: Array<{
    field_key: string; label: string; field_type: "text" | "number" | "boolean" | "date" | "select";
    options: string[]; object_type: "contact" | "company" | "opportunity"; active: boolean;
  }>;
};
type WorkflowNodeData = {
  kind: "trigger" | "condition" | "action"; eyebrow: string; label: string; detail: string;
  sequence: string; selected: boolean; onSelect: () => void;
};

function AutomationNode({ data }: NodeProps<Node<WorkflowNodeData>>) {
  return <button type="button" aria-pressed={data.selected}
    className={`workflow-node ${data.kind} ${data.selected ? "selected" : ""}`} onClick={data.onSelect}>
    {data.kind !== "trigger" && <Handle type="target" position={Position.Left} isConnectable={false} />}
    <em className="workflow-step-badge" aria-label={`Execution position ${data.sequence}`}>{data.sequence}</em>
    <span>{data.eyebrow}</span><strong>{data.label}</strong><small>{data.detail}</small>
    <i className="workflow-drag-hint" aria-hidden="true">DRAG</i>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </button>;
}
const nodeTypes = { workflow: AutomationNode };
const fieldLabels = Object.fromEntries(
  automationCatalog.conditionFields.map((field) => [field.id, field.label]),
) as Record<WorkflowCondition["field"], string>;
const operatorLabels = Object.fromEntries(
  automationCatalog.operators.map((operator) => [operator.id, operator.label]),
) as Record<WorkflowCondition["operator"], string>;
const actionLabels = Object.fromEntries(
  automationCatalog.actions.map((action) => [action.id, action.label]),
) as Record<WorkflowAction["type"], string>;
const triggerLabels = Object.fromEntries(
  automationCatalog.triggers.map((trigger) => [trigger.id, trigger.label]),
) as Record<WorkflowDefinition["trigger_type"], string>;
const opportunityVariables = [
  { token: "{{opportunity.name}}", label: "Opportunity name", type: "text" },
  { token: "{{opportunity.status}}", label: "Status", type: "text" },
  { token: "{{opportunity.stage_id}}", label: "Pipeline stage ID", type: "ID" },
  { token: "{{opportunity.owner}}", label: "Owner", type: "text · may be empty" },
  { token: "{{opportunity.value}}", label: "Value", type: "number" },
  { token: "{{opportunity.probability}}", label: "Probability", type: "number" },
  { token: "{{opportunity.next_step}}", label: "Next step", type: "text · may be empty" },
] as const;
const contactVariables = [
  { token: "{{contact.email}}", label: "Lead email", type: "text" },
  { token: "{{contact.first_name}}", label: "First name", type: "text · may be empty" },
  { token: "{{contact.last_name}}", label: "Last name", type: "text · may be empty" },
  { token: "{{contact.company}}", label: "Company", type: "text · may be empty" },
  { token: "{{contact.status}}", label: "Lead status", type: "text" },
  { token: "{{contact.stage}}", label: "Lead lifecycle", type: "text" },
  { token: "{{contact.owner}}", label: "Owner", type: "text · may be empty" },
  { token: "{{contact.score}}", label: "Lead score", type: "number" },
  { token: "{{contact.source_last}}", label: "Latest source", type: "text" },
] as const;
function newStepIdentity(): Required<WorkflowActionIdentity> {
  return { step_id: `step_${crypto.randomUUID().replaceAll("-", "")}`, output_schema_version: 1 };
}
function actionOutputVariable(action: WorkflowAction, index: number) {
  if (!action.step_id) return null;
  const field = action.type === "create_task" ? (action.approval_required ? "proposal_id" : "task_id")
    : action.type === "add_note" ? "note_id"
      : action.type === "request_agent" ? "work_item_id"
        : action.type === "publish_event" ? "event_id"
          : "proposal_id";
  return {
    token: `{{steps.${action.step_id}.${field}}}`,
    label: `${index + 1}. ${actionLabels[action.type]} → ${field.replaceAll("_", " ")}`,
  };
}
function validTemplate(value: string, recordType: "contact" | "opportunity",
  priorActions: WorkflowAction[] = [], customFields: BuilderProps["customFields"] = []) {
  const allowedWorkflowTokens = new Set((recordType === "contact" ? contactVariables : opportunityVariables)
    .map((variable) => variable.token.slice(2, -2)));
  customFields.filter((field) => field.object_type === recordType && field.active)
    .forEach((field) => allowedWorkflowTokens.add(`${recordType}.custom.${field.field_key}`));
  priorActions.map(actionOutputVariable).filter((variable): variable is NonNullable<typeof variable> => Boolean(variable))
    .forEach((variable) => allowedWorkflowTokens.add(variable.token.slice(2, -2)));
  const matches = [...value.matchAll(/\{\{([^{}]+)\}\}/g)];
  if (matches.some((match) => !allowedWorkflowTokens.has(match[1].trim()))) return false;
  const remainder = value.replace(/\{\{([^{}]+)\}\}/g, "");
  return !remainder.includes("{{") && !remainder.includes("}}");
}
function TypedVariablePicker(props: { value: string; label: string; maxLength: number; recordType: "contact" | "opportunity";
  priorActions?: WorkflowAction[]; customFields: BuilderProps["customFields"]; onChange: (value: string) => void }) {
  const workflowVariables = props.recordType === "contact" ? contactVariables : opportunityVariables;
  const governedVariables = props.customFields
    .filter((field) => field.object_type === props.recordType && field.active)
    .map((field) => ({
      token: `{{${props.recordType}.custom.${field.field_key}}}`,
      label: field.label,
      type: field.field_type,
    }));
  const stepVariables = (props.priorActions || []).map(actionOutputVariable)
    .filter((variable): variable is NonNullable<typeof variable> => Boolean(variable));
  return <label className="workflow-variable-picker">
    <span>INSERT RECORD DATA</span>
    <select aria-label={`Insert record data into ${props.label}`} value=""
      onChange={(event) => {
        if (!event.target.value) return;
        const separator = props.value && !/\s$/.test(props.value) ? " " : "";
        props.onChange(`${props.value}${separator}${event.target.value}`);
      }}>
      <option value="">Choose a typed field…</option>
      {workflowVariables.map((variable) =>
        <option key={variable.token} value={variable.token}
          disabled={props.value.length + (props.value && !/\s$/.test(props.value) ? 1 : 0) + variable.token.length > props.maxLength}>
          {variable.label} · {variable.type}
        </option>)}
      {governedVariables.length > 0 && <optgroup label="GOVERNED FIELDS">
        {governedVariables.map((variable) => <option key={variable.token} value={variable.token}
          disabled={props.value.length + (props.value && !/\s$/.test(props.value) ? 1 : 0) + variable.token.length > props.maxLength}>
          {variable.label} · {variable.type}
        </option>)}
      </optgroup>}
      {stepVariables.length > 0 && <optgroup label="EARLIER STEPS">
        {stepVariables.map((variable) => <option key={variable.token} value={variable.token}
          disabled={props.value.length + (props.value && !/\s$/.test(props.value) ? 1 : 0) + variable.token.length > props.maxLength}>
          {variable.label}
        </option>)}
      </optgroup>}
    </select>
    <small>Trigger data, active governed fields, and declared earlier-step outputs only · {props.maxLength - props.value.length} template characters left. Unknown fields fail closed; archived fields require repair; unsafe reorderings block save.</small>
  </label>;
}
function actionDetail(action: WorkflowAction) {
  if (action.type === "create_task") return `${action.approval_required ? "Approval · " : ""}${action.title || "Untitled task"}`;
  if (action.type === "add_note") return action.body || "Empty note";
  if (action.type === "update_opportunity") return `Approval · ${action.field.replaceAll("_", " ")}`;
  if (action.type === "update_contact") return `Approval · ${action.field.replaceAll("_", " ")}`;
  if (action.type === "publish_event") return "Signed webhook · server-built payload";
  return `${action.preferred_provider} · ${action.objective.replaceAll("_", " ")}`;
}

function VisualAutomationCanvas(props: BuilderProps) {
  const { definition } = props;
  const [selectedId, setSelectedId] = useState("trigger");
  const [pendingBuilderAction, setPendingBuilderAction] = useState<"close" | "speed" | "progression" | "high_value" | "proposal" | null>(null);
  const builderDirtyRef = useRef(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<WorkflowNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { fitView } = useReactFlow();

  const cards = useMemo(() => {
    const result: Array<Omit<WorkflowNodeData, "selected" | "onSelect"> & { id: string }> = [{
      id: "trigger", kind: "trigger", eyebrow: "WHEN", label: triggerLabels[definition.trigger_type],
      detail: "Starts this workflow", sequence: "01",
    }];
    definition.conditions.forEach((condition, index) => result.push({
      id: `condition-${index}`, kind: "condition", eyebrow: "ONLY IF",
      label: fieldLabels[condition.field as AutomationConditionField] ||
        props.customFields.find((field) => `custom:${field.field_key}` === condition.field)?.label || "Unavailable field",
      detail: `${operatorLabels[condition.operator]} ${String(condition.value || "…")}`,
      sequence: String(index + 2).padStart(2, "0"),
    }));
    definition.actions.forEach((action, index) => result.push({
      id: `action-${index}`, kind: "action", eyebrow: "THEN", label: actionLabels[action.type],
      detail: actionDetail(action), sequence: `M${index + 1}`,
    }));
    definition.else_actions.forEach((action, index) => result.push({
      id: `else-action-${index}`, kind: "action", eyebrow: "ELSE", label: actionLabels[action.type],
      detail: actionDetail(action), sequence: `E${index + 1}`,
    }));
    return result;
  }, [definition, props.customFields]);

  useEffect(() => {
    setNodes((prior) => {
      // Template changes can reuse IDs for different topology positions (for
      // example, action-0 moves when a condition is introduced). Preserve
      // manually dragged positions only while the ordered node topology is
      // unchanged; otherwise recompute a clean, non-overlapping layout.
      const preservePositions = prior.length === cards.length
        && prior.every((node, index) => node.id === cards[index]?.id);
      return cards.map((card, index) => {
      const existing = prior.find((node) => node.id === card.id);
      return {
        id: card.id, type: "workflow",
        position: (preservePositions ? existing?.position : undefined) || (card.id.startsWith("else-action-")
          ? { x: 80 + (1 + definition.conditions.length + Number(card.id.split("-").at(-1))) * 250, y: 255 }
          : { x: 80 + index * 250, y: 75 }),
        data: { ...card, selected: selectedId === card.id, onSelect: () => setSelectedId(card.id) },
      };
      });
    });
    const gateId = definition.conditions.length ? `condition-${definition.conditions.length - 1}` : "trigger";
    const mainPath = ["trigger", ...definition.conditions.map((_, index) => `condition-${index}`), ...definition.actions.map((_, index) => `action-${index}`)];
    const branchEdges: Edge[] = mainPath.slice(1).map((target, index) => ({
      id: `edge-${mainPath[index]}-${target}`, source: mainPath[index], target, type: "smoothstep", animated: true,
      markerEnd: { type: MarkerType.ArrowClosed }, label: target === "action-0" && definition.else_actions.length ? "MATCH" : undefined,
      style: { stroke: "#b73931", strokeWidth: 2 },
    }));
    definition.else_actions.forEach((_, index) => branchEdges.push({
      id: `edge-else-${index}`, source: index ? `else-action-${index - 1}` : gateId, target: `else-action-${index}`,
      type: "smoothstep", animated: true, markerEnd: { type: MarkerType.ArrowClosed }, label: index ? undefined : "ELSE",
      style: { stroke: "#6f675d", strokeWidth: 2 },
    }));
    setEdges(branchEdges);
  }, [cards, definition.actions, definition.conditions, definition.else_actions, selectedId, setEdges, setNodes]);

  const topologySignature = cards.map((card) => card.id).join("|");
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void fitView({
        padding: 0.22,
        duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 350,
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [fitView, topologySignature]);

  const conditionIndex = selectedId.startsWith("condition-") ? Number(selectedId.split("-")[1]) : -1;
  const actionIndex = selectedId.startsWith("action-") ? Number(selectedId.split("-")[1]) : -1;
  const elseActionIndex = selectedId.startsWith("else-action-") ? Number(selectedId.split("-")[2]) : -1;
  const selectedCondition = definition.conditions[conditionIndex];
  const selectedAction = actionIndex >= 0 ? definition.actions[actionIndex] : definition.else_actions[elseActionIndex];
  const recordType = definition.trigger_type.startsWith("contact.") ? "contact" : "opportunity";
  const selectedBranchActions = elseActionIndex >= 0 ? definition.else_actions : definition.actions;
  const selectedBranchIndex = elseActionIndex >= 0 ? elseActionIndex : actionIndex;
  const priorActions = selectedBranchIndex > 0 ? selectedBranchActions.slice(0, selectedBranchIndex) : [];
  const conditionFields: WorkflowCondition["field"][] = [
    ...(recordType === "contact"
      ? (["status", "stage", "owner", "score", "source_last"] as WorkflowCondition["field"][])
      : (["status", "stage_id", "owner", "probability", "value"] as WorkflowCondition["field"][])),
    ...props.customFields.filter((field) => field.object_type === recordType && field.active)
      .map((field) => `custom:${field.field_key}` as const),
  ];
  const changeDefinition = (next: WorkflowDefinition) => {
    builderDirtyRef.current = true;
    const stabilize = (actions: WorkflowAction[]) => actions.map((action) =>
      action.step_id ? action : { ...action, ...newStepIdentity() } as WorkflowAction);
    props.onChange({ ...next, actions: stabilize(next.actions), else_actions: stabilize(next.else_actions) });
  };
  const changeName = (next: string) => {
    builderDirtyRef.current = true;
    props.onNameChange(next);
  };
  const updateCondition = (patch: Partial<WorkflowCondition>) => changeDefinition({
    ...definition, conditions: definition.conditions.map((item, index) => index === conditionIndex ? { ...item, ...patch } : item),
  });
  const updateAction = (patch: Partial<WorkflowAction>) => changeDefinition({
    ...definition,
    actions: actionIndex < 0 ? definition.actions : definition.actions.map((item, index) => index === actionIndex ? { ...item, ...patch } as WorkflowAction : item),
    else_actions: elseActionIndex < 0 ? definition.else_actions : definition.else_actions.map((item, index) => index === elseActionIndex ? { ...item, ...patch } as WorkflowAction : item),
  });
  const selectedCustomCondition = selectedCondition?.field.startsWith("custom:")
    ? props.customFields.find((field) => `custom:${field.field_key}` === selectedCondition.field && field.active) : undefined;
  const numericCondition = Boolean(selectedCondition && (["score", "probability", "value"].includes(selectedCondition.field) ||
    selectedCustomCondition?.field_type === "number"));
  const selectedAgentConfigured = selectedAction?.type === "request_agent" &&
    (selectedAction.preferred_provider === "any"
      ? props.availableAgentProviders.length > 0
      : props.availableAgentProviders.includes(selectedAction.preferred_provider));
  const selectedAgentObserved = selectedAction?.type === "request_agent" &&
    (selectedAction.preferred_provider === "any"
      ? props.observedAgentProviders.length > 0
      : props.observedAgentProviders.includes(selectedAction.preferred_provider));
  const availableOperators = numericCondition ? Object.entries(operatorLabels)
    : Object.entries(operatorLabels).filter(([value]) => ["equals", "not_equals"].includes(value));
  const validBranch = (branch: WorkflowAction[]) => branch.every((action, index) => {
    const upstream = branch.slice(0, index);
    if (action.type === "create_task") return Boolean(action.title.trim()) &&
      validTemplate(action.title, recordType, upstream, props.customFields);
    if (action.type === "add_note") return Boolean(action.body.trim()) &&
      validTemplate(action.body, recordType, upstream, props.customFields);
    if (action.type === "update_opportunity") return action.field === "probability"
      ? typeof action.value === "number"
      : Boolean(String(action.value).trim()) &&
        validTemplate(String(action.value), recordType, upstream, props.customFields);
    if (action.type === "update_contact") {
      if (action.field === "owner") return typeof action.value === "string" &&
        validTemplate(action.value, recordType, upstream, props.customFields);
      if (action.field.startsWith("custom:")) {
        const field = props.customFields.find((item) => item.active && `custom:${item.field_key}` === action.field);
        return Boolean(field) && (field?.field_type === "number" ? typeof action.value === "number" && Number.isFinite(action.value)
          : field?.field_type === "boolean" ? typeof action.value === "boolean"
            : typeof action.value === "string" && Boolean(action.value.trim()));
      }
      return typeof action.value === "string" && Boolean(action.value.trim());
    }
    if (action.type === "publish_event") return true;
    return Boolean(action.instructions.trim()) &&
      validTemplate(action.instructions, recordType, upstream, props.customFields);
  });
  const complete = Boolean(props.name.trim())
    && definition.actions.length > 0
    && (!definition.else_actions.length || definition.conditions.length > 0)
    && Number.isInteger(definition.max_runs_per_record)
    && definition.max_runs_per_record >= 1 && definition.max_runs_per_record <= 20
    && definition.conditions.every((condition) =>
    validConditionValue(condition, props.customFields) &&
      (condition.field !== "stage_id" || props.stages.some((stage) => stage.id === condition.value)))
    && [...definition.actions, ...definition.else_actions].every((action) =>
      recordType === "contact" ? action.type !== "update_opportunity" : action.type !== "update_contact")
    && validBranch(definition.actions)
    && validBranch(definition.else_actions);
  const allActions = [...definition.actions, ...definition.else_actions];
  const serializedActionGraph = JSON.stringify(allActions);
  const governedReadAuthority = props.customFields
    .filter((field) => field.object_type === recordType && field.active &&
      serializedActionGraph.includes(`{{${recordType}.custom.${field.field_key}}}`))
    .map((field) => `Read ${field.label}`);
  const workflowAuthority = [...new Set([...allActions.map((action) =>
    action.type === "create_task" ? (action.approval_required ? "Propose tasks" : "Create tasks")
      : action.type === "add_note" ? "Add internal notes"
        : action.type === "update_contact" ? "Propose contact updates"
          : action.type === "update_opportunity" ? "Propose opportunity updates"
            : action.type === "request_agent" ? "Queue bounded AI work"
              : "Publish sanitized events"), ...governedReadAuthority])].sort();
  const humanGateCount = allActions.filter((action) =>
    (action.type === "create_task" && action.approval_required) ||
    action.type === "update_opportunity" || action.type === "update_contact").length;
  const agentActions = allActions.filter((action): action is Extract<WorkflowAction, { type: "request_agent" }> =>
    action.type === "request_agent");
  const unavailableAgentActions = agentActions.filter((action) =>
    action.preferred_provider === "any"
      ? props.availableAgentProviders.length === 0
      : !props.availableAgentProviders.includes(action.preferred_provider));
  const unavailableAgentLabels = [...new Set(unavailableAgentActions.map((action) =>
    action.preferred_provider === "any" ? "AN AGENT RUNTIME" : action.preferred_provider.toUpperCase()))];
  const activationReady = complete && (!agentActions.length ||
    (props.agentAccessEnabled && unavailableAgentActions.length === 0));
  const handleNodeDragStop: OnNodeDrag<Node<WorkflowNodeData>> = (_, moved) => {
    const currentNodes = nodes.map((node) => node.id === moved.id ? moved : node);
    const reorder = <T,>(prefix: string, values: T[]) => currentNodes
      .filter((node) => node.id.startsWith(prefix))
      .sort((left, right) => left.position.x - right.position.x || left.position.y - right.position.y)
      .map((node) => values[Number(node.id.slice(prefix.length))])
      .filter((value): value is T => value !== undefined);
    if (moved.id.startsWith("condition-")) {
      changeDefinition({ ...definition, conditions: reorder("condition-", definition.conditions) });
      setSelectedId("trigger");
    } else if (moved.id.startsWith("else-action-")) {
      changeDefinition({ ...definition, else_actions: reorder("else-action-", definition.else_actions) });
      setSelectedId("trigger");
    } else if (moved.id.startsWith("action-")) {
      changeDefinition({ ...definition, actions: reorder("action-", definition.actions) });
      setSelectedId("trigger");
    }
  };
  const applyTemplate = (template: "speed" | "progression" | "high_value" | "proposal") => {
    if (template === "speed") {
      changeName("Immediate new-lead follow-up");
      changeDefinition({ trigger_type: "contact.created", conditions: [],
        actions: [{ type: "create_task", title: "Follow up with {{contact.email}}", priority: "high", due_in_minutes: 0 }],
        else_actions: [], max_runs_per_record: 20 });
    } else if (template === "progression") {
      changeName("New lead registration review");
      changeDefinition({ trigger_type: "contact.created", conditions: [],
        actions: [{ type: "update_contact", field: "stage", value: "registered", approval_required: true }],
        else_actions: [], max_runs_per_record: 1 });
    } else if (template === "high_value") {
      changeName("High-value deal copilot");
      changeDefinition({ trigger_type: "opportunity.stage_changed",
        conditions: [{ field: "value", operator: "greater_than", value: 5000 }],
        actions: [{ type: "request_agent", objective: "deal_review", preferred_provider: "any",
          instructions: "Review the deal, identify missing information, and propose the safest useful next task." }],
        else_actions: [{ type: "add_note", body: "Deal did not meet the high-value agent-review threshold." }],
        max_runs_per_record: 10 });
    } else {
      const proposalStage = props.stages.find((stage) => /proposal|offer/i.test(stage.name))?.id || props.stages[0]?.id || "";
      changeName("Proposal follow-up assistant");
      changeDefinition({ trigger_type: "opportunity.stage_changed",
        conditions: [{ field: "stage_id", operator: "equals", value: proposalStage }],
        actions: [
          { type: "request_agent", objective: "follow_up_draft", preferred_provider: "any",
            instructions: "Draft a concise follow-up and propose a human-reviewed task for the opportunity owner." },
          { type: "create_task", title: "Review agent follow-up draft", priority: "high", due_in_minutes: 60, approval_required: true },
        ], else_actions: [], max_runs_per_record: 5 });
    }
    setSelectedId("trigger");
    setPendingBuilderAction(null);
  };
  const requestBuilderAction = (action: "close" | "speed" | "progression" | "high_value" | "proposal") => {
    if (!builderDirtyRef.current) {
      if (action === "close") props.onClose();
      else applyTemplate(action);
      return;
    }
    setPendingBuilderAction(action);
  };
  const confirmBuilderAction = () => {
    if (!pendingBuilderAction) return;
    if (pendingBuilderAction === "close") props.onClose();
    else applyTemplate(pendingBuilderAction);
  };

  return <section className="workflow-builder" aria-label="Visual automation builder">
    <div className="workflow-builder-head"><div><p className="eyebrow">REACT FLOW WORKFLOW</p><h3>Build the business journey.</h3>
      <small>Drag to organize, zoom to inspect, and select any node to configure it. Execution follows the connected numbered path.</small></div>
      <div><button className="secondary" type="button" onClick={() => requestBuilderAction("close")}>CLOSE</button>
        <button type="button" disabled={props.disabled || !props.name.trim() || !complete} onClick={props.onSave}>{props.saveLabel}</button></div></div>
    {pendingBuilderAction && <div className="workflow-discard-review" role="alert">
      <span><b>UNSAVED WORK</b><small>{pendingBuilderAction === "close"
        ? "Closing now discards every unsaved workflow change."
        : "Loading this starting point replaces the current unsaved workflow."}</small></span>
      <button type="button" onClick={confirmBuilderAction}>{pendingBuilderAction === "close" ? "DISCARD + CLOSE" : "REPLACE WORKFLOW"}</button>
      <button className="secondary" type="button" onClick={() => setPendingBuilderAction(null)}>KEEP EDITING</button>
    </div>}
    <label className="workflow-name">WORKFLOW NAME<input value={props.name} maxLength={200}
      onChange={(event) => changeName(event.target.value)} placeholder="Qualified opportunity follow-up" /></label>
    <div className="workflow-templates" aria-label="Workflow templates"><span>STARTING POINTS</span>
      <button type="button" onClick={() => requestBuilderAction("speed")}>Speed-to-lead</button>
      <button type="button" onClick={() => requestBuilderAction("progression")}>Lead progression</button>
      <button type="button" onClick={() => requestBuilderAction("high_value")}>High-value copilot</button>
      <button type="button" onClick={() => requestBuilderAction("proposal")}>Proposal follow-up</button>
      <i className={complete ? "valid" : "invalid"}>{complete ? "VALID · READY TO SAVE" : "INCOMPLETE · REVIEW SELECTED FIELDS"}</i>
    </div>
    <div className={`workflow-preflight ${activationReady ? "ready" : "blocked"}`} aria-label="Workflow preflight">
      <span><b>{definition.actions.length}</b><small>MATCH ACTIONS</small></span>
      <span><b>{definition.else_actions.length}</b><small>ELSE ACTIONS</small></span>
      <span><b>{humanGateCount}</b><small>HUMAN GATES</small></span>
      <span><b>{agentActions.length}</b><small>AGENT HANDOFFS</small></span>
      <strong>{activationReady ? "ACTIVATION PREFLIGHT PASSED"
        : !props.name.trim() ? "ADD A WORKFLOW NAME"
          : !complete ? "FIX INCOMPLETE FIELDS"
          : !props.agentAccessEnabled ? "AGENT PICKUP IS PAUSED"
            : `CONNECT ${unavailableAgentLabels.join(" + ")}`}</strong>
    </div>
    <div className="workflow-authority" aria-label="Workflow authority">
      <div><p className="eyebrow">WORKFLOW PRINCIPAL</p><h4>Least privilege, derived from this graph.</h4>
        <small>The server signs this exact capability set on activation. Triggering users cannot lend the workflow extra access.</small></div>
      <div>{workflowAuthority.map((capability) => <span key={capability}>{capability}</span>)}</div>
    </div>
    <div className="workflow-layout">
      <div className="workflow-canvas" aria-label="Draggable workflow canvas">
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange} onNodeDragStop={handleNodeDragStop} fitView fitViewOptions={{ padding: 0.25 }} minZoom={0.35} maxZoom={1.7}
          nodesConnectable={false} deleteKeyCode={null} snapToGrid snapGrid={[16, 16]}
          proOptions={{ hideAttribution: false }}>
          <Background color="#c9c0b4" gap={24} size={1} /><MiniMap pannable zoomable
            nodeColor={(node) => node.data.kind === "trigger" ? "#b73931" : node.data.kind === "condition" ? "#d49a2e" : "#24744a"} />
          <Controls showInteractive={false} />
        </ReactFlow>
        <div className="workflow-canvas-status" role="status">{cards.length} connected steps · bounded to 20 server-side</div>
      </div>
      <aside className="workflow-inspector">
        {selectedId === "trigger" && <><p className="eyebrow">TRIGGER · STEP 1</p><h4>{triggerLabels[definition.trigger_type]}</h4>
          <label>EVENT<select value={definition.trigger_type}
            onChange={(event) => {
              const trigger_type = event.target.value as WorkflowDefinition["trigger_type"];
              const nextRecordType = trigger_type.startsWith("contact.") ? "contact" : "opportunity";
              changeDefinition({
                ...definition, trigger_type, conditions: [],
                actions: nextRecordType === "contact"
                  ? definition.actions.filter((action) => action.type !== "update_opportunity")
                  : definition.actions.filter((action) => action.type !== "update_contact"),
                else_actions: nextRecordType === "contact"
                  ? definition.else_actions.filter((action) => action.type !== "update_opportunity")
                  : definition.else_actions.filter((action) => action.type !== "update_contact"),
              });
              setSelectedId("trigger");
            }}>
            <option value="contact.created">Lead is created</option>
            <option value="contact.lifecycle_changed">Lead lifecycle changes</option>
            <option value="contact.manual">Lead is selected manually</option>
            <option value="opportunity.stage_changed">Opportunity stage changes</option>
            <option value="opportunity.created">Opportunity is created</option>
            <option value="opportunity.manual">Opportunity is selected manually</option>
          </select></label>
          <p>{definition.trigger_type === "opportunity.created"
            ? "Starts once after a new deal and its audit record commit successfully."
            : definition.trigger_type === "opportunity.stage_changed"
              ? "Starts only after a deal successfully moves to another stage."
              : definition.trigger_type === "opportunity.manual"
                ? "Runs only when an admin selects one opportunity and presses Run now."
              : definition.trigger_type === "contact.created"
                ? "Starts for a genuinely new lead from manual entry, imports, Skool, or connected sources."
                : definition.trigger_type === "contact.manual"
                  ? "Runs only when an admin selects one lead and presses Run now."
                  : "Starts only when a lead successfully moves to another lifecycle stage or status."}</p></>}
        {selectedCondition && <><p className="eyebrow">CONDITION · STEP {conditionIndex + 2}</p><h4>Continue only when…</h4>
          <label>FIELD<select value={selectedCondition.field} onChange={(event) => {
            const field = event.target.value as WorkflowCondition["field"];
            const custom = field.startsWith("custom:")
              ? props.customFields.find((item) => item.field_key === field.slice(7) && item.active) : undefined;
            updateCondition({ field, operator: "equals", value: field === "stage_id" ? props.stages[0]?.id || ""
              : field === "stage" ? "new" : field === "status" ? (recordType === "contact" ? "lead" : "open")
                : ["score", "probability", "value"].includes(field) || custom?.field_type === "number" ? 0
                  : custom?.field_type === "boolean" ? false : custom?.field_type === "select" ? custom.options[0] || "" : "" });
          }}>{conditionFields.map((value) => <option key={value} value={value}>
              {fieldLabels[value as AutomationConditionField] ||
                props.customFields.find((field) => `custom:${field.field_key}` === value)?.label || value}
            </option>)}</select></label>
          <label>MATCH<select value={selectedCondition.operator} onChange={(event) => updateCondition({ operator: event.target.value as WorkflowCondition["operator"] })}>
            {availableOperators.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          {selectedCondition.field === "stage_id" ? <label>VALUE<select value={String(selectedCondition.value)} onChange={(event) => updateCondition({ value: event.target.value })}>
            <option value="">Choose a stage</option>{props.stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></label>
            : selectedCondition.field === "stage" ? <label>VALUE<select value={String(selectedCondition.value)} onChange={(event) => updateCondition({ value: event.target.value })}>
              <option value="new">New</option><option value="registered">Registered</option><option value="confirmed">Confirmed</option>
              <option value="attended">Attended</option><option value="offer">Offer</option><option value="booked">Booked</option><option value="won">Won</option></select></label>
            : selectedCondition.field === "status" ? <label>VALUE<select value={String(selectedCondition.value)} onChange={(event) => updateCondition({ value: event.target.value })}>
              {recordType === "contact" ? <><option value="lead">Lead</option><option value="customer">Customer</option><option value="inactive">Inactive</option></>
                : <><option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option><option value="abandoned">Abandoned</option></>}</select></label>
              : selectedCustomCondition?.field_type === "boolean" ? <label>VALUE<select
                value={String(selectedCondition.value)} onChange={(event) => updateCondition({ value: event.target.value === "true" })}>
                <option value="true">Yes</option><option value="false">No</option></select></label>
                : selectedCustomCondition?.field_type === "select" ? <label>VALUE<select
                  value={String(selectedCondition.value)} onChange={(event) => updateCondition({ value: event.target.value })}>
                  {selectedCustomCondition.options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
                  : <label>VALUE<input type={selectedCustomCondition?.field_type === "date" ? "date" : numericCondition ? "number" : "text"}
                min={numericCondition ? 0 : undefined}
                max={selectedCondition.field === "probability" ? 100 : selectedCondition.field === "value" ? 100000000 : undefined}
                value={String(selectedCondition.value)} onChange={(event) => updateCondition({
                  value: numericCondition ? Number(event.target.value) : event.target.value,
                })} /></label>}
          <button className="danger-link" type="button" onClick={() => { changeDefinition({ ...definition, conditions: definition.conditions.filter((_, index) => index !== conditionIndex) }); setSelectedId("trigger"); }}>REMOVE CONDITION</button></>}
        {selectedAction && <><p className="eyebrow">{elseActionIndex >= 0 ? "ELSE" : "MATCH"} ACTION · {elseActionIndex >= 0 ? elseActionIndex + 1 : actionIndex + 1}</p><h4>{actionLabels[selectedAction.type]}</h4>
          <div className="workflow-lineage" aria-label="Stable workflow step identity">
            <span>STABLE STEP</span>
            <code>{selectedAction.step_id ? selectedAction.step_id.slice(0, 17) + "…" : "assigned on first edit"}</code>
            <small>Output schema v1 · {actionOutputVariable(selectedAction, selectedBranchIndex)?.label.split("→")[1]?.trim() || "no reusable output"}</small>
          </div>
          <label>ACTION TYPE<select value={selectedAction.type} onChange={(event) => {
            const type = event.target.value as WorkflowAction["type"];
            const identity = selectedAction.step_id
              ? { step_id: selectedAction.step_id, output_schema_version: 1 as const }
              : newStepIdentity();
            const replacement: WorkflowAction = type === "create_task" ? { ...identity, type, title: "Follow up", priority: "normal", due_in_minutes: 1440 }
              : type === "add_note" ? { ...identity, type, body: `Workflow completed for this ${recordType}.` }
              : type === "update_opportunity" ? { ...identity, type, field: "next_step", value: "Review and confirm next step", approval_required: true }
              : type === "update_contact" ? { ...identity, type, field: "stage", value: "registered", approval_required: true }
              : type === "publish_event" ? { ...identity, type }
              : { ...identity, type, objective: recordType === "contact" ? "lead_research" : "deal_review",
                instructions: `Review this ${recordType} and propose the most useful next action.`, preferred_provider: "any" };
            changeDefinition({
              ...definition,
              actions: actionIndex < 0 ? definition.actions : definition.actions.map((item, index) => index === actionIndex ? replacement : item),
              else_actions: elseActionIndex < 0 ? definition.else_actions : definition.else_actions.map((item, index) => index === elseActionIndex ? replacement : item),
            });
          }}>{Object.entries(actionLabels).filter(([value]) =>
            recordType === "contact" ? value !== "update_opportunity" : value !== "update_contact")
            .map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          {selectedAction.type === "create_task" && <><label>TASK TITLE<input value={selectedAction.title} maxLength={200} onChange={(event) => updateAction({ title: event.target.value })} /></label>
          <TypedVariablePicker value={selectedAction.title} label="task title" maxLength={200} recordType={recordType}
            priorActions={priorActions} customFields={props.customFields} onChange={(value) => updateAction({ title: value })} />
          <label>PRIORITY<select value={selectedAction.priority} onChange={(event) => updateAction({ priority: event.target.value as "low" | "normal" | "high" | "urgent" })}>
            <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>
          <label>DUE AFTER<select value={selectedAction.due_in_minutes} onChange={(event) => updateAction({ due_in_minutes: Number(event.target.value) })}>
            <option value={0}>Immediately</option><option value={60}>1 hour</option><option value={1440}>1 day</option><option value={4320}>3 days</option><option value={10080}>7 days</option></select></label>
          <label className="workflow-approval"><input type="checkbox" checked={Boolean(selectedAction.approval_required)} onChange={(event) => updateAction({ approval_required: event.target.checked })} />REQUIRE HUMAN APPROVAL</label></>}
          {selectedAction.type === "add_note" && <><label>NOTE BODY<textarea value={selectedAction.body} maxLength={4000} onChange={(event) => updateAction({ body: event.target.value })} /></label>
            <TypedVariablePicker value={selectedAction.body} label="note body" maxLength={4000} recordType={recordType}
              priorActions={priorActions} customFields={props.customFields} onChange={(value) => updateAction({ body: value })} />
            <small>Written internally as the automation identity.</small></>}
          {selectedAction.type === "update_opportunity" && <><label>FIELD<select value={selectedAction.field} onChange={(event) => { const field = event.target.value as "next_step" | "owner" | "probability"; updateAction({ field, value: field === "probability" ? 50 : "" }); }}>
            <option value="next_step">Next step</option><option value="owner">Owner</option><option value="probability">Probability</option></select></label>
            <label>NEW VALUE<input type={selectedAction.field === "probability" ? "number" : "text"} min={0} max={selectedAction.field === "probability" ? 100 : undefined}
              value={selectedAction.value} onChange={(event) => updateAction({ value: selectedAction.field === "probability" ? Number(event.target.value) : event.target.value })} /></label>
            {selectedAction.field !== "probability" && <TypedVariablePicker value={String(selectedAction.value)} label="opportunity update" recordType={recordType}
              priorActions={priorActions} customFields={props.customFields}
              maxLength={selectedAction.field === "next_step" ? 500 : 254}
              onChange={(value) => updateAction({ value })} />}
            <div className="workflow-safety-callout"><b>HUMAN GATE REQUIRED</b><small>This creates a proposal in Agent Inbox. It never updates revenue data directly.</small></div></>}
          {selectedAction.type === "update_contact" && <><label>FIELD<select value={selectedAction.field}
            onChange={(event) => { const field = event.target.value as Extract<WorkflowAction, { type: "update_contact" }>["field"];
              const custom = field.startsWith("custom:") ? props.customFields.find((item) => `custom:${item.field_key}` === field) : undefined;
              updateAction({ field, value: field === "stage" ? "registered" : field === "status" ? "lead"
                : custom?.field_type === "number" ? 0 : custom?.field_type === "boolean" ? false
                  : custom?.field_type === "select" ? custom.options[0] || "" : "" }); }}>
            <option value="stage">Lead lifecycle</option><option value="status">Record status</option><option value="owner">Owner</option>
            {props.customFields.filter((field) => field.object_type === "contact" && field.active).map((field) =>
              <option key={field.field_key} value={`custom:${field.field_key}`}>{field.label} · {field.field_type}</option>)}</select></label>
            {selectedAction.field === "stage" ? <label>NEW VALUE<select value={String(selectedAction.value)} onChange={(event) => updateAction({ value: event.target.value })}>
              <option value="new">New</option><option value="registered">Registered</option><option value="confirmed">Confirmed</option>
              <option value="attended">Attended</option><option value="offer">Community Offer</option><option value="booked">Call Booked</option><option value="won">Converted</option>
            </select></label> : selectedAction.field === "status" ? <label>NEW VALUE<select value={String(selectedAction.value)} onChange={(event) => updateAction({ value: event.target.value })}>
              <option value="lead">Lead</option><option value="customer">Customer</option><option value="inactive">Inactive</option>
            </select></label> : selectedAction.field === "owner" ? <><label>NEW OWNER<input type="email" value={String(selectedAction.value)} maxLength={254}
              placeholder="Blank = unassigned" onChange={(event) => updateAction({ value: event.target.value })} /></label>
              <TypedVariablePicker value={String(selectedAction.value)} label="contact owner" maxLength={254} recordType={recordType}
                priorActions={priorActions} customFields={props.customFields}
                onChange={(value) => updateAction({ value })} /></> : (() => {
                  const field = props.customFields.find((item) => item.active && `custom:${item.field_key}` === selectedAction.field);
                  if (!field) return <small className="workflow-invalid">This governed field is unavailable. Choose another field before saving.</small>;
                  if (field.field_type === "boolean") return <label>NEW VALUE<select value={String(selectedAction.value)}
                    onChange={(event) => updateAction({ value: event.target.value === "true" })}>
                    <option value="true">Yes</option><option value="false">No</option></select></label>;
                  if (field.field_type === "select") return <label>NEW VALUE<select value={String(selectedAction.value)}
                    onChange={(event) => updateAction({ value: event.target.value })}>
                    {field.options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>;
                  return <label>NEW VALUE<input type={field.field_type === "date" ? "date" : field.field_type === "number" ? "number" : "text"}
                    value={String(selectedAction.value)} onChange={(event) => updateAction({
                      value: field.field_type === "number" ? Number(event.target.value) : event.target.value,
                    })} /></label>;
                })()}
            <div className="workflow-safety-callout"><b>HUMAN GATE REQUIRED</b><small>This creates an explainable proposal in Agent Inbox. The lead moves only after an owner or admin approves it against the unchanged record version.</small></div></>}
          {selectedAction.type === "request_agent" && <><label>OBJECTIVE<select value={selectedAction.objective} onChange={(event) => updateAction({ objective: event.target.value as "lead_research" | "deal_review" | "follow_up_draft" | "call_brief" })}>
            <option value="lead_research">Lead research</option><option value="deal_review">Deal review</option><option value="follow_up_draft">Follow-up draft</option><option value="call_brief">Call brief</option></select></label>
            <label>RUNTIME<select value={selectedAction.preferred_provider} onChange={(event) => updateAction({ preferred_provider: event.target.value as "any" | "openclaw" | "hermes" })}>
              <option value="any">Any connected agent</option><option value="openclaw">OpenClaw</option><option value="hermes">Hermes</option></select></label>
            <label>INSTRUCTIONS<textarea value={selectedAction.instructions} maxLength={1000} onChange={(event) => updateAction({ instructions: event.target.value })} /></label>
            <TypedVariablePicker value={selectedAction.instructions} label="agent instructions" maxLength={1000} recordType={recordType}
              priorActions={priorActions} customFields={props.customFields}
              onChange={(value) => updateAction({ instructions: value })} />
            <div className={`workflow-runtime-readiness ${selectedAgentObserved && props.agentAccessEnabled ? "ready" : selectedAgentConfigured && props.agentAccessEnabled ? "unverified" : "blocked"}`} role="status">
              <b>{!props.agentAccessEnabled ? "PICKUP PAUSED"
                : selectedAgentObserved ? "RUNTIME OBSERVED"
                  : selectedAgentConfigured ? "CREDENTIAL READY · RUNTIME UNVERIFIED" : "HANDOFF WILL QUEUE"}</b>
              <small>{!props.agentAccessEnabled
                ? "Workspace agent access is disabled. Handoffs remain queued until an owner re-enables it."
                : selectedAgentObserved
                  ? `${selectedAction.preferred_provider === "any" ? props.observedAgentProviders.join(" + ") : selectedAction.preferred_provider} has successfully used an active CRM credential before.`
                  : selectedAgentConfigured
                    ? `${selectedAction.preferred_provider === "any" ? props.availableAgentProviders.join(" + ") : selectedAction.preferred_provider} has an active credential, but this CRM has never observed that runtime use it.`
                  : `No active ${selectedAction.preferred_provider === "any" ? "OpenClaw or Hermes" : selectedAction.preferred_provider} credential is connected. Configure one in Integrations before expecting pickup.`}</small>
            </div>
            <div className="workflow-safety-callout"><b>SCOPED HANDOFF</b><small>The runtime receives record IDs and this objective. CRM text remains untrusted data; returned mutations become proposals.</small></div></>}
          {selectedAction.type === "publish_event" && (() => {
            const eventType = `${recordType}.workflow_event`;
            const subscribed = props.outboundWebhookEventTypes.includes("*") ||
              props.outboundWebhookEventTypes.includes(eventType);
            return <><div className={`workflow-runtime-readiness ${subscribed ? "ready" : "unverified"}`} role="status">
              <b>{subscribed ? "OUTBOUND SUBSCRIBER READY" : "NO MATCHING SUBSCRIBER"}</b>
              <small>{subscribed
                ? `Active outbound webhook(s) subscribe to ${eventType}. Delivery is signed, observable, and retried up to five times.`
                : `The workflow will still succeed with zero deliveries. Add an active outbound webhook for ${eventType} in Integrations.`}</small>
            </div>
            <div className="workflow-safety-callout"><b>FIXED EVENT CONTRACT</b><small>The server publishes workflow and current record fields only. This action cannot choose a URL, secret, event name, or arbitrary payload.</small></div></>;
          })()}
          {(elseActionIndex >= 0 || definition.actions.length > 1) && <button className="danger-link" type="button" onClick={() => {
            changeDefinition({ ...definition,
              actions: actionIndex < 0 ? definition.actions : definition.actions.filter((_, index) => index !== actionIndex),
              else_actions: elseActionIndex < 0 ? definition.else_actions : definition.else_actions.filter((_, index) => index !== elseActionIndex),
            }); setSelectedId("trigger");
          }}>REMOVE ACTION</button>}</>}
        <div className="workflow-add"><button type="button" className="secondary" disabled={definition.conditions.length >= 5} onClick={() => {
          const next = definition.conditions.length; changeDefinition({ ...definition, conditions: [...definition.conditions,
            recordType === "contact" ? { field: "stage", operator: "equals", value: "new" }
              : { field: "stage_id", operator: "equals", value: props.stages[0]?.id || "" }] }); setSelectedId(`condition-${next}`);
        }}>+ CONDITION</button><button type="button" className="secondary" disabled={definition.actions.length + definition.else_actions.length >= 20} onClick={() => {
          const next = definition.actions.length; changeDefinition({ ...definition, actions: [...definition.actions, { type: "create_task", title: "Follow up", priority: "normal", due_in_minutes: 1440 }] }); setSelectedId(`action-${next}`);
        }}>+ MATCH ACTION</button>
          <button type="button" className="secondary" disabled={!definition.conditions.length || definition.actions.length + definition.else_actions.length >= 20} onClick={() => {
            const next = definition.else_actions.length;
            changeDefinition({ ...definition, else_actions: [...definition.else_actions, { type: "create_task", title: `Escalate unmatched ${recordType}`, priority: "normal", due_in_minutes: 1440 }] });
            setSelectedId(`else-action-${next}`);
          }}>+ ELSE ACTION</button></div>
        <label>RUN LIMIT / RECORD<input type="number" min={1} max={20} value={definition.max_runs_per_record}
          onChange={(event) => changeDefinition({ ...definition, max_runs_per_record: Math.max(1, Math.min(20, Number(event.target.value) || 1)) })} /></label>
      </aside>
    </div>
  </section>;
}

export default function VisualAutomationBuilder(props: BuilderProps) {
  return <ReactFlowProvider><VisualAutomationCanvas {...props} /></ReactFlowProvider>;
}

function validConditionValue(condition: WorkflowCondition, customFields: BuilderProps["customFields"]) {
  const custom = condition.field.startsWith("custom:")
    ? customFields.find((field) => field.active && `custom:${field.field_key}` === condition.field) : undefined;
  if (condition.field.startsWith("custom:") && !custom) return false;
  if (["score", "probability", "value"].includes(condition.field) || custom?.field_type === "number") {
    return typeof condition.value === "number" && Number.isFinite(condition.value);
  }
  if (custom?.field_type === "boolean") return typeof condition.value === "boolean";
  return typeof condition.value === "string" && Boolean(condition.value.trim());
}
