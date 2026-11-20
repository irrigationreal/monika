// Deterministic Responses fixture for subagents-workflow.mjs.
// It is intentionally stateful: parent turns drive the workflow while child
// turns receive a bounded text response. No external provider is contacted.
const fs = require('node:fs');
const http = require('node:http');

const log = '/output/subagents-requests.jsonl';
let parentPhase = 0;
let firstRunId = null;
let secondRunId = null;
let callNumber = 0;

function schemaError(schema, at = '()') {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) return `additionalProperties must be false at ${at}`;
    const properties = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    for (const key of Object.keys(properties)) {
      if (!required.has(key)) return `required is missing ${key} at ${at}`;
      const nested = schemaError(properties[key], `${at}.${key}`);
      if (nested) return nested;
    }
  }
  if (schema.items) return schemaError(schema.items, `${at}[]`);
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    for (const [index, item] of (schema[key] ?? []).entries()) {
      const nested = schemaError(item, `${at}.${key}[${index}]`);
      if (nested) return nested;
    }
  }
  return null;
}

function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => allStrings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => allStrings(item, out));
  return out;
}

function findRunId(value) {
  const text = allStrings(value).join('\n');
  // IDs are UUIDs in the package, but accepting the package's readable test
  // IDs too makes diagnostics useful if the candidate changes its generator.
  return text.match(/(?:run[_-])?[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0]
    ?? text.match(/run[-_][A-Za-z0-9-]{8,}/)?.[0]
    ?? null;
}

function response(res, body) {
  const id = `resp_canary_${++callNumber}`;
  const base = {
    id, object: 'response', status: 'completed', model: 'canary', output: [],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
  };
  const events = [
    { type: 'response.created', response: { ...base, status: 'in_progress' } },
    ...(body.output ?? []).flatMap((item, index) => [
      { type: 'response.output_item.added', output_index: index, item: { ...item, status: 'in_progress', ...(item.type === 'message' ? { content: [] } : {}) } },
      ...(item.type === 'message' ? [{ type: 'response.output_text.delta', output_index: index, content_index: 0, delta: item.content?.[0]?.text ?? '' }] : []),
      { type: 'response.output_item.done', output_index: index, item },
    ]),
    { type: 'response.completed', response: body },
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end('data: [DONE]\n\n');
}

function textResponse(res, text) {
  response(res, { id: 'ignored', object: 'response', status: 'completed', output: [{
    id: `msg_${callNumber}`, type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }] });
}

function functionResponse(res, name, args) {
  const callId = `call_canary_${callNumber + 1}`;
  response(res, { id: 'ignored', object: 'response', status: 'completed', output: [{
    id: `fc_${callNumber}`, type: 'function_call', call_id: callId, name,
    arguments: JSON.stringify(args), status: 'completed',
  }] });
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/responses') {
    res.writeHead(404); res.end(); return;
  }
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    let request;
    try { request = JSON.parse(raw); } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: { message: String(error) } })); return; }
    fs.appendFileSync(log, `${JSON.stringify(request)}\n`);
    const tools = request.tools ?? [];
    for (const tool of tools) {
      if (tool.type === 'function' && tool.strict === true) {
        const error = schemaError(tool.parameters);
        if (error) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: `invalid strict schema ${tool.name}: ${error}` } })); return; }
      }
    }
    const input = request.input ?? [];
    const functionOutputs = input.filter(item => item?.type === 'function_call_output');
    const hasSubagent = tools.some(tool => tool.name === 'subagent');
    const hasWait = tools.some(tool => tool.name === 'bg_wait');
    if (!hasSubagent || !hasWait) { res.writeHead(400); res.end(JSON.stringify({ error: { message: 'canary requires subagent and bg_wait' } })); return; }

    // Child Pi sessions have no function_call_output in their first request.
    // Keep their model turn deterministic, and hold stop-canary children long
    // enough for the parent to exercise durable workflow cancellation.
    if (functionOutputs.length === 0 && parentPhase > 0) {
      const childText = allStrings(input).some(value => value.includes('stop-canary')) ? 'CHILD_STOP_CANARY' : 'CHILD_CANARY_OK';
      const delay = childText === 'CHILD_STOP_CANARY' ? 4000 : 0;
      setTimeout(() => textResponse(res, childText), delay);
      return;
    }

    const outputText = functionOutputs.map(item => item.output).join('\n');
    const returnedRun = findRunId(outputText);
    if (parentPhase === 0) {
      parentPhase = 1;
      functionResponse(res, 'subagent', {
        chain: [
          { parallel: [
            { agent: 'scout', task: 'Return CANARY_ALLOW after a bounded read-only check.' },
            { agent: 'researcher', task: 'Return CANARY_ALLOW after a bounded read-only check.' },
          ] },
          { agent: 'planner', as: 'conditional', task: 'Conditional child: run only when both prior outputs contain CANARY_ALLOW; return CONDITIONAL_CANARY_OK.' },
        ],
        async: true, deliveryDisposition: 'awaited', timeoutMs: 20000,
      });
      return;
    }
    if (parentPhase === 1) {
      firstRunId = returnedRun;
      parentPhase = 2;
      functionResponse(res, 'bg_wait', { id: firstRunId, timeoutMs: 30000 });
      return;
    }
    if (parentPhase === 2) {
      parentPhase = 3;
      functionResponse(res, 'subagent', {
        chain: [
          { parallel: [
            { agent: 'scout', task: 'stop-canary: hold this child briefly and return STOP_CANARY.' },
            { agent: 'researcher', task: 'stop-canary: hold this child briefly and return STOP_CANARY.' },
          ] },
          { agent: 'planner', as: 'conditional-stop', task: 'Conditional child: only run when the stop-canary gate is met; return STOP_CONDITIONAL.' },
        ],
        async: true, deliveryDisposition: 'awaited', timeoutMs: 20000,
      });
      return;
    }
    if (parentPhase === 3) {
      secondRunId = returnedRun;
      parentPhase = 4;
      functionResponse(res, 'subagent', { action: 'stop', runId: secondRunId });
      return;
    }
    if (parentPhase === 4) {
      parentPhase = 5;
      functionResponse(res, 'bg_wait', { id: secondRunId, timeoutMs: 30000 });
      return;
    }
    textResponse(res, 'CANARY_OK');
  });
});
server.listen(7777, '0.0.0.0');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
