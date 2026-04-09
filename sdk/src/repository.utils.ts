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
export function encodeNextPageToken(nextPageObject?: Record<string, string>): string | undefined {
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
 * @returns Decoded DynamoDB key object, or undefined if input is null/undefined/invalid
 *
 * @example
 * ```typescript
 * const token = "eyJQSyI6IkFwcDEuVVNFUiIsIlNLIjoiYXVkaXQtMTIzIn0";
 * const lastKey = decodeNextPageToken(token);
 * // Returns: { PK: 'App1.USER', SK: 'audit-123' }
 * ```
 */
export function decodeNextPageToken(
  nextPageString?: string | null | undefined,
): Record<string, string> | undefined {
  if (nextPageString == null || nextPageString === "") {
    return undefined;
  }

  return JSON.parse(Buffer.from(nextPageString, "base64url").toString());
}
