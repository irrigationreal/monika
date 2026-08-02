<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

type OpenApiSpec = {
  info?: { title?: string; version?: string; description?: string };
  servers?: { url: string }[];
  tags?: { name: string; description?: string }[];
  paths?: Record<string, Record<string, OpenApiOperation>>;
};

type OpenApiOperation = {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: {
    content?: Record<string, { schema?: unknown }>;
  };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: unknown }> }>;
};

type OpenApiParameter = {
  name?: string;
  in?: string;
  required?: boolean;
  schema?: unknown;
  description?: string;
};

type ApiOpEntry = {
  id: string;
  method: string;
  path: string;
  tag: string;
  summary: string;
  description: string;
  parameters: OpenApiParameter[];
  requestSchemas: Array<{ contentType: string; schema: unknown }>;
  responses: Array<{ code: string; description: string; contentType: string; schema: unknown }>;
};

const spec = ref<OpenApiSpec | null>(null);
const isLoading = ref(false);
const errorMessage = ref('');
const search = ref('');

const openApiUrl = computed(() => {
  if (typeof window === 'undefined') return '/api/openapi.json';
  return `${window.location.origin}/api/openapi.json`;
});

const baseUrl = computed(() => {
  if (typeof window === 'undefined') return '/api';
  return `${window.location.origin}/api`;
});

const apiTitle = computed(() => spec.value?.info?.title ?? 'Codex Forum API');
const apiVersion = computed(() => spec.value?.info?.version ?? '0.1.0');
const apiDescription = computed(() => spec.value?.info?.description ?? '');

const tagDescriptions = computed(() => {
  const map = new Map<string, string>();
  for (const tag of spec.value?.tags ?? []) {
    if (tag.name) {
      map.set(tag.name, tag.description ?? '');
    }
  }
  return map;
});

const operations = computed<ApiOpEntry[]>(() => {
  const paths = spec.value?.paths ?? {};
  const entries: ApiOpEntry[] = [];
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const normalizedMethod = method.toUpperCase();
      if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(normalizedMethod)) continue;
      const tag = operation.tags?.[0] ?? 'General';
      const summary = operation.summary ?? operation.operationId ?? `${normalizedMethod} ${path}`;
      const description = operation.description ?? '';
      const parameters = operation.parameters ?? [];

      const requestSchemas: Array<{ contentType: string; schema: unknown }> = [];
      for (const [contentType, payload] of Object.entries(operation.requestBody?.content ?? {})) {
        requestSchemas.push({ contentType, schema: payload.schema ?? {} });
      }

      const responses: Array<{ code: string; description: string; contentType: string; schema: unknown }> = [];
      for (const [code, response] of Object.entries(operation.responses ?? {})) {
        const content = response.content ?? {};
        const contentEntries = Object.entries(content);
        if (contentEntries.length === 0) {
          responses.push({
            code,
            description: response.description ?? '',
            contentType: 'application/json',
            schema: {},
          });
        } else {
          for (const [contentType, body] of contentEntries) {
            responses.push({
              code,
              description: response.description ?? '',
              contentType,
              schema: body.schema ?? {},
            });
          }
        }
      }

      entries.push({
        id: `${normalizedMethod}-${path}`.replace(/[^\w-]/g, '-'),
        method: normalizedMethod,
        path,
        tag,
        summary,
        description,
        parameters,
        requestSchemas,
        responses,
      });
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
});

const filteredOperations = computed(() => {
  const term = search.value.trim().toLowerCase();
  if (!term) return operations.value;
  return operations.value.filter((entry) => {
    const haystack = [entry.path, entry.method, entry.summary, entry.description, entry.tag].join(' ').toLowerCase();
    return haystack.includes(term);
  });
});

const groupedOperations = computed(() => {
  const groups = new Map<string, ApiOpEntry[]>();
  for (const entry of filteredOperations.value) {
    const list = groups.get(entry.tag) ?? [];
    list.push(entry);
    groups.set(entry.tag, list);
  }
  return Array.from(groups.entries()).map(([tag, items]) => ({
    tag,
    description: tagDescriptions.value.get(tag) ?? '',
    items: items.slice().sort((a, b) => a.path.localeCompare(b.path)),
  }));
});

function formatSchema(schema: unknown): string {
  try {
    return JSON.stringify(schema ?? {}, null, 2);
  } catch {
    return String(schema ?? '');
  }
}

async function loadSpec(): Promise<void> {
  isLoading.value = true;
  errorMessage.value = '';
  try {
    const res = await fetch(openApiUrl.value, { credentials: 'same-origin' });
    if (!res.ok) {
      throw new Error(`Failed to load OpenAPI: ${res.status}`);
    }
    spec.value = (await res.json()) as OpenApiSpec;
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Failed to load API docs.';
  } finally {
    isLoading.value = false;
  }
}

onMounted(() => {
  void loadSpec();
});
</script>

<template>
  <section class="vb-section vb-api-docs">
    <div class="vb-table-header">API Documentation</div>

    <div class="vb-api-intro">
      <div class="vb-api-intro-left">
        <h2>{{ apiTitle }}</h2>
        <p class="vb-api-version">Version {{ apiVersion }}</p>
        <p v-if="apiDescription" class="vb-api-description">{{ apiDescription }}</p>
        <div class="vb-api-links">
          <span class="vb-api-link">OpenAPI JSON: <strong>/api/openapi.json</strong></span>
          <span class="vb-api-link"
            >Base URL: <strong>{{ baseUrl }}</strong></span
          >
        </div>
      </div>
      <div class="vb-api-intro-right">
        <div class="vb-api-search">
          <label for="api-search">Search endpoints</label>
          <input id="api-search" v-model="search" type="text" placeholder="Filter by path, tag, or summary" />
        </div>
      </div>
    </div>

    <div v-if="isLoading" class="vb-api-loading">
      <div class="vb-spinner vb-spinner-dark" style="width: 28px; height: 28px"></div>
      <div>Loading API specification...</div>
    </div>
    <div v-else-if="errorMessage" class="vb-api-error">{{ errorMessage }}</div>

    <div v-else class="vb-api-layout">
      <aside class="vb-api-sidebar">
        <div class="vb-api-sidebar-title">Endpoints</div>
        <div v-if="groupedOperations.length === 0" class="vb-api-empty">No endpoints match this search.</div>
        <div v-for="group in groupedOperations" :key="group.tag" class="vb-api-sidebar-group">
          <div class="vb-api-sidebar-tag">{{ group.tag }}</div>
          <a v-for="entry in group.items" :key="entry.id" :href="`#${entry.id}`" class="vb-api-sidebar-link">
            <span class="vb-api-method" :class="`vb-api-method--${entry.method.toLowerCase()}`">{{
              entry.method
            }}</span>
            <span class="vb-api-path">{{ entry.path }}</span>
          </a>
        </div>
      </aside>

      <div class="vb-api-content">
        <div v-for="group in groupedOperations" :key="group.tag" class="vb-api-group">
          <div class="vb-api-group-header">
            <h3>{{ group.tag }}</h3>
            <p v-if="group.description">{{ group.description }}</p>
          </div>

          <details v-for="entry in group.items" :key="entry.id" class="vb-api-operation" :id="entry.id">
            <summary class="vb-api-operation-summary">
              <span class="vb-api-method" :class="`vb-api-method--${entry.method.toLowerCase()}`">{{
                entry.method
              }}</span>
              <span class="vb-api-path">{{ entry.path }}</span>
              <span class="vb-api-summary">{{ entry.summary }}</span>
            </summary>

            <div class="vb-api-operation-body">
              <p v-if="entry.description" class="vb-api-description">{{ entry.description }}</p>

              <div v-if="entry.parameters.length" class="vb-api-section">
                <h4>Parameters</h4>
                <div class="vb-api-table">
                  <div class="vb-api-row vb-api-row-header">
                    <span>Name</span>
                    <span>In</span>
                    <span>Required</span>
                    <span>Description</span>
                  </div>
                  <div v-for="param in entry.parameters" :key="`${param.name}-${param.in}`" class="vb-api-row">
                    <span>{{ param.name }}</span>
                    <span>{{ param.in }}</span>
                    <span>{{ param.required ? 'Yes' : 'No' }}</span>
                    <span>{{ param.description || '—' }}</span>
                  </div>
                </div>
              </div>

              <div v-if="entry.requestSchemas.length" class="vb-api-section">
                <h4>Request Body</h4>
                <div v-for="schema in entry.requestSchemas" :key="schema.contentType" class="vb-api-schema">
                  <div class="vb-api-schema-title">{{ schema.contentType }}</div>
                  <pre>{{ formatSchema(schema.schema) }}</pre>
                </div>
              </div>

              <div v-if="entry.responses.length" class="vb-api-section">
                <h4>Responses</h4>
                <div
                  v-for="response in entry.responses"
                  :key="`${entry.id}-${response.code}-${response.contentType}`"
                  class="vb-api-schema"
                >
                  <div class="vb-api-schema-title">
                    <span class="vb-api-response-code">{{ response.code }}</span>
                    <span>{{ response.contentType }}</span>
                    <span class="vb-api-response-desc">{{ response.description || 'Response' }}</span>
                  </div>
                  <pre>{{ formatSchema(response.schema) }}</pre>
                </div>
              </div>
            </div>
          </details>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.vb-api-docs {
  padding: 24px;
}

.vb-api-intro {
  display: flex;
  gap: 24px;
  align-items: flex-start;
  background: var(--vb-panel);
  border: 1px solid var(--vb-border);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 24px;
}

.vb-api-intro h2 {
  margin: 0 0 6px;
  font-size: 1.6rem;
}

.vb-api-version {
  margin: 0 0 8px;
  font-size: 0.95rem;
  color: var(--vb-muted-text);
}

.vb-api-description {
  margin: 0 0 12px;
  color: var(--vb-body-text);
}

.vb-api-links {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.vb-api-link {
  color: var(--vb-link);
  text-decoration: none;
  font-weight: 600;
}

.vb-api-link:hover {
  text-decoration: underline;
}

.vb-api-search label {
  font-weight: 600;
  display: block;
  margin-bottom: 6px;
}

.vb-api-search input {
  width: 260px;
  max-width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--vb-border);
  background: var(--vb-body);
  color: inherit;
}

.vb-api-layout {
  display: grid;
  grid-template-columns: minmax(220px, 280px) 1fr;
  gap: 24px;
}

.vb-api-sidebar {
  position: sticky;
  top: 100px;
  align-self: start;
  background: var(--vb-panel);
  border: 1px solid var(--vb-border);
  border-radius: 12px;
  padding: 16px;
  max-height: calc(100vh - 160px);
  overflow: auto;
}

.vb-api-sidebar-title {
  font-weight: 700;
  margin-bottom: 12px;
}

.vb-api-sidebar-group + .vb-api-sidebar-group {
  margin-top: 16px;
}

.vb-api-sidebar-tag {
  text-transform: uppercase;
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  color: var(--vb-muted-text);
  margin-bottom: 8px;
}

.vb-api-sidebar-link {
  display: flex;
  align-items: center;
  gap: 8px;
  text-decoration: none;
  color: inherit;
  padding: 4px 0;
  font-size: 0.85rem;
}

.vb-api-sidebar-link:hover {
  color: var(--vb-link);
}

.vb-api-method {
  font-weight: 700;
  font-size: 0.7rem;
  padding: 2px 6px;
  border-radius: 6px;
  text-transform: uppercase;
  border: 1px solid transparent;
}

.vb-api-method--get {
  background: rgba(59, 130, 246, 0.12);
  color: #2563eb;
  border-color: rgba(59, 130, 246, 0.3);
}

.vb-api-method--post {
  background: rgba(16, 185, 129, 0.12);
  color: #059669;
  border-color: rgba(16, 185, 129, 0.3);
}

.vb-api-method--patch,
.vb-api-method--put {
  background: rgba(234, 179, 8, 0.12);
  color: #b45309;
  border-color: rgba(234, 179, 8, 0.3);
}

.vb-api-method--delete {
  background: rgba(239, 68, 68, 0.12);
  color: #dc2626;
  border-color: rgba(239, 68, 68, 0.3);
}

.vb-api-content {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.vb-api-group {
  background: var(--vb-panel);
  border: 1px solid var(--vb-border);
  border-radius: 12px;
  padding: 16px;
}

.vb-api-group-header h3 {
  margin: 0 0 4px;
}

.vb-api-group-header p {
  margin: 0 0 16px;
  color: var(--vb-muted-text);
}

.vb-api-operation {
  border-top: 1px solid var(--vb-border);
  padding: 12px 0;
}

.vb-api-operation:first-of-type {
  border-top: none;
}

.vb-api-operation-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  list-style: none;
}

.vb-api-operation-summary::-webkit-details-marker {
  display: none;
}

.vb-api-summary {
  color: var(--vb-muted-text);
}

.vb-api-operation-body {
  margin-top: 12px;
  padding-left: 12px;
}

.vb-api-section {
  margin-top: 16px;
}

.vb-api-table {
  border: 1px solid var(--vb-border);
  border-radius: 8px;
  overflow: hidden;
  display: grid;
  grid-auto-rows: minmax(32px, auto);
}

.vb-api-row {
  display: grid;
  grid-template-columns: 1fr 0.6fr 0.6fr 2fr;
  gap: 12px;
  padding: 8px 12px;
  border-top: 1px solid var(--vb-border);
}

.vb-api-row-header {
  font-weight: 700;
  background: var(--vb-body);
  border-top: none;
}

.vb-api-schema {
  background: var(--vb-body);
  border: 1px solid var(--vb-border);
  border-radius: 8px;
  margin-top: 12px;
}

.vb-api-schema-title {
  display: flex;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vb-border);
  font-weight: 600;
}

.vb-api-response-code {
  font-weight: 700;
}

.vb-api-schema pre {
  margin: 0;
  padding: 12px;
  font-size: 0.8rem;
  overflow: auto;
}

.vb-api-loading,
.vb-api-error,
.vb-api-empty {
  padding: 24px;
  text-align: center;
  color: var(--vb-muted-text);
}

@media (max-width: 900px) {
  .vb-api-intro {
    flex-direction: column;
  }

  .vb-api-layout {
    grid-template-columns: 1fr;
  }

  .vb-api-sidebar {
    position: static;
    max-height: none;
  }
}
</style>
