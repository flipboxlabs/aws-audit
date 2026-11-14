import { describe, expect, it } from "vite-plus/test";
import { PaginationQuerySchema } from "./pagination.js";

describe("PaginationQuerySchema", () => {
  it.each([
    ["1", 1],
    ["25", 25],
    ["999", 999],
    ["1000", 1000],
  ])("parses pageSize %s as %d", (pageSize, expected) => {
    const result = PaginationQuerySchema.safeParse({ "pagination[pageSize]": pageSize });

    expect(result.success).toBe(true);
    expect(result.data?.["pagination[pageSize]"]).toBe(expected);
  });

  it.each(["", "0", "-1", "1.5", "1e3", "01", "1001", "abc", " 5"])(
    "rejects pageSize %j",
    (pageSize) => {
      const result = PaginationQuerySchema.safeParse({ "pagination[pageSize]": pageSize });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["pagination[pageSize]"]);
    },
  );

  it("treats both params as optional", () => {
    expect(PaginationQuerySchema.safeParse({}).success).toBe(true);
  });
});
