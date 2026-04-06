import { describe, expect, it } from "vite-plus/test";
import * as z from "zod/v4";
import {
  CollectionSchema,
  EventBridgeEventSchema,
  PaginationCollectionSchema,
  PaginationSchema,
} from "./model.js";

describe("EventBridgeEventSchema", () => {
  it("should accept valid event with all fields", () => {
    const result = EventBridgeEventSchema.parse({
      source: "test.service",
      "detail-type": "TestEvent",
      detail: "some detail",
    });

    expect(result.source).toBe("test.service");
    expect(result["detail-type"]).toBe("TestEvent");
    expect(result.detail).toBe("some detail");
  });

  it("should accept event with object detail and stringify it", () => {
    const result = EventBridgeEventSchema.parse({
      source: "test.service",
      "detail-type": "TestEvent",
      detail: { key: "value", nested: { data: 123 } },
    });

    expect(result.detail).toBe('{"key":"value","nested":{"data":123}}');
  });

  it("should accept event with all optional fields", () => {
    const result = EventBridgeEventSchema.parse({});

    expect(result.source).toBeUndefined();
    expect(result["detail-type"]).toBeUndefined();
    expect(result.detail).toBeUndefined();
  });

  it("should preserve string detail as-is", () => {
    const result = EventBridgeEventSchema.parse({
      detail: "already a string",
    });

    expect(result.detail).toBe("already a string");
  });
});

describe("PaginationSchema", () => {
  it("should accept pageSize as number", () => {
    const result = PaginationSchema.parse({ pageSize: 25 });

    expect(result.pageSize).toBe(25);
  });

  it("should accept pageSize as string", () => {
    const result = PaginationSchema.parse({ pageSize: "50" });

    expect(result.pageSize).toBe("50");
  });

  it("should accept nextToken", () => {
    const result = PaginationSchema.parse({ nextToken: "abc123" });

    expect(result.nextToken).toBe("abc123");
  });

  it("should accept null values", () => {
    const result = PaginationSchema.parse({
      pageSize: null,
      nextToken: null,
    });

    expect(result.pageSize).toBeNull();
    expect(result.nextToken).toBeNull();
  });

  it("should accept empty object", () => {
    const result = PaginationSchema.parse({});

    expect(result.pageSize).toBeUndefined();
    expect(result.nextToken).toBeUndefined();
  });
});

describe("CollectionSchema", () => {
  it("should validate array of items", () => {
    const StringCollection = CollectionSchema(z.string());
    const result = StringCollection.parse({ items: ["a", "b", "c"] });

    expect(result.items).toEqual(["a", "b", "c"]);
  });

  it("should accept empty array", () => {
    const StringCollection = CollectionSchema(z.string());
    const result = StringCollection.parse({ items: [] });

    expect(result.items).toEqual([]);
  });
});

describe("PaginationCollectionSchema", () => {
  it("should validate items with pagination", () => {
    const StringPaginatedCollection = PaginationCollectionSchema(z.string());
    const result = StringPaginatedCollection.parse({
      items: ["a", "b"],
      pagination: { nextToken: "xyz" },
    });

    expect(result.items).toEqual(["a", "b"]);
    expect(result.pagination?.nextToken).toBe("xyz");
  });

  it("should accept items without pagination", () => {
    const StringPaginatedCollection = PaginationCollectionSchema(z.string());
    const result = StringPaginatedCollection.parse({
      items: ["a"],
    });

    expect(result.items).toEqual(["a"]);
    expect(result.pagination).toBeUndefined();
  });
});
