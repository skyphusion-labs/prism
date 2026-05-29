// Text-model output + usage extraction (v0.21.0).
//
// Extracted from src/index.ts so these pure functions are unit-testable
// without importing index.ts (which pulls in `cloudflare:workers` and so
// can't be loaded under the plain-Node vitest pool). Mirrors the same
// extraction discipline used for parsers, chunking, discord, and ai-binding.
//
// Both functions normalize the many response shapes that reach the
// non-streaming chat path. The shapes come from: Workers AI hosted models
// (env.AI.run), Anthropic Messages API, Bedrock Converse (Nova) and
// InvokeModel (Pegasus), and OpenAI-style responses (both chat-completions
// and the Responses API) returned by unified-billing proxied models routed
// through env.AI.run. New shapes should be added here with a unit test in
// tests/output-extract.test.ts rather than inlined at a call site.

export function extractOutput(result: unknown): string {
  if (typeof result === "string") return result;
  const r = result as Record<string, unknown>;

  if (typeof r?.response === "string") return r.response;
  if (typeof r?.result === "string")   return r.result;

  // OpenAI chat-completions shape (also what AI Gateway returns for most
  // proxied OpenAI/OpenAI-compatible chat models): { choices: [{ message }] }
  const choices = r?.choices as Array<{ message?: { content?: string } }> | undefined;
  if (Array.isArray(choices) && typeof choices[0]?.message?.content === "string") {
    return choices[0].message.content;
  }

  // Anthropic Messages API: top-level content array
  const content = r?.content as Array<{ type?: string; text?: string }> | undefined;
  if (Array.isArray(content)) {
    const text = content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    if (text) return text;
  }

  // Bedrock Converse API (Nova family): { output: { message: { content: [{ text }] } } }
  const bedrockOutput = r?.output as { message?: { content?: Array<{ text?: string }> } } | undefined;
  if (bedrockOutput?.message?.content) {
    const text = bedrockOutput.message.content
      .map((c) => c.text ?? "")
      .join("");
    if (text) return text;
  }

  // Bedrock Pegasus 1.2 (InvokeModel): { message: "...", finishReason: "..." }
  // Some versions return { generations: [{ text }] } instead - cover both.
  if (typeof r?.message === "string") return r.message as string;
  const generations = r?.generations as Array<{ text?: string }> | undefined;
  if (Array.isArray(generations) && typeof generations[0]?.text === "string") {
    return generations[0].text;
  }

  // OpenAI Responses API shape (used by gpt-5.x-pro and similar): a top-level
  // `output` array of items, each with a `content` array of typed blocks.
  // Output text lives in blocks of type "output_text" (or plain "text").
  const out = r?.output as Array<unknown> | undefined;
  if (Array.isArray(out)) {
    const text = out
      .flatMap((block) => {
        const b = block as { content?: Array<{ type?: string; text?: string }> };
        return (b?.content ?? [])
          .filter((c) => c?.type === "output_text" || c?.type === "text")
          .map((c) => c.text ?? "");
      })
      .join("");
    if (text) return text;
  }

  return JSON.stringify(result);
}

export function extractUsage(result: unknown): { in_: number | null; out_: number | null } {
  const r = result as Record<string, unknown>;
  // OpenAI / Anthropic / Bedrock: usage object on result.
  // OpenAI uses prompt_tokens/completion_tokens; Anthropic uses input_tokens/output_tokens;
  // Bedrock Converse uses inputTokens/outputTokens (camelCase).
  const u = r?.usage as Record<string, number> | undefined;
  if (u) {
    return {
      in_:  u.prompt_tokens ?? u.input_tokens ?? u.inputTokens ?? null,
      out_: u.completion_tokens ?? u.output_tokens ?? u.outputTokens ?? null,
    };
  }
  return { in_: null, out_: null };
}
