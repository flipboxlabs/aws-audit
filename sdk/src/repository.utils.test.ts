import { describe, expect, it } from "vite-plus/test";
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

    it("should return a token with iv:encrypted format", () => {
      const input = { PK: "App1.USER", SK: "audit-123" };

      const result = encodeNextPageToken(input);

      expect(result).toMatch(/^[a-f0-9]+:[a-f0-9]+$/);
    });

    it("should produce different tokens for same input due to random IV", () => {
      const input = { PK: "App1.USER", SK: "audit-123" };

      const result1 = encodeNextPageToken(input);
      const result2 = encodeNextPageToken(input);

      expect(result1).not.toBe(result2);
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

    it("should return undefined for empty string (no IV)", () => {
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

    it("should handle tokens with colons in the encrypted data", () => {
      // The encrypted data might contain hex that resembles colons when joined
      // This tests that the split/join logic works correctly
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
  });
});
