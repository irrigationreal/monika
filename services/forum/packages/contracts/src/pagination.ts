import { z } from 'zod';

export const PageRequestSchema = z.object({
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional()
});

export type PageRequest = z.infer<typeof PageRequestSchema>;

export const PageResponseSchema = <T>(itemSchema: z.ZodType<T>) =>
  z.object({
    items: z.array(itemSchema),
    page: z.number().int().nonnegative(),
    pageSize: z.number().int().positive(),
    total: z.number().int().nonnegative().optional()
  });

export type PageResponse<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total?: number;
};
