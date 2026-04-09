import { describe, expect, it } from "vite-plus/test";
import { extractNestedQueryStringParameters } from "./utils.js";

describe("utils", () => {
  describe("extractNestedQueryStringParameters", () => {
    it("should return null when params is null", () => {
      expect(extractNestedQueryStringParameters(null)).toBeNull();
    });

    it("should return empty object for empty params", () => {
      expect(extractNestedQueryStringParameters({})).toEqual({});
    });

    it("should parse simple key-value pairs", () => {
      const params = {
        name: "test",
        value: "123",
      };

      const result = extractNestedQueryStringParameters(params);

      expect(result).toEqual({
        name: "test",
        value: "123",
      });
    });

    it("should parse nested object notation", () => {
      const params = {
        "pagination[pageSize]": "25",
        "pagination[nextToken]": "abc123",
      };

      const result = extractNestedQueryStringParameters(params);

      expect(result).toEqual({
        pagination: {
          pageSize: "25",
          nextToken: "abc123",
        },
      });
    });

    it("should parse deeply nested object notation", () => {
      const params = {
        "filter[app]": "App1",
        "filter[resource][type]": "User",
        "filter[resource][id]": "user-123",
      };

      const result = extractNestedQueryStringParameters(params);

      expect(result).toEqual({
        filter: {
          app: "App1",
          resource: {
            type: "User",
            id: "user-123",
          },
        },
      });
    });

    it("should parse array notation", () => {
      const params = {
        "ids[0]": "id1",
        "ids[1]": "id2",
        "ids[2]": "id3",
      };

      const result = extractNestedQueryStringParameters(params);

      expect(result).toEqual({
        ids: ["id1", "id2", "id3"],
      });
    });

    it("should handle mixed nested and flat params", () => {
      const params = {
        simple: "value",
        "nested[key]": "nestedValue",
        "pagination[pageSize]": "10",
      };

      const result = extractNestedQueryStringParameters(params);

      expect(result).toEqual({
        simple: "value",
        nested: {
          key: "nestedValue",
        },
        pagination: {
          pageSize: "10",
        },
      });
    });
  });
});
