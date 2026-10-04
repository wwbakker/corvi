/** Device identity's OS half (node adapter): generating pairing codes, device ids and device
 * tokens, and hashing/comparing tokens.
 *
 * A device token is 256 random bits. It is shown to the user once and never stored; the config
 * holds a SHA-256 hash. A fast hash is correct here — there is no low-entropy password to
 * stretch, and 256 bits cannot be brute-forced — and comparison is constant-time so a presented
 * token leaks nothing through timing.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"

/** A fresh 256-bit device token, safe in a cookie, header and URL. */
export const generateDeviceToken = (): string => randomBytes(32).toString("base64url")

/** The stored form of a device token: its SHA-256 hash, hex encoded. */
export const hashDeviceToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex")

/** Whether a presented token matches a stored hash, comparing in constant time. A malformed
 * stored hash (not hex, wrong length) never matches. */
export const deviceTokenMatches = (token: string, storedHash: string): boolean => {
  const presented = Buffer.from(hashDeviceToken(token), "hex")
  const stored = Buffer.from(storedHash, "hex")
  return presented.length > 0 && presented.length === stored.length && timingSafeEqual(presented, stored)
}

/** A fresh pairing code: sixteen hex characters (64 bits), short-lived and single-use. */
export const generatePairingCode = (): string => randomBytes(8).toString("hex").toUpperCase()

/** A fresh device id, unique across machines and restarts. */
export const generateDeviceId = (): string => randomUUID()
