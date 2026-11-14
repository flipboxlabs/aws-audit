import { describe, expect, it } from "vite-plus/test";
import { InvalidNextTokenError } from "./errors.js";
import { decodeNextPageToken, encodeNextPageToken } from "./repository.utils.js";

describe("repository.utils", () => {
  describe("encodeNextPageToken", () => {
    it("should return undefined for null input", () => {
      const result = encodeNextPageToken(null as unknown as undefined);

      expect(result).toBeUndefined();
    });

    it("should return undefined for undefined input", () => {
      const result = encodeNextPageToken(undefined);

      expect(result).toBeUndefined();
    });

    it("should encode an object into a token string", () => {
      const input = { PK: "App1.USER", SK: "audit-123" };

      const result = encodeNextPageToken(input);

      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });

    it("should return a base64url-encoded token", () => {
      const input = { PK: "App1.USER", SK: "audit-123" };

      const result = encodeNextPageToken(input);

      // base64url uses only A-Z a-z 0-9 - _
      expect(result).toMatch(/^[A-Za-z0-9_-]+=*$/);
    });

    it("should produce the same token for the same input (deterministic)", () => {
      const input = { PK: "App1.USER", SK: "audit-123" };

      const result1 = encodeNextPageToken(input);
      const result2 = encodeNextPageToken(input);

      expect(result1).toBe(result2);
    });

    it("should handle empty object", () => {
      const result = encodeNextPageToken({});

      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });

    it("should handle object with multiple keys", () => {
      const input = {
        PK: "App1.USER",
        SK: "audit-123",
        GSI1_SS_PK: "App1.USER#user-456",
        GSI1_SS_SK: "audit-123",
      };

      const result = encodeNextPageToken(input);

      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });
  });

  describe("decodeNextPageToken", () => {
    it("should return undefined for null input", () => {
      const result = decodeNextPageToken(null);

      expect(result).toBeUndefined();
    });

    it("should return undefined for undefined input", () => {
      const result = decodeNextPageToken(undefined);

      expect(result).toBeUndefined();
    });

    it("should return undefined for empty string", () => {
      const result = decodeNextPageToken("");

      expect(result).toBeUndefined();
    });

    it("should decode an encoded token back to original object", () => {
      const original = { PK: "App1.USER", SK: "audit-123" };
      const token = encodeNextPageToken(original);

      const result = decodeNextPageToken(token);

      expect(result).toEqual(original);
    });

    it("should handle object with multiple keys", () => {
      const original = {
        PK: "App1.USER",
        SK: "audit-123",
        GSI1_SS_PK: "App1.USER#user-456",
        GSI1_SS_SK: "audit-123",
      };
      const token = encodeNextPageToken(original);

      const result = decodeNextPageToken(token);

      expect(result).toEqual(original);
    });

    it("should handle empty object", () => {
      const original = {};
      const token = encodeNextPageToken(original);

      const result = decodeNextPageToken(token);

      expect(result).toEqual(original);
    });

    it("should handle values with colons", () => {
      const original = { key: "value:with:colons" };
      const token = encodeNextPageToken(original);

      const result = decodeNextPageToken(token);

      expect(result).toEqual(original);
    });

    it("should handle special characters in values", () => {
      const original = {
        PK: "App1.USER#resource-123",
        SK: "audit-with-special-chars-!@#$%",
      };
      const token = encodeNextPageToken(original);

      const result = decodeNextPageToken(token);

      expect(result).toEqual(original);
    });

    it("should handle unicode characters", () => {
      const original = {
        PK: "App1.USER",
        SK: "audit-日本語-émojis-🎉",
      };
      const token = encodeNextPageToken(original);

      const result = decodeNextPageToken(token);

      expect(result).toEqual(original);
    });
  });

  describe("encode/decode roundtrip", () => {
    it("should preserve data through multiple encode/decode cycles", () => {
      const original = { PK: "App1.RESOURCE", SK: "id-12345" };

      // First roundtrip
      const token1 = encodeNextPageToken(original);
      const decoded1 = decodeNextPageToken(token1);
      expect(decoded1).toEqual(original);

      // Second roundtrip from decoded
      const token2 = encodeNextPageToken(decoded1);
      const decoded2 = decodeNextPageToken(token2);
      expect(decoded2).toEqual(original);
    });

    it("should handle large objects", () => {
      const original: Record<string, string> = {};
      for (let i = 0; i < 20; i++) {
        original[`key${i}`] = `value${i}`.repeat(10);
      }

      const token = encodeNextPageToken(original);
      const result = decodeNextPageToken(token);

      expect(result).toEqual(original);
    });

    it("should keep numeric key values as numbers", () => {
      const original = { PK: "App1.USER", SK: "audit-123", LSI1_N_SK: 21767323445678 };

      expect(decodeNextPageToken(encodeNextPageToken(original))).toEqual(original);
    });

    it.each([
      ["not base64 JSON", "not-a-token"],
      ["a JSON array", Buffer.from("[1]").toString("base64url")],
      ["a JSON string", Buffer.from('"PK"').toString("base64url")],
      ["JSON null", Buffer.from("null").toString("base64url")],
      ["a nested value", encodeNextPageToken({ PK: { S: "x" } } as never)],
      ["a boolean value", encodeNextPageToken({ PK: true } as never)],
    ])("should throw InvalidNextTokenError for %s", (_, token) => {
      expect(() => decodeNextPageToken(token)).toThrow(InvalidNextTokenError);
    });

    describe("with a key schema", () => {
      const schema = { PK: "string", SK: "string", LSI1_N_SK: "number" } as const;

      it("should accept a token with exactly the schema's keys and types", () => {
        const original = { PK: "App1.USER", SK: "audit-123", LSI1_N_SK: 1 };

        expect(decodeNextPageToken(encodeNextPageToken(original), schema)).toEqual(original);
      });

      it.each([
        ["a missing key", { PK: "App1.USER", SK: "audit-123" }],
        ["an extra key", { PK: "App1.USER", SK: "audit-123", LSI1_N_SK: 1, GSI2_SS_PK: "fail" }],
        ["a mistyped key", { PK: "App1.USER", SK: "audit-123", LSI1_N_SK: "1" }],
      ])("should throw InvalidNextTokenError for %s", (_, key) => {
        expect(() => decodeNextPageToken(encodeNextPageToken(key), schema)).toThrow(
          InvalidNextTokenError,
        );
      });
    });
  });
});
