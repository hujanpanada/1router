import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const DEFAULT_PASSWORD = "1router";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Salted scrypt hash, stored in SQLite. Never store the plaintext password. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, saltHex, hashHex] = stored.split(":");
    if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, "hex");
    const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Seed the login password (hashed) on first run. Returns true if it seeded. */
export function ensureLoginPassword(db: { getSetting(k: string): string | null; setSetting(k: string, v: string): void }): boolean {
  if (db.getSetting("login_password_hash")) return false;
  db.setSetting("login_password_hash", hashPassword(DEFAULT_PASSWORD));
  return true;
}

export function passwordIsDefault(db: { getSetting(k: string): string | null }): boolean {
  const stored = db.getSetting("login_password_hash");
  return stored ? verifyPassword(DEFAULT_PASSWORD, stored) : false;
}

export function checkLogin(db: { getSetting(k: string): string | null }, password: string): boolean {
  const stored = db.getSetting("login_password_hash");
  return stored ? verifyPassword(password, stored) : false;
}

export function changeLoginPassword(
  db: { getSetting(k: string): string | null; setSetting(k: string, v: string): void },
  current: string,
  next: string,
): boolean {
  if (!checkLogin(db, current)) return false;
  db.setSetting("login_password_hash", hashPassword(next));
  return true;
}
