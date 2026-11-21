// Deterministic Responses fixture for subagents-workflow.mjs.
// The parent is identified by its explicit canary prompt tag. Child requests
// are identified by a task marker, not by their tool declarations: children
// intentionally do not receive the parent's orchestration tools.
const fs = require('node:fs');
const http = require('node:http');

const log = '/output/subagents-requests.jsonl';
const PARENT_TAG = 'SUBAGENTS_CANARY_PARENT_V2';
const CHILD_TAG = 'SUBAGENTS_CANARY_CHILD_V2';
let parentPhase = 0;
let parentSeen = false;
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
  return text.match(/(?:run[_-])?[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0]
    ?? text.match(/run[-_][A-Za-z0-9-]{8,}/)?.[0]
    ?? null;
}

function response(res, body) {
  const id = `resp_canary_${++callNumber}`;
  const base = {
    id, object: 'response', status: 'completed', model: 'schema-smoke', output: [],
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

function functionResponse(res, name, args, text = '') {
  const callId = `call_canary_${callNumber + 1}`;
  const output = [];
  if (text) output.push({
    id: `msg_${callNumber}`, type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  });
  output.push({
    id: `fc_${callNumber}`, type: 'function_call', call_id: callId, name,
    arguments: JSON.stringify(args), status: 'completed',
  });
  response(res, { id: 'ignored', object: 'response', status: 'completed', output });
}

const FIRST_WORKFLOW = `const lanes = await Promise.all([
  runs.run("first-scout", { label: "parallel-first-scout", agent: "scout", model: "mock-openai/schema-smoke", task: "${CHILD_TAG} FIRST: return CANARY_ALLOW." }),
  runs.run("first-researcher", { label: "parallel-first-researcher", agent: "researcher", model: "mock-openai/schema-smoke", task: "${CHILD_TAG} FIRST: return CANARY_ALLOW." })
]);
const allowed = lanes.every((child) => child.ok === true && child.output.includes("CANARY_ALLOW"));
if (allowed) {
  const conditional = await runs.run("first-conditional", { label: "conditional", agent: "planner", model: "mock-openai/schema-smoke", task: "${CHILD_TAG} CONDITIONAL: return CONDITIONAL_CANARY_OK." });
  return { parallel: lanes.map((child) => child.output), conditional: conditional.output, conditionalRan: true };
}
return { parallel: lanes.map((child) => child.output), conditionalRan: false };`;

const STOP_WORKFLOW = `const children = await Promise.all([
  runs.run("stop-scout", { label: "parallel-stop-scout", agent: "scout", model: "mock-openai/schema-smoke", task: "${CHILD_TAG} STOP: hold briefly and return STOP_CANARY." }),
  runs.run("stop-researcher", { label: "parallel-stop-researcher", agent: "researcher", model: "mock-openai/schema-smoke", task: "${CHILD_TAG} STOP: hold briefly and return STOP_CANARY." })
]);
if (children.every((child) => child.ok === true && child.output.includes("STOP_CANARY"))) {
  const conditional = await runs.run("stop-conditional", { label: "conditional-stop", agent: "planner", model: "mock-openai/schema-smoke", task: "${CHILD_TAG} STOP-CONDITIONAL: return STOP_CONDITIONAL." });
  return { children: children.map((child) => child.output), conditional: conditional.output };
}
return { children: children.map((child) => child.output), conditionalRan: false };`;

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
    const strings = allStrings(input);
    // The parent history contains the workflow source (including CHILD_TAG),
    // so only a user-role task marker identifies a child request.
    const isChild = input.some(item => item?.role === 'user' && allStrings(item).some(value => value.includes(CHILD_TAG)));
    const isParentTag = input.some(item => item?.role === 'user' && allStrings(item).some(value => value.includes(PARENT_TAG)));

    // Child profiles deliberately lack subagent/bg_wait. Their task marker is
    // the authoritative identity boundary, and their response is always text.
    if (isChild) {
      const stopping = strings.some(value => value.includes(`${CHILD_TAG} STOP`));
      const text = stopping ? 'STOP_CANARY' : strings.some(value => value.includes('CONDITIONAL')) ? 'CONDITIONAL_CANARY_OK' : 'CANARY_ALLOW';
      // Keep stop-canary children pending until cancellation, not a short
      // race against image/SDK startup on a slower architecture. The host
      // harness has its own bounded timeout; closing the model transport
      // cancels this safety timer without generating another child turn.
      const timer = setTimeout(() => textResponse(res, text), stopping ? 180_000 : 0);
      res.once('close', () => clearTimeout(timer));
      return;
    }
    if (parentPhase === 0 && !isParentTag) {
      res.writeHead(400); res.end(JSON.stringify({ error: { message: `parent canary tag ${PARENT_TAG} missing` } })); return;
    }
    parentSeen ||= isParentTag;
    if (!parentSeen) {
      res.writeHead(400); res.end(JSON.stringify({ error: { message: 'unclassified model request' } })); return;
    }

    const functionOutputs = input.filter(item => item?.type === 'function_call_output');
    const hasSubagent = tools.some(tool => tool.name === 'subagent');
    const hasWait = tools.some(tool => tool.name === 'bg_wait');
    if (!hasSubagent || !hasWait) { res.writeHead(400); res.end(JSON.stringify({ error: { message: 'parent canary requires subagent and bg_wait' } })); return; }
    const outputText = functionOutputs.map(item => item.output).join('\n');
    const returnedRun = findRunId(outputText);

    if (parentPhase === 0) {
      parentPhase = 1;
      functionResponse(res, 'subagent', { workflow: true, async: true }, `
\`\`\`js workflow
${FIRST_WORKFLOW}
\`\`\``);
      return;
    }
    if (parentPhase === 1) {
      parentPhase = 2;
      if (!returnedRun) { res.writeHead(400); res.end(JSON.stringify({ error: { message: 'first workflow receipt missing run id' } })); return; }
      functionResponse(res, 'bg_wait', { id: returnedRun, timeoutMs: 60000 });
      return;
    }
    if (parentPhase === 2) {
      parentPhase = 3;
      functionResponse(res, 'subagent', { workflow: true, async: true }, `
\`\`\`js workflow
${STOP_WORKFLOW}
\`\`\``);
      return;
    }
    // The host, not a model action, cancels the stopped workflow through the
    // canonical conversation interrupt route after this response is published.
    textResponse(res, 'CANARY_OK STOP_WORKFLOW_STARTED');
  });
});
server.listen(7777, '0.0.0.0');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
