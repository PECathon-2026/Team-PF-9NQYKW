export type ReplyPhase = "plan" | "edit" | "review";
export const PLAN_ROLES = [
  "shogun",
  "samurai",
  "sentinel",
  "verifier",
  "shadow_review",
  "shadow_security",
] as const;

export const submitPlanTool = {
  type: "function",
  function: {
    name: "submit_plan",
    description:
      "Submit the final plan using the registered criterion IDs and at least one implementation task.",
    parameters: {
      type: "object",
      properties: {
        criteria: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              description: { type: "string" },
            },
            required: ["id", "description"],
            additionalProperties: false,
          },
        },
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              role: { type: "string", enum: [...PLAN_ROLES] },
              status: { type: "string" },
              owner: { type: "string", enum: [...PLAN_ROLES] },
              depends_on: { type: "array", items: { type: "string" } },
              criterion_ids: { type: "array", items: { type: "string" } },
            },
            required: ["id", "title"],
            additionalProperties: false,
          },
        },
        reason_event_ids: { type: "array", items: { type: "integer" } },
      },
      required: ["criteria", "tasks"],
      additionalProperties: false,
    },
  },
};

/** A final-turn tool gives every phase an explicit, schema-constrained exit. */
export function submitResultTool(phase: Exclude<ReplyPhase, "plan">) {
  const properties =
    phase === "edit"
      ? {
          done: { type: "boolean" },
          blocked: { type: "boolean" },
          question: { type: "string" },
        }
      : {
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                severity: {
                  type: "string",
                  enum: ["info", "low", "medium", "high", "critical"],
                },
                title: { type: "string" },
                detail: { type: "string" },
                in_scope: { type: "boolean" },
                addressed: { type: "boolean" },
                resolution_evidence: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    line: { type: "integer" },
                  },
                  additionalProperties: false,
                },
                evidence: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    line: { type: "integer" },
                    failing_case: { type: "string" },
                  },
                  additionalProperties: false,
                },
              },
              required: ["severity", "title", "detail"],
              additionalProperties: false,
            },
          },
          blocked: { type: "boolean" },
          question: { type: "string" },
        };
  return {
    type: "function",
    function: {
      name: "submit_result",
      description: "Submit your final result or a blocker with a question.",
      parameters: { type: "object", properties, additionalProperties: false },
    },
  };
}

/** Find the first syntactically valid JSON object, respecting strings and escapes. */
export function extractObject(content: unknown): Record<string, any> | null {
  const text = (
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => (typeof part?.text === "string" ? part.text : ""))
            .join("\n")
        : ""
  )
    .replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, "")
    .replace(/<think\b[^>]*>[\s\S]*$/gi, "")
    .replace(/```(?:json)?[ \t]*(?:\r?\n)?/gi, "")
    .slice(0, 262144);
  let starts = 0;
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue;
    if (++starts > 512) break;
    let depth = 0,
      inString = false,
      escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          const value = JSON.parse(text.slice(start, i + 1));
          if (value && typeof value === "object" && !Array.isArray(value))
            return value;
        } catch {}
        break;
      }
    }
  }
  return null;
}

export function validateReply(
  phase: ReplyPhase,
  value: unknown,
  criteria: { id: string }[] = [],
  baseline = false,
): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "Expected a JSON object.";
  const v = value as Record<string, any>;
  if (v.blocked === true)
    return typeof v.question === "string" && v.question.trim()
      ? null
      : "blocked=true requires a nonempty question string.";
  if (v.blocked !== undefined && typeof v.blocked !== "boolean")
    return "blocked must be a boolean.";
  if (phase === "edit")
    return v.done === true
      ? null
      : 'Expected {"done":true}, or {"blocked":true,"question":"..."}.';
  if (phase === "review") {
    if (!Array.isArray(v.findings)) return "findings must be an array.";
    if (v.findings.length > 100)
      return "findings must contain at most 100 entries.";
    for (let i = 0; i < v.findings.length; i++) {
      const f = v.findings[i];
      if (!f || typeof f !== "object" || Array.isArray(f))
        return `findings[${i}] must be an object.`;
      if (!["info", "low", "medium", "high", "critical"].includes(f.severity))
        return `findings[${i}].severity must be info, low, medium, high, or critical.`;
      if (typeof f.title !== "string" || !f.title.trim())
        return `findings[${i}].title must be a nonempty string.`;
      if (typeof f.detail !== "string")
        return `findings[${i}].detail must be a string.`;
    }
    return null;
  }
  if (!Array.isArray(v.criteria) || !v.criteria.length)
    return "criteria must be a nonempty array of {id, description} objects.";
  for (let i = 0; i < v.criteria.length; i++) {
    const c = v.criteria[i];
    if (
      !c ||
      typeof c.id !== "string" ||
      !c.id.trim() ||
      typeof c.description !== "string" ||
      !c.description.trim()
    )
      return `criteria[${i}] requires nonempty id and description strings.`;
  }
  const ids = v.criteria.map((c: any) => c.id);
  if (new Set(ids).size !== ids.length) return "criteria IDs must be unique.";
  if (
    criteria.length &&
    (ids.length !== criteria.length ||
      criteria.some((c) => !ids.includes(c.id)))
  )
    return `criteria IDs must exactly match the registered IDs: ${criteria.map((c) => c.id).join(", ")}.`;
  if (!Array.isArray(v.tasks) || !v.tasks.length)
    return "tasks must be a nonempty array of {id, title} objects.";
  const taskIds = new Set<string>();
  let hasEditor = false;
  for (let i = 0; i < v.tasks.length; i++) {
    const task = v.tasks[i];
    if (
      !task ||
      typeof task.id !== "string" ||
      !task.id.trim() ||
      typeof task.title !== "string" ||
      !task.title.trim()
    )
      return `tasks[${i}] requires nonempty id and title strings.`;
    if (taskIds.has(task.id)) return `tasks[${i}].id must be unique.`;
    taskIds.add(task.id);
    for (const field of ["role", "owner"]) {
      if (task[field] !== undefined && !PLAN_ROLES.includes(task[field]))
        return `tasks[${i}].${field} must be one of: ${PLAN_ROLES.join(", ")}. Use samurai for an implementer or editor.`;
    }
    const role = baseline ? "baseline" : task.role || task.owner || "samurai";
    if (role === (baseline ? "baseline" : "samurai")) hasEditor = true;
  }
  if (!hasEditor)
    return "tasks must include an implementation task assigned to samurai.";
  return null;
}

/** Apply the documented function-tool schema as well as the plan rules. */
export function validateSubmitPlan(
  value: unknown,
  criteria: { id: string }[] = [],
  baseline = false,
): string | null {
  const issue = validateReply("plan", value, criteria, baseline);
  if (issue) return issue;
  const plan = value as Record<string, any>;
  if (plan.blocked === true)
    return "submit_plan requires criteria and tasks; report a blocker as a JSON reply.";
  if (
    Object.keys(plan).some(
      (key) => !["criteria", "tasks", "reason_event_ids"].includes(key),
    )
  )
    return "submit_plan accepts only criteria, tasks, and reason_event_ids.";
  for (let i = 0; i < plan.criteria.length; i++) {
    if (
      Object.keys(plan.criteria[i]).some(
        (key) => !["id", "description"].includes(key),
      )
    )
      return `criteria[${i}] accepts only id and description.`;
  }
  for (let i = 0; i < plan.tasks.length; i++) {
    const task = plan.tasks[i];
    if (
      Object.keys(task).some(
        (key) =>
          ![
            "id",
            "title",
            "role",
            "status",
            "owner",
            "depends_on",
            "criterion_ids",
          ].includes(key),
      )
    )
      return `tasks[${i}] contains an unsupported field.`;
    for (const key of ["role", "status", "owner"])
      if (task[key] !== undefined && typeof task[key] !== "string")
        return `tasks[${i}].${key} must be a string.`;
    for (const key of ["depends_on", "criterion_ids"])
      if (
        task[key] !== undefined &&
        (!Array.isArray(task[key]) ||
          task[key].some((item: unknown) => typeof item !== "string"))
      )
        return `tasks[${i}].${key} must be an array of strings.`;
  }
  if (
    plan.reason_event_ids !== undefined &&
    (!Array.isArray(plan.reason_event_ids) ||
      plan.reason_event_ids.some((id: unknown) => !Number.isSafeInteger(id)))
  )
    return "reason_event_ids must be an array of integers.";
  return null;
}
