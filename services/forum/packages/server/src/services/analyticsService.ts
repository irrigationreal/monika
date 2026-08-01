import type {
  AdminAnalyticsDto,
  AnalyticsDelegationBreakdownDto,
  AnalyticsErrorClusterDto,
  AnalyticsModelUsagePointDto,
  AnalyticsRuntimeMetricsDto,
  AnalyticsToolDto,
  AnalyticsUsageModelDto,
} from '@irrigationreal/codex-forum-contracts';
import type { ForumAnalyticsQuery, ForumAnalyticsReadModel } from '@irrigationreal/codex-forum-core';

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const number = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const nullableNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const string = (value: unknown, fallback = 'unknown'): string =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback;
const nullableString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;
const field = (value: Record<string, unknown> | null, camel: string, snake = camel): unknown =>
  value?.[camel] ?? value?.[snake];
const numberRecord = (value: unknown): Record<string, number> =>
  Object.fromEntries(
    Object.entries(record(value) ?? {}).flatMap(([key, count]) =>
      typeof count === 'number' && Number.isFinite(count) ? [[key, count]] : []
    )
  );

function tool(value: unknown): AnalyticsToolDto | null {
  const row = record(value);
  if (!row) return null;
  return {
    operation: string(field(row, 'operation', 'operation') ?? field(row, 'tool', 'tool')),
    backend: string(field(row, 'backend', 'backend')),
    calls: number(field(row, 'calls', 'calls') ?? row['samples']),
    failures: number(field(row, 'failures', 'failures')),
    failureRate: number(field(row, 'failureRate', 'failure_rate')),
    outcomes: numberRecord(field(row, 'outcomes', 'outcomes')),
  };
}

function errorCluster(value: unknown): AnalyticsErrorClusterDto | null {
  const row = record(value);
  if (!row) return null;
  const sourceValue = string(field(row, 'source', 'source'));
  const source = sourceValue === 'provider' || sourceValue === 'subagent' ? sourceValue : 'tool';
  const operation = field(row, 'operation', 'normalized_tool');
  return {
    source,
    category: string(field(row, 'category', 'category')),
    operation: typeof operation === 'string' ? operation : null,
    affectedTurns: number(field(row, 'affectedTurns', 'affected_turns') ?? field(row, 'count', 'count')),
  };
}

export function mapAgentdAnalytics(rawValue: unknown): AnalyticsRuntimeMetricsDto {
  const raw = record(rawValue) ?? {};
  const generatedAt = nullableString(field(raw, 'generatedAt', 'generated_at'));
  const buildRaw = record(raw['build']);
  const build = {
    commit: nullableString(field(buildRaw, 'commit', 'commit')),
    createdAt: nullableString(field(buildRaw, 'createdAt', 'created_at')),
  };
  const totals = record(raw['totals']);
  if (totals) {
    const tokenFootprint = record(totals['token_footprint']);
    const toolOperations = record(totals['tool_operations']);
    const subagentWait = record(totals['subagent_wait']);
    const lifecycle = record(totals['subagent_lifecycle']);
    const byModel: AnalyticsUsageModelDto[] = array(totals['model_vendors']).flatMap((vendorValue) => {
      const vendor = record(vendorValue);
      if (!vendor) return [];
      return array(vendor['models']).flatMap((modelValue) => {
        const model = record(modelValue);
        const footprint = record(model?.['token_footprint']);
        if (!model) return [];
        return [
          {
            vendor: string(vendor['vendor']),
            model: string(model['model']),
            responses: number(model['response_count']),
            totalTokens: number(model['total_tokens']),
            medianTokens: nullableNumber(footprint?.['median']),
          },
        ];
      });
    });
    const toolRows = array(toolOperations?.['operations']).flatMap((value) => {
      const row = record(value);
      if (!row) return [];
      return [
        {
          operation: string(row['operation']),
          backend: string(row['backend']),
          calls: number(row['samples']),
          failures: number(row['failures']),
          failureRate: number(row['failure_rate']),
          outcomes: numberRecord(row['outcomes']),
        },
      ];
    });
    const errorRows = array(totals['error_clusters'])
      .map(errorCluster)
      .filter((value): value is AnalyticsErrorClusterDto => Boolean(value));
    const profileModeRows: AnalyticsDelegationBreakdownDto[] = array(lifecycle?.['by_profile_mode']).flatMap(
      (value) => {
        const row = record(value);
        if (!row) return [];
        const observed = number(row['observed']);
        const unsuccessful = number(row['unsuccessful']);
        return [
          {
            profile: string(row['profile']),
            mode: string(row['mode']),
            successful: observed - unsuccessful,
            unsuccessful,
            unsuccessfulRate: nullableNumber(row['unsuccessful_rate']),
          },
        ];
      }
    );
    const vendorNames = array(totals['model_vendors']).flatMap((value) => {
      const vendor = record(value);
      return vendor ? [string(vendor['vendor'])] : [];
    });
    const modelUsageOverTime: AnalyticsModelUsagePointDto[] = array(raw['buckets']).flatMap((bucketValue) => {
      const bucketRow = record(bucketValue);
      if (!bucketRow) return [];
      const rows = new Map(
        array(bucketRow['model_vendors']).flatMap((value) => {
          const vendor = record(value);
          return vendor ? [[string(vendor['vendor']), vendor] as const] : [];
        })
      );
      return vendorNames.map((vendorName) => {
        const vendor = rows.get(vendorName);
        const bucket = string(bucketRow['start']);
        return {
          bucket,
          bucketEnd: string(bucketRow['end'], bucket),
          observedFrom: string(bucketRow['observed_from'], bucket),
          observedTo: string(bucketRow['observed_to'], string(bucketRow['end'], bucket)),
          isPartial: bucketRow['is_partial'] === true,
          vendor: vendorName,
          responses: number(vendor?.['response_count']),
          totalTokens: number(vendor?.['total_tokens']),
        };
      });
    });
    const coverage = Object.fromEntries(
      Object.entries(record(raw['coverage']) ?? {}).flatMap(([key, value]) =>
        typeof value === 'number' && Number.isFinite(value) ? [[key, value]] : []
      )
    );
    const observed = number(lifecycle?.['outcomes_observed']);
    const unsuccessful = number(lifecycle?.['unsuccessful']);
    const worst = toolOperations?.['worst_qualifying_operation'];
    return {
      generatedAt,
      build,
      coverage,
      usage: {
        successfulResponses: number(totals['successful_terminal_responses']),
        medianTokens: nullableNumber(tokenFootprint?.['median']),
        byModel,
      },
      tools: { worst: tool(worst), rows: toolRows },
      errors: { top: errorRows[0] ?? null, rows: errorRows },
      waiting: {
        count: number(subagentWait?.['samples']),
        p95Ms: nullableNumber(subagentWait?.['p95_elapsed_ms']),
        excluded: number(coverage['excluded_wait_durations']),
      },
      delegation: {
        successful: observed - unsuccessful,
        unsuccessful,
        unsuccessfulRate: nullableNumber(lifecycle?.['unsuccessful_rate']),
        unknown: Math.max(0, number(lifecycle?.['records']) - observed),
        byProfileMode: profileModeRows,
      },
      modelUsageOverTime,
    };
  }
  const usage = record(raw['usage']);
  const tools = record(raw['tools']);
  const errors = record(raw['errors']);
  const waiting = record(raw['waiting']);
  const delegation = record(raw['delegation']);
  const byModel: AnalyticsUsageModelDto[] = array(field(usage, 'byModel', 'by_model')).flatMap((value) => {
    const row = record(value);
    if (!row) return [];
    return [
      {
        vendor: string(field(row, 'vendor', 'vendor')),
        model: string(field(row, 'model', 'model')),
        responses: number(field(row, 'responses', 'responses')),
        totalTokens: number(field(row, 'totalTokens', 'total_tokens')),
        medianTokens: nullableNumber(field(row, 'medianTokens', 'median_tokens')),
      },
    ];
  });
  const toolRows = array(field(tools, 'rows', 'rows'))
    .map(tool)
    .filter((value): value is AnalyticsToolDto => Boolean(value));
  const errorRows = array(field(errors, 'rows', 'rows'))
    .map(errorCluster)
    .filter((value): value is AnalyticsErrorClusterDto => Boolean(value));
  const byProfileMode: AnalyticsDelegationBreakdownDto[] = array(
    field(delegation, 'byProfileMode', 'by_profile_mode')
  ).flatMap((value) => {
    const row = record(value);
    if (!row) return [];
    return [
      {
        profile: string(field(row, 'profile', 'profile')),
        mode: string(field(row, 'mode', 'mode')),
        successful: number(field(row, 'successful', 'successful')),
        unsuccessful: number(field(row, 'unsuccessful', 'unsuccessful')),
        unsuccessfulRate: nullableNumber(field(row, 'unsuccessfulRate', 'unsuccessful_rate')),
      },
    ];
  });
  const modelUsageOverTime: AnalyticsModelUsagePointDto[] = array(
    field(raw, 'modelUsageOverTime', 'model_vendor_usage_over_time') ??
      field(raw, 'modelUsageOverTime', 'model_usage_over_time')
  ).flatMap((value) => {
    const row = record(value);
    if (!row) return [];
    const bucket = string(field(row, 'bucket', 'bucket'));
    return [
      {
        bucket,
        bucketEnd: string(field(row, 'bucketEnd', 'bucket_end'), bucket),
        observedFrom: string(field(row, 'observedFrom', 'observed_from'), bucket),
        observedTo: string(
          field(row, 'observedTo', 'observed_to'),
          string(field(row, 'bucketEnd', 'bucket_end'), bucket)
        ),
        isPartial: field(row, 'isPartial', 'is_partial') === true,
        vendor: string(field(row, 'vendor', 'vendor')),
        responses: number(field(row, 'responses', 'responses')),
        totalTokens: number(field(row, 'totalTokens', 'total_tokens')),
      },
    ];
  });
  const coverageRaw = record(raw['coverage']) ?? {};
  const coverage = Object.fromEntries(
    Object.entries(coverageRaw).flatMap(([key, value]) =>
      typeof value === 'number' && Number.isFinite(value) ? [[key, value]] : []
    )
  );
  const worst = tool(field(tools, 'worst', 'worst'));
  const top = errorCluster(field(errors, 'top', 'top'));
  return {
    generatedAt,
    build,
    coverage,
    usage: {
      successfulResponses: number(field(usage, 'successfulResponses', 'successful_responses')),
      medianTokens: nullableNumber(field(usage, 'medianTokens', 'median_tokens')),
      byModel,
    },
    tools: { worst, rows: toolRows },
    errors: { top, rows: errorRows },
    waiting: {
      count: number(field(waiting, 'count', 'count')),
      p95Ms: nullableNumber(field(waiting, 'p95Ms', 'p95_ms')),
      excluded: number(field(waiting, 'excluded', 'excluded')),
    },
    delegation: {
      successful: number(field(delegation, 'successful', 'successful')),
      unsuccessful: number(field(delegation, 'unsuccessful', 'unsuccessful')),
      unsuccessfulRate: nullableNumber(field(delegation, 'unsuccessfulRate', 'unsuccessful_rate')),
      unknown: number(field(delegation, 'unknown', 'unknown')),
      byProfileMode,
    },
    modelUsageOverTime,
  };
}

export class AnalyticsService {
  constructor(
    private readonly readModel: ForumAnalyticsReadModel,
    private readonly runtimeQuery: (input: {
      from: string;
      to: string;
      bucket: 'day' | 'week';
      piSessionIds: string[];
      minToolSamples: number;
    }) => Promise<Record<string, unknown>>
  ) {}

  async getAnalytics(query: ForumAnalyticsQuery): Promise<AdminAnalyticsDto> {
    const scope = await this.readModel.getAnalyticsScope(query);
    let runtime: AdminAnalyticsDto['runtime'];
    try {
      const raw = await this.runtimeQuery({
        from: query.window.from,
        to: query.window.to,
        bucket: query.window.bucket,
        piSessionIds: scope.piSessionIds,
        minToolSamples: 5,
      });
      runtime = { available: true, warning: null, metrics: mapAgentdAnalytics(raw) };
    } catch {
      runtime = {
        available: false,
        warning: 'Canonical Pi analytics are temporarily unavailable.',
        metrics: null,
      };
    }
    return {
      generatedAt: new Date().toISOString(),
      window: query.window,
      selectedForumId: query.forumId ?? null,
      forums: scope.forums,
      vocabulary: { algorithmVersion: 1, groups: scope.vocabulary },
      runtime,
    };
  }
}
