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
    const response = await fetch("https://api.minimax.io/v1/chat/completions", {
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
      }),
      signal,
    });
    if (!response.ok) throw Error(`MODEL_HTTP_${response.status}`);
    const body: any = await response.json();
    const message = body.choices?.[0]?.message;
    if (!message || message.role !== "assistant")
      throw Error("MODEL_RESPONSE_INVALID");
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
