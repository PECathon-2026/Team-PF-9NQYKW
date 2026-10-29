export type BudgetConfig = {
  missionTurns?: number;
  roleTurns?: Record<string, number>;
};
export type TurnBudgets = { mission: number; roles: Record<string, number> };

/** Reviewer caps apply per candidate revision; all other caps apply per mission. */
export function turnBudgets(
  request: string,
  config: BudgetConfig = {},
): TurnBudgets {
  const feature = /\b(?:add|feature|implement|introduce|support)\b/i.test(
    request,
  );
  const configured =
    config.missionTurns ??
    (process.env.DEVPILOT_MISSION_TURN_LIMIT
      ? Number(process.env.DEVPILOT_MISSION_TURN_LIMIT)
      : undefined);
  if (
    configured !== undefined &&
    (!Number.isSafeInteger(configured) || configured < 1 || configured > 200)
  )
    throw Error("INVALID_TURN_LIMIT");
  const roles: Record<string, number> = {
    shogun: 6,
    samurai: feature ? 22 : 16,
    shadow_review: 8,
    shadow_security: 12,
    sentinel: 4,
    verifier: 4,
    baseline: feature ? 36 : 28,
  };
  for (const [role, limit] of Object.entries(config.roleTurns || {})) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw Error("INVALID_TURN_LIMIT");
    roles[role] = limit;
  }
  return { mission: configured ?? (feature ? 52 : 44), roles };
}
