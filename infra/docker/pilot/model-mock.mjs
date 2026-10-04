// Development/CI only: an OpenAI-compatible model stand-in for the deployed AI smoke (BUILD_PLAN 6.5). It answers the
// Guest Concierge deterministically — look at the services, create AC_PROBLEM, answer in Arabic — the Engineering
// Copilot (read the asset's history, answer naming it) and the Shift Handover (read the facts, quote them), so the
// pilot proves the real path: worker queue → concierge runtime → Model Gateway → OPENAI_COMPATIBLE adapter → tools → comms.
import { createServer } from 'node:http';
import { stdout } from 'node:process';

const REPLY = 'آسفين على الحر! بلّغنا فريق الصيانة وهيظبطوا التكييف حالًا.';

function completion(message, finishReason) {
  return {
    id: `mock-${Date.now()}`,
    object: 'chat.completion',
    choices: [
      { index: 0, message: { role: 'assistant', ...message }, finish_reason: finishReason },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 30 },
  };
}

function toolCall(name, args) {
  return completion(
    {
      content: null,
      tool_calls: [
        {
          id: `call-${name}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    'tool_calls',
  );
}

/**
 * The Engineering Copilot: read the open asset's history (its id is in the focus context), then answer naming the
 * asset number the tool returned — proof the answer came through engineering's tool.
 */
function copilot(messages, toolResults) {
  if (toolResults.length === 0) {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    const assetId = /asset_id ([0-9a-f-]{36})/.exec(system)?.[1];
    return toolCall('engineering__get_asset_history', { assetId });
  }
  const number = /"number":"([^"]+)"/.exec(toolResults.at(-1).content)?.[1] ?? 'the unit';
  return completion(
    {
      content: JSON.stringify({
        answer: `${number}: check the capacitor first, then the condensate drain.`,
      }),
    },
    'stop',
  );
}

/**
 * The Shift Handover assistant: read the shift's facts through the logbook's tool (department, date and shift are in
 * the request), then write a summary quoting the counts it returned — proof the numbers came from the platform.
 */
function handover(messages, toolResults) {
  if (toolResults.length === 0) {
    const request = messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
    const [, department, shift, date] =
      /department (\S+) for the (\w+) shift of (\d{4}-\d{2}-\d{2})/.exec(request) ?? [];
    return toolCall('logbook__get_shift_facts', {
      department_code: department,
      shift_date: date,
      shift,
    });
  }
  // The tool outcome arrives as JSON text (possibly cut short): read the counts from it as they appear.
  const result = toolResults.at(-1).content;
  const read = (pattern) => pattern.exec(result)?.[1] ?? '?';
  const department = read(/"department":"([A-Z0-9_]+)"/);
  const work = /"work":\{"open":(\d+),"urgent":(\d+)/.exec(result) ?? [];
  const incidents = read(/"incidents":(\d+)/);
  return completion(
    {
      content: JSON.stringify({
        answer: `${department}: ${incidents} incident, ${work[1] ?? '?'} open jobs (${work[2] ?? '?'} urgent).`,
      }),
    },
    'stop',
  );
}

/** The next turn of the concierge (or copilot) conversation, decided from what the model has already seen. */
function answer(body) {
  const messages = body.messages ?? [];
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  const toolResults = messages.slice(lastUser + 1).filter((m) => m.role === 'tool');
  const tools = (body.tools ?? []).map((t) => t.function.name);
  if (tools.includes('engineering__get_asset_history')) return copilot(messages, toolResults);
  if (tools.includes('logbook__get_shift_facts')) return handover(messages, toolResults);
  if (toolResults.length === 0 && tools.includes('catalog__list_services'))
    return toolCall('catalog__list_services', {});
  const last = toolResults.at(-1)?.content ?? '';
  if (toolResults.length === 1 && last.includes('"AC_PROBLEM"'))
    return toolCall('operations__create_service_request', {
      service_code: 'AC_PROBLEM',
      fields: { issue: 'TOO_HOT' },
    });
  return completion({ content: JSON.stringify({ reply: REPLY, handoff: null }) }, 'stop');
}

createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'ok' });
    if (req.method !== 'POST') return send(404, { error: 'not found' });
    const body = JSON.parse(raw || '{}');
    if (req.url === '/v1/chat/completions') return send(200, answer(body));
    if (req.url === '/v1/embeddings')
      return send(200, {
        data: (body.input ?? []).map((_, index) => ({ index, embedding: [1, 0, 0, 0] })),
        usage: { prompt_tokens: 1 },
      });
    return send(404, { error: 'not found' });
  });
}).listen(8080, () => stdout.write('model mock listening on 8080\n'));
