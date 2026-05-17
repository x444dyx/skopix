// core/auth.js — password hashing, token generation, secret encryption
// Uses Node's built-in crypto so no extra dependencies needed.

import crypto from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(crypto.scrypt);

// ─── PASSWORD HASHING ────────────────────────────────────────────────────────
// Uses scrypt - built into Node, no bcrypt dependency.
// Format stored: scrypt$N$r$p$salt_hex$hash_hex
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keyLen: 64 };

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(password, salt, SCRYPT_PARAMS.keyLen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  });
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  try {
    if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
    const parts = stored.split('$');
    if (parts.length !== 6) return false;
    const [_, nStr, rStr, pStr, saltHex, hashHex] = parts;
    const N = parseInt(nStr, 10);
    const r = parseInt(rStr, 10);
    const p = parseInt(pStr, 10);
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const derived = await scryptAsync(password, salt, expected.length, { N, r, p });
    return crypto.timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

// ─── TOKEN GENERATION ────────────────────────────────────────────────────────
export function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function generateInviteToken() {
  return crypto.randomBytes(24).toString('hex');
}

export function generateUserId() {
  return 'u_' + crypto.randomBytes(8).toString('hex');
}

// ─── SECRET ENCRYPTION (for per-user API keys, GitHub tokens, etc) ───────────
// Uses AES-256-GCM with a key derived from SKOPIX_SECRET_KEY env var.
// This is for protecting tokens at rest in the DB.

function _getMasterKey() {
  const secret = process.env.SKOPIX_SECRET_KEY;
  if (!secret || secret.length < 16) {
    throw new Error('SKOPIX_SECRET_KEY must be set (at least 16 characters) for encrypted storage');
  }
  // Derive a 32-byte key deterministically from the secret
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptSecret(plaintext) {
  if (typeof plaintext !== 'string') throw new Error('plaintext must be a string');
  const key = _getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: v1$iv_b64$tag_b64$ciphertext_b64
  return `v1$${iv.toString('base64')}$${tag.toString('base64')}$${encrypted.toString('base64')}`;
}

export function decryptSecret(stored) {
  if (typeof stored !== 'string' || !stored.startsWith('v1$')) {
    throw new Error('Invalid encrypted format');
  }
  const parts = stored.split('$');
  if (parts.length !== 4) throw new Error('Invalid encrypted format');
  const [_, ivB64, tagB64, ciphertextB64] = parts;
  const key = _getMasterKey();
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

// ─── EMAIL VALIDATION ────────────────────────────────────────────────────────
export function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  // Pragmatic check, not RFC-perfect
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

// ─── ROLES ───────────────────────────────────────────────────────────────────
export const ROLES = {
  ADMIN: 'admin',
  EDITOR: 'editor',
  VIEWER: 'viewer',
};

export function isValidRole(role) {
  return Object.values(ROLES).includes(role);
}

// Whitelist of secret keys a user can store. Used to validate inputs to /api/user/secrets/:key.
// Anything not in this list is rejected (prevents arbitrary data being stored in user_secrets).
export const USER_SECRET_KEYS = [
  // LLM providers
  'GEMINI_API_KEY',
  'CLAUDE_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY', // alias for Gemini in some configs
  'ANTHROPIC_API_KEY', // alias for Claude
  // Issue trackers
  'GITHUB_TOKEN',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
  'LINEAR_API_KEY',
];

export function isValidSecretKey(key) {
  return USER_SECRET_KEYS.includes(key);
}

// Permission helpers - centralised here so they're consistent across routes
export function canEdit(role) {
  return role === ROLES.ADMIN || role === ROLES.EDITOR;
}

export function canManageUsers(role) {
  return role === ROLES.ADMIN;
}

export function canRead(role) {
  return [ROLES.ADMIN, ROLES.EDITOR, ROLES.VIEWER].includes(role);
}
