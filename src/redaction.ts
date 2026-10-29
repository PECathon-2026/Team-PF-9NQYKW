/** Redact provider credentials and common secret fields before persisting output. */
export function redact(value: any, key = "", maxString = 16000): any {
  if (/api[_-]?key|token(?!s$)|password|secret|authorization/i.test(key))
    return "[REDACTED]";
  if (typeof value === "string") {
    let cleaned = value;
    for (const secret of [
      process.env.MINIMAX_API_KEY,
      process.env.MINIMAX_TOKEN_PLAN_KEY,
    ]) {
      if (secret) cleaned = cleaned.split(secret).join("[REDACTED]");
    }
    return cleaned
      .replace(/(bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}/gi, "[REDACTED]")
      .replace(
        /((?:api[_-]?key|token|password|secret)["'\s]*[:=]\s*["']?)[^\s,}\]"']+/gi,
        "$1[REDACTED]",
      )
      .slice(0, maxString);
  }
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => redact(item, "", maxString));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([name, item]) => [name, redact(item, name, maxString)]),
    );
  return value;
}
