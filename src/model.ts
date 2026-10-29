export type Message = {
  role: string;
  content?: any;
  tool_calls?: any;
  tool_call_id?: string;
  [key: string]: any;
};
export type Model = {
  complete: (
    role: string,
    messages: Message[],
    tools: any[],
    signal: AbortSignal,
  ) => Promise<any>;
};
export class MiniMax implements Model {
  async complete(
    role: string,
    messages: Message[],
    tools: any[],
    signal: AbortSignal,
  ) {
    const key =
      process.env.MINIMAX_API_KEY || process.env.MINIMAX_TOKEN_PLAN_KEY;
    if (!key) throw Error("MODEL_KEY_MISSING");
    const reasoningEffort = process.env.DEVPILOT_REASONING_EFFORT || "low";
    if (!["low", "medium", "high", "xhigh", "max"].includes(reasoningEffort))
      throw Error("MODEL_CONFIGURATION_INVALID");
    const response = await fetchWithRetry(
      "https://api.minimax.io/v1/chat/completions",
      {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "MiniMax-M3.1-Flash",
        messages,
        tools,
        tool_choice: "auto",
        reasoning_effort: reasoningEffort,
      }),
      signal,
    },
      signal,
    );
    if (!response.ok) throw Error(`MODEL_HTTP_${response.status}`);
    const raw = await response.text();
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      return {
        message: { role: "invalid", content: raw.slice(0, 16384) },
        usage: undefined,
      };
    }
    const message = body?.choices?.[0]?.message;
    if (!message || message.role !== "assistant")
      return {
        message: { role: "invalid", content: raw.slice(0, 16384) },
        usage: body?.usage,
      };
    return { message, usage: body.usage };
  }
}
export class MockModel implements Model {
  private index: Record<string, number> = {};
  constructor(private script: Record<string, any[]>) {}
  async complete(
    role: string,
    _messages: Message[],
    _tools: any[],
    _signal: AbortSignal,
  ) {
    const i = this.index[role] || 0;
    this.index[role] = i + 1;
    const m = this.script[role]?.[i];
    if (!m) throw Error("MOCK_SCRIPT_EXHAUSTED");
    const message = structuredClone(m);
    const usage = message.usage;
    delete message.usage;
    return { message, usage };
  }
}

export const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Retry 429/5xx/network errors with exponential backoff + jitter, honoring Retry-After and the abort signal. */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  opts: {
    attempts?: number;
    baseMs?: number;
    maxMs?: number;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {},
): Promise<Response> {
  const attempts = opts.attempts ?? Number(process.env.DEVPILOT_MODEL_RETRIES || 4);
  const baseMs = opts.baseMs ?? 500;
  const maxMs = opts.maxMs ?? 8000;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? abortableSleep;
  for (let attempt = 1; ; attempt++) {
    let response: Response | undefined;
    try {
      response = await doFetch(url, { ...init, signal });
    } catch (error) {
      if (signal.aborted || attempt >= attempts) throw error;
    }
    if (response && (!RETRY_STATUSES.has(response.status) || attempt >= attempts))
      return response;
    let delay = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
    delay = delay / 2 + Math.random() * (delay / 2);
    const retryAfter = response?.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      const ms = Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(retryAfter) - Date.now();
      if (Number.isFinite(ms) && ms > 0) delay = Math.min(maxMs, ms);
    }
    await response?.body?.cancel().catch(() => {});
    await sleep(delay, signal);
  }
}

function abortableSleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? Error("aborted"));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason ?? Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
