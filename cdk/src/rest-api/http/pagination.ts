import { z } from "zod";

/**
 * Pagination query params, shared by every listing. Keys are flat, matching API
 * Gateway's bracket notation.
 *
 * API Gateway passes every query value as a string, so `pagination[pageSize]` is
 * validated as one: an integer from 1 to 1000, without leading zeros. DynamoDB
 * rejects a `Limit` below 1. The range is in the pattern, so the published JSON
 * Schema states it too.
 */
export const PaginationQuerySchema = z.object({
  "pagination[pageSize]": z
    .string()
    .regex(/^(?:[1-9]\d{0,2}|1000)$/, "Expected an integer from 1 to 1000")
    .transform(Number)
    .optional(),
  "pagination[nextToken]": z.string().optional(),
});
