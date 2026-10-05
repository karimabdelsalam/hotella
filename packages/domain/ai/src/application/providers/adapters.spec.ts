import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from './anthropic';
import { OpenAiCompatibleProvider } from './openai-compatible';
import { type FetchLike, type ModelProviderError, type ProviderContext } from './types';

/** Records requests and answers with a canned response, like the provider would. */
function recorder(status: number, body: unknown) {
  const calls: Array<{
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }> = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchFn };
}
const ctx = (key: string | null, baseUrl: string | null = null): ProviderContext => ({
  providerCode: 'P',
  baseUrl,
  credential: async () => key,
});
const tool = {
  name: 'operations_create_service_request',
  description: 'Create a service request',
  parameters: { type: 'object', properties: { serviceCode: { type: 'string' } } },
};

describe('OpenAI-compatible adapter (OpenAI and on-prem servers)', () => {
  it('sends chat with tools and reads tool calls and usage', async () => {
    const r = recorder(200, {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: tool.name, arguments: '{"serviceCode":"AC_PROBLEM"}' },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 15,
        prompt_tokens_details: { cached_tokens: 100 },
      },
    });
    const out = await new OpenAiCompatibleProvider(r.fetchFn).complete(ctx('sk-test'), {
      model: 'gpt-x',
      messages: [
        { role: 'system', content: 'You are the concierge.' },
        { role: 'user', content: 'الجو حر أوي هنا' },
      ],
      tools: [tool],
    });
    expect(r.calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(r.calls[0]!.headers.authorization).toBe('Bearer sk-test');
    expect(r.calls[0]!.body).toMatchObject({
      model: 'gpt-x',
      messages: [
        { role: 'system', content: 'You are the concierge.' },
        { role: 'user', content: 'الجو حر أوي هنا' },
      ],
      tools: [{ type: 'function', function: { name: tool.name } }],
    });
    expect(out).toEqual({
      content: null,
      toolCalls: [{ id: 'call_1', name: tool.name, arguments: { serviceCode: 'AC_PROBLEM' } }],
      finishReason: 'tool_calls',
      usage: { input: 120, output: 15, cached: 100 },
    });
  });

  it('talks to an on-prem server without a key; tool results go back as tool messages', async () => {
    const r = recorder(200, {
      choices: [{ finish_reason: 'stop', message: { content: 'تم.' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
    await new OpenAiCompatibleProvider(r.fetchFn).complete(ctx(null, 'http://llm.local:8000/v1/'), {
      model: 'qwen',
      messages: [
        { role: 'user', content: 'x' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'c1', name: 'a_b', arguments: { x: 1 } }],
        },
        { role: 'tool', toolCallId: 'c1', content: '{"ok":true}' },
      ],
    });
    expect(r.calls[0]!.url).toBe('http://llm.local:8000/v1/chat/completions');
    expect(r.calls[0]!.headers.authorization).toBeUndefined();
    expect((r.calls[0]!.body.messages as unknown[])[2]).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: '{"ok":true}',
    });
  });

  it('embeds in input order', async () => {
    const r = recorder(200, {
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ],
      usage: { prompt_tokens: 4 },
    });
    const out = await new OpenAiCompatibleProvider(r.fetchFn).embed(ctx('k'), {
      model: 'emb',
      inputs: ['a', 'b'],
    });
    expect(out.vectors).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it('maps provider errors to retryable or final codes', async () => {
    const call = (status: number, body: unknown = {}) =>
      new OpenAiCompatibleProvider(recorder(status, body).fetchFn)
        .complete(ctx('k'), { model: 'm', messages: [{ role: 'user', content: 'x' }] })
        .catch((e: unknown) => e as ModelProviderError);
    expect(await call(429)).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(await call(503)).toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    expect(await call(401)).toMatchObject({ code: 'AUTH_FAILED', retryable: false });
    expect(
      await call(400, { error: { message: "This model's maximum context length is 8192" } }),
    ).toMatchObject({
      code: 'CONTEXT_TOO_LONG',
    });
    const down = await new OpenAiCompatibleProvider(async () => {
      throw new TypeError('fetch failed');
    })
      .complete(ctx('k'), { model: 'm', messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e as ModelProviderError);
    expect(down).toMatchObject({ code: 'UNAVAILABLE', retryable: true });
  });
});

describe('Anthropic adapter', () => {
  it('sends the system prompt apart, tools as input schemas, and reads tool use', async () => {
    const r = recorder(200, {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'tu_1', name: tool.name, input: { serviceCode: 'AC_PROBLEM' } },
      ],
      usage: { input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 150 },
    });
    const out = await new AnthropicProvider(r.fetchFn).complete(ctx('ak'), {
      model: 'claude-x',
      messages: [
        { role: 'system', content: 'Platform rules.' },
        { role: 'system', content: 'Concierge.' },
        { role: 'user', content: 'الجو حر أوي هنا' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'tu_0', name: 'guest_stay', arguments: {} }],
        },
        { role: 'tool', toolCallId: 'tu_0', content: '{"room":"504"}' },
      ],
      tools: [tool],
    });
    const sent = r.calls[0]!;
    expect(sent.url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent.headers).toMatchObject({ 'x-api-key': 'ak', 'anthropic-version': '2023-06-01' });
    expect(sent.body).toMatchObject({
      model: 'claude-x',
      system: 'Platform rules.\n\nConcierge.',
      tools: [{ name: tool.name, input_schema: tool.parameters }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'الجو حر أوي هنا' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_0', name: 'guest_stay', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_0', content: '{"room":"504"}' }],
        },
      ],
    });
    expect(out).toEqual({
      content: 'Let me check.',
      toolCalls: [{ id: 'tu_1', name: tool.name, arguments: { serviceCode: 'AC_PROBLEM' } }],
      finishReason: 'tool_calls',
      usage: { input: 200, output: 30, cached: 150 },
    });
  });

  it('asks for structured output as a forced tool and returns its input as JSON', async () => {
    const r = recorder(200, {
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'tu_9', name: 'reply', input: { text: 'تم', handoff: null } },
      ],
      usage: { input_tokens: 5, output_tokens: 5 },
    });
    const out = await new AnthropicProvider(r.fetchFn).complete(ctx('ak'), {
      model: 'claude-x',
      messages: [{ role: 'user', content: 'x' }],
      jsonSchema: { name: 'reply', schema: { type: 'object' } },
    });
    expect(r.calls[0]!.body).toMatchObject({ tool_choice: { type: 'tool', name: 'reply' } });
    expect(JSON.parse(out.content!)).toEqual({ text: 'تم', handoff: null });
    expect(out.toolCalls).toEqual([]);
  });

  it('needs a key', async () => {
    await expect(
      new AnthropicProvider(recorder(200, {}).fetchFn).complete(ctx(null), {
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });
});

describe('images for the VISION capability (BUILD_PLAN 9.5)', () => {
  const image = { mediaType: 'image/jpeg' as const, base64: 'AAEC' };
  const messages = [
    { role: 'system' as const, content: 'Describe the object.' },
    { role: 'user' as const, content: 'What is this?', images: [image] },
  ];

  it('Anthropic: a base64 image block before the text of the user turn', async () => {
    const r = recorder(200, {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'A pair of sunglasses' }],
      usage: { input_tokens: 900, output_tokens: 6 },
    });
    await new AnthropicProvider(r.fetchFn).complete(ctx('k'), { model: 'm', messages });
    expect(r.calls[0]!.body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAEC' } },
          { type: 'text', text: 'What is this?' },
        ],
      },
    ]);
  });

  it('OpenAI-compatible: an image_url data URL part before the text part', async () => {
    const r = recorder(200, {
      choices: [{ finish_reason: 'stop', message: { content: 'A pair of sunglasses' } }],
      usage: { prompt_tokens: 900, completion_tokens: 6 },
    });
    await new OpenAiCompatibleProvider(r.fetchFn).complete(ctx('k'), { model: 'm', messages });
    expect((r.calls[0]!.body.messages as unknown[])[1]).toEqual({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAEC' } },
        { type: 'text', text: 'What is this?' },
      ],
    });
  });

  it('a text-only turn keeps its plain shape', async () => {
    const r = recorder(200, {
      choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
    });
    await new OpenAiCompatibleProvider(r.fetchFn).complete(ctx('k'), {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.calls[0]!.body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});
