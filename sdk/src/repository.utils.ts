import * as crypto from "node:crypto";

/**
 * Encryption algorithm used for pagination tokens.
 * AES-256-CTR provides symmetric encryption with counter mode.
 */
const ENCRYPTION_ALGORITHM = "aes-256-ctr";

/**
 * Key size in bytes for AES-256 encryption.
 */
const KEY_SIZE = 32;

/**
 * Encodes a pagination object into an encrypted token string.
 *
 * Uses AES-256-CTR encryption to obfuscate the DynamoDB LastEvaluatedKey,
 * preventing clients from tampering with pagination state.
 *
 * The token format is: `{iv}:{encryptedData}` where both parts are hex-encoded.
 *
 * @param nextPageObject - DynamoDB LastEvaluatedKey object to encode
 * @returns Encrypted pagination token string, or undefined if input is null/undefined
 *
 * @example
 * ```typescript
 * const lastKey = { PK: 'App1.USER', SK: 'audit-123' };
 * const token = encodeNextPageToken(lastKey);
 * // Returns something like: "a1b2c3d4...:e5f6g7h8..."
 * ```
 */
export function encodeNextPageToken(nextPageObject?: Record<string, string>): string | undefined {
  if (nextPageObject == null) {
    return undefined;
  }

  const nextPageString = JSON.stringify(nextPageObject);

  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(
    ENCRYPTION_ALGORITHM,
    Buffer.concat([Buffer.alloc(KEY_SIZE)], KEY_SIZE),
    iv,
  );
  const encrypted = cipher.update(nextPageString);

  return [iv.toString("hex"), encrypted.toString("hex")].join(":");
}

/**
 * Decodes an encrypted pagination token back into a DynamoDB key object.
 *
 * Reverses the encryption performed by {@link encodeNextPageToken} to
 * restore the original LastEvaluatedKey for DynamoDB queries.
 *
 * @param nextPageString - Encrypted pagination token from a previous response
 * @returns Decoded DynamoDB key object, or undefined if input is null/undefined/invalid
 *
 * @example
 * ```typescript
 * const token = "a1b2c3d4...:e5f6g7h8...";
 * const lastKey = decodeNextPageToken(token);
 * // Returns: { PK: 'App1.USER', SK: 'audit-123' }
 * ```
 */
export function decodeNextPageToken(
  nextPageString?: string | null | undefined,
): Record<string, string> | undefined {
  if (nextPageString == null) {
    return undefined;
  }

  const textParts = nextPageString.split(":");
  const iv = textParts.shift();
  if (!iv) {
    return undefined;
  }

  const decipher = crypto.createDecipheriv(
    ENCRYPTION_ALGORITHM,
    Buffer.concat([Buffer.alloc(KEY_SIZE)], KEY_SIZE),
    Buffer.from(iv, "hex"),
  );

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(textParts.join(":"), "hex")),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString());
}
