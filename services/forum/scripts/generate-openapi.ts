import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildOpenApiDocument } from '../packages/contracts/src/openapi';

const document = buildOpenApiDocument({
  title: 'Codex Forum API',
  version: '0.1.0',
  serverUrl: '/api'
});

const outputPath = resolve(process.cwd(), 'docs', 'openapi.json');
writeFileSync(outputPath, JSON.stringify(document, null, 2));

console.log(`OpenAPI spec written to ${outputPath}`);
