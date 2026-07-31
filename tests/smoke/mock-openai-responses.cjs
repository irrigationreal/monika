// OpenAI Responses fixture used by monika-runtime.sh. It deliberately enforces
// OpenAI strict-function schema rules so the smoke test catches invalid tool
// declarations before a runtime image can reach production.
const fs = require('node:fs');
const http = require('node:http');

const requestFile = '/output/request.json';

function strictSchemaError(schema, path = '()') {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) {
      return `In context=${path}, 'additionalProperties' is required to be supplied and to be false.`;
    }
    const properties = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    for (const key of Object.keys(properties)) {
      if (!required.has(key)) {
        return `In context=${path}, 'required' must include every key in properties. Missing '${key}'.`;
      }
      const nested = strictSchemaError(properties[key], `${path}.${key}`);
      if (nested) return nested;
    }
  }
  if (schema.items) {
    const nested = strictSchemaError(schema.items, `${path}[]`);
    if (nested) return nested;
  }
  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    for (const [index, child] of (schema[keyword] ?? []).entries()) {
      const nested = strictSchemaError(child, `${path}.${keyword}[${index}]`);
      if (nested) return nested;
    }
  }
  return null;
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/responses') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
    return;
  }

  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = JSON.parse(raw);
    fs.writeFileSync(requestFile, JSON.stringify(body, null, 2));
    console.log(`mock model received ${body.tools?.length ?? 0} tools`);
    const functionToolNames = new Set(
      (body.tools ?? [])
        .filter((tool) => tool.type === 'function' && typeof tool.name === 'string')
        .map((tool) => tool.name),
    );
    const requiredTools = ['pi_run', 'browser', 'subagent', 'subagent_wait', 'subagent_supervisor'];
    const missingTools = requiredTools.filter((name) => !functionToolNames.has(name));
    if (missingTools.length > 0) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Expected package tools in model request; missing: ${missingTools.join(', ')}` } }));
      return;
    }
    if (functionToolNames.has('delegate')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: "Legacy 'delegate' tool must not be registered." } }));
      return;
    }
    for (const tool of body.tools ?? []) {
      if (tool.type !== 'function' || tool.strict !== true) continue;
      const schemaError = strictSchemaError(tool.parameters);
      if (schemaError) {
        console.error(`mock model rejected ${tool.name}: ${schemaError}`);
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: `Invalid schema for function '${tool.name}': ${schemaError}`,
            type: 'invalid_request_error',
          },
        }));
        return;
      }
    }

    const response = {
      id: 'resp_schema_smoke',
      object: 'response',
      status: 'completed',
      model: 'schema-smoke',
      output: [{
        id: 'msg_schema_smoke',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'OK', annotations: [] }],
      }],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
    const events = [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...response.output[0], status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'OK' },
      { type: 'response.output_item.done', output_index: 0, item: response.output[0] },
      { type: 'response.completed', response },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
server.listen(7777, '0.0.0.0');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
