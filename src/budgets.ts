export type BudgetConfig = {
  missionTurns?: number;
  missionTurnExtension?: number;
  missionTurnMax?: number;
  roleTurns?: Record<string, number>;
};
export type TurnBudgets = {
  mission: number;
  extension: number;
  max: number;
  roles: Record<string, number>;
};

export function effectiveMissionCap(
  budgets: TurnBudgets,
  fixes: number,
): number {
  return Math.min(budgets.max, budgets.mission + fixes * budgets.extension);
}

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
  const mission = configured ?? (feature ? 52 : 44);
  const envInteger = (name: string, fallback: number) => {
    const value = process.env[name];
    return value === undefined ? fallback : Number(value);
  };
  const extension =
    config.missionTurnExtension ??
    envInteger("DEVPILOT_TURN_EXTENSION_PER_FIX", 16);
  const max =
    config.missionTurnMax ??
    envInteger("DEVPILOT_MAX_MISSION_TURNS", Math.max(100, mission));
  if (
    !Number.isSafeInteger(extension) ||
    extension < 0 ||
    extension > 200 ||
    !Number.isSafeInteger(max) ||
    max < mission ||
    max > 200
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
  return { mission, extension, max, roles };
}
