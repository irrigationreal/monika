import { describe, expect, it } from 'vitest';

import { CreateCloneRequestSchema, TopicLineageDtoSchema } from './schemas';

import type { CloneOperationDto, TopicCloneStateDto } from './dto';

void ({} as CloneOperationDto);
void ({} as TopicCloneStateDto);

describe('duplicate-thread contracts', () => {
  it('validates stable clone operation ids and trimmed titles', () => {
    expect(CreateCloneRequestSchema.parse({ operationId: 'clone_01-safe', title: '  Copy of Parent  ' })).toEqual({
      operationId: 'clone_01-safe',
      title: 'Copy of Parent',
    });
    expect(() => CreateCloneRequestSchema.parse({ operationId: '../clone', title: 'Copy' })).toThrow();
    expect(() => CreateCloneRequestSchema.parse({ operationId: 'clone', title: '   ' })).toThrow();
  });

  it('keeps both fork and clone in the public-safe lineage schema', () => {
    expect(TopicLineageDtoSchema.parse({ kind: 'fork', parentTopicId: 'parent' })).toEqual({
      kind: 'fork',
      parentTopicId: 'parent',
    });
    expect(TopicLineageDtoSchema.parse({ kind: 'clone', parentTopicId: 'parent' })).toEqual({
      kind: 'clone',
      parentTopicId: 'parent',
    });
  });
});
