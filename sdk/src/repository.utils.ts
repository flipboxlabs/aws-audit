import { InvalidNextTokenError } from "./errors.js";

/** A decoded pagination token: the DynamoDB key a query resumes after. */
export type PageKey = Record<string, string | number>;

/** The attributes of an index's LastEvaluatedKey and their DynamoDB types. */
export type PageKeySchema = Readonly<Record<string, "string" | "number">>;

/**
 * Encodes a pagination object into a base64url token string.
 *
 * Pagination tokens are opaque cursors representing DynamoDB LastEvaluatedKey
 * objects. They do not require confidentiality — base64url encoding provides
 * a compact, URL-safe representation.
 *
 * @param nextPageObject - DynamoDB LastEvaluatedKey object to encode
 * @returns Base64url-encoded pagination token string, or undefined if input is null/undefined
 *
 * @example
 * ```typescript
 * const lastKey = { PK: 'App1.USER', SK: 'audit-123' };
 * const token = encodeNextPageToken(lastKey);
 * // Returns a base64url string like: "eyJQSyI6IkFwcDEuVVNFUiIsIlNLIjoiYXVkaXQtMTIzIn0"
 * ```
 */
export function encodeNextPageToken(nextPageObject?: PageKey): string | undefined {
  if (nextPageObject == null) {
    return undefined;
  }

  return Buffer.from(JSON.stringify(nextPageObject)).toString("base64url");
}

/**
 * Decodes a base64url pagination token back into a DynamoDB key object.
 *
 * Reverses the encoding performed by {@link encodeNextPageToken} to
 * restore the original LastEvaluatedKey for DynamoDB queries.
 *
 * @param nextPageString - Base64url-encoded pagination token from a previous response
 * @param schema - The key attributes the token must hold, exactly, with their types
 * @returns Decoded DynamoDB key object, or undefined if input is null/undefined/empty
 * @throws {InvalidNextTokenError} When the token doesn't decode to a key object, or
 *   doesn't match `schema`
 *
 * @example
 * ```typescript
 * const token = "eyJQSyI6IkFwcDEuVVNFUiIsIlNLIjoiYXVkaXQtMTIzIn0";
 * const lastKey = decodeNextPageToken(token, { PK: "string", SK: "string" });
 * // Returns: { PK: 'App1.USER', SK: 'audit-123' }
 * ```
 */
export function decodeNextPageToken(
  nextPageString?: string | null | undefined,
  schema?: PageKeySchema,
): PageKey | undefined {
  if (nextPageString == null || nextPageString === "") {
    return undefined;
  }

  let key: unknown;
  try {
    key = JSON.parse(Buffer.from(nextPageString, "base64url").toString());
  } catch {
    throw new InvalidNextTokenError();
  }

  if (typeof key !== "object" || key === null || Array.isArray(key)) {
    throw new InvalidNextTokenError();
  }

  const entries = Object.entries(key);
  const matches = schema
    ? entries.length === Object.keys(schema).length &&
      entries.every(([name, value]) => Object.hasOwn(schema, name) && typeof value === schema[name])
    : entries.every(([, value]) => typeof value === "string" || typeof value === "number");
  if (!matches) {
    throw new InvalidNextTokenError();
  }

  return key as PageKey;
}
