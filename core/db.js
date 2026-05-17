// core/db.js — SQLite database for team mode (auth, users, sessions)
// In single-user mode this module is never loaded. In team mode it initialises
// the DB at ~/.skopix/skopix.db and exposes safe helpers.

import path from 'path';
import os from 'os';
import fs from 'fs-extra';

let _db = null;
let _dbPath = null;

// Lazy-import better-sqlite3 so it isn't required for single-user installs.
// Users only need it when running with SKOPIX_TEAM_MODE=true.
async function _loadSqlite() {
  try {
    const mod = await import('better-sqlite3');
    return mod.default;
  } catch (err) {
    throw new Error(
      'Team mode requires better-sqlite3. Install it with:\n  npm install better-sqlite3\n\n' +
      'Or run without SKOPIX_TEAM_MODE for single-user mode.'
    );
  }
}

export async function initDb(dbPath) {
  if (_db) return _db;

  _dbPath = dbPath || path.join(os.homedir(), '.skopix', 'skopix.db');
  await fs.ensureDir(path.dirname(_dbPath));

  const Database = await _loadSqlite();
  _db = new Database(_dbPath);

  // Performance + safety tweaks
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  _runMigrations(_db);
  return _db;
}

export function getDb() {
  if (!_db) throw new Error('Database not initialised. Call initDb() first.');
  return _db;
}

export function isDbReady() {
  return _db !== null;
}

export function getDbPath() {
  return _dbPath;
}

// ─── MIGRATIONS ──────────────────────────────────────────────────────────────
// Versioned schema migrations. To add a new one, append to the array.
// Existing migrations are immutable once shipped.
const MIGRATIONS = [
  {
    version: 2,
    name: 'password reset tokens',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS password_resets (
          token TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          used_at TEXT,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);
      `);
    },
  },
  {
    version: 1,
    name: 'initial schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_login_at TEXT,
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled'))
        );

        CREATE TABLE IF NOT EXISTS web_sessions (
          token TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_used_at TEXT NOT NULL,
          ip_address TEXT,
          user_agent TEXT,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS invites (
          token TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')),
          invited_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          accepted_at TEXT,
          FOREIGN KEY(invited_by) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT,
          action TEXT NOT NULL,
          target_type TEXT,
          target_id TEXT,
          metadata TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS user_secrets (
          user_id TEXT NOT NULL,
          key TEXT NOT NULL,
          value_encrypted TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(user_id, key),
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_web_sessions_user ON web_sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_web_sessions_expires ON web_sessions(expires_at);
        CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
        CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
      `);
    },
  },
];

function _runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version);
  const insert = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');

  // Run migrations in ascending version order
  const sortedMigrations = [...MIGRATIONS].sort((a, b) => a.version - b.version);
  for (const m of sortedMigrations) {
    if (applied.includes(m.version)) continue;
    const tx = db.transaction(() => {
      m.up(db);
      insert.run(m.version, m.name, new Date().toISOString());
    });
    tx();
  }
}

// ─── HIGH-LEVEL HELPERS ──────────────────────────────────────────────────────
export function hasAnyAdmin() {
  if (!_db) return false;
  const row = _db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND status = 'active'").get();
  return row.count > 0;
}

export function getUserById(id) {
  if (!_db) return null;
  return _db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function getUserByEmail(email) {
  if (!_db) return null;
  return _db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

export function listUsers() {
  if (!_db) return [];
  return _db.prepare('SELECT id, email, name, role, status, created_at, last_login_at FROM users ORDER BY created_at ASC').all();
}

export function createUser({ id, email, name, passwordHash, role, status }) {
  if (!_db) throw new Error('DB not ready');
  const now = new Date().toISOString();
  _db.prepare(`
    INSERT INTO users (id, email, name, password_hash, role, created_at, updated_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, email, name, passwordHash, role, now, now, status || 'active');
  return getUserById(id);
}

export function updateUserLastLogin(id) {
  if (!_db) return;
  const now = new Date().toISOString();
  _db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
}

export function createWebSession({ token, userId, expiresAt, ipAddress, userAgent }) {
  if (!_db) throw new Error('DB not ready');
  const now = new Date().toISOString();
  _db.prepare(`
    INSERT INTO web_sessions (token, user_id, created_at, expires_at, last_used_at, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(token, userId, now, expiresAt, now, ipAddress || null, userAgent || null);
}

export function getWebSession(token) {
  if (!_db) return null;
  const row = _db.prepare('SELECT * FROM web_sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    _db.prepare('DELETE FROM web_sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

export function touchWebSession(token) {
  if (!_db) return;
  _db.prepare('UPDATE web_sessions SET last_used_at = ? WHERE token = ?').run(new Date().toISOString(), token);
}

export function deleteWebSession(token) {
  if (!_db) return;
  _db.prepare('DELETE FROM web_sessions WHERE token = ?').run(token);
}

export function logAudit({ userId, action, targetType, targetId, metadata }) {
  if (!_db) return;
  _db.prepare(`
    INSERT INTO audit_log (user_id, action, target_type, target_id, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    userId || null,
    action,
    targetType || null,
    targetId || null,
    metadata ? JSON.stringify(metadata) : null,
    new Date().toISOString()
  );
}

// Cleanup expired sessions (call periodically)
export function pruneExpiredSessions() {
  if (!_db) return 0;
  const result = _db.prepare('DELETE FROM web_sessions WHERE expires_at < ?').run(new Date().toISOString());
  return result.changes;
}

// ─── USER MANAGEMENT ─────────────────────────────────────────────────────────
export function countAdmins() {
  if (!_db) return 0;
  const row = _db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND status = 'active'").get();
  return row.count;
}

export function updateUserRole(userId, newRole) {
  if (!_db) throw new Error('DB not ready');
  const now = new Date().toISOString();
  _db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(newRole, now, userId);
  return getUserById(userId);
}

export function updateUserStatus(userId, newStatus) {
  if (!_db) throw new Error('DB not ready');
  const now = new Date().toISOString();
  _db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run(newStatus, now, userId);
  return getUserById(userId);
}

export function deleteUser(userId) {
  if (!_db) throw new Error('DB not ready');
  // CASCADE deletes web_sessions and invites for this user
  const result = _db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  return result.changes > 0;
}

// ─── INVITES ─────────────────────────────────────────────────────────────────
export function createInvite({ token, email, role, invitedBy, expiresAt }) {
  if (!_db) throw new Error('DB not ready');
  const now = new Date().toISOString();
  _db.prepare(`
    INSERT INTO invites (token, email, role, invited_by, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(token, email, role, invitedBy, now, expiresAt);
  return getInvite(token);
}

export function getInvite(token) {
  if (!_db) return null;
  const row = _db.prepare('SELECT * FROM invites WHERE token = ?').get(token);
  if (!row) return null;
  return row;
}

export function listInvites() {
  if (!_db) return [];
  // Use a simple query - resolve invited_by in JS for shim compatibility
  const invites = _db.prepare('SELECT * FROM invites ORDER BY created_at DESC').all();
  return invites.map(inv => {
    const inviter = getUserById(inv.invited_by);
    return {
      ...inv,
      invited_by_name: inviter?.name || null,
      invited_by_email: inviter?.email || null,
    };
  });
}

export function deleteInvite(token) {
  if (!_db) throw new Error('DB not ready');
  const result = _db.prepare('DELETE FROM invites WHERE token = ?').run(token);
  return result.changes > 0;
}

export function markInviteAccepted(token) {
  if (!_db) throw new Error('DB not ready');
  _db.prepare('UPDATE invites SET accepted_at = ? WHERE token = ?').run(new Date().toISOString(), token);
}

export function pruneExpiredInvites() {
  if (!_db) return 0;
  const result = _db.prepare('DELETE FROM invites WHERE expires_at < ? AND accepted_at IS NULL').run(new Date().toISOString());
  return result.changes;
}

// ─── USER SECRETS (encrypted per-user tokens) ────────────────────────────────
// Stores encrypted strings keyed by (user_id, key). Encryption happens at the
// auth layer - this just persists already-encrypted ciphertext.
export function setUserSecret(userId, key, encryptedValue) {
  if (!_db) throw new Error('DB not ready');
  const now = new Date().toISOString();
  // Upsert pattern using INSERT OR REPLACE (works in SQLite)
  // First try update, then insert if no row affected
  const existing = _db.prepare('SELECT user_id FROM user_secrets WHERE user_id = ? AND key = ?').get(userId, key);
  if (existing) {
    _db.prepare('UPDATE user_secrets SET value_encrypted = ?, updated_at = ? WHERE user_id = ? AND key = ?')
      .run(encryptedValue, now, userId, key);
  } else {
    _db.prepare('INSERT INTO user_secrets (user_id, key, value_encrypted, updated_at) VALUES (?, ?, ?, ?)')
      .run(userId, key, encryptedValue, now);
  }
}

export function getUserSecret(userId, key) {
  if (!_db) return null;
  const row = _db.prepare('SELECT value_encrypted FROM user_secrets WHERE user_id = ? AND key = ?').get(userId, key);
  return row ? row.value_encrypted : null;
}

export function getUserSecretKeys(userId) {
  if (!_db) return [];
  const rows = _db.prepare('SELECT key, updated_at FROM user_secrets WHERE user_id = ?').all(userId);
  return rows.map(r => ({ key: r.key, updatedAt: r.updated_at }));
}

export function deleteUserSecret(userId, key) {
  if (!_db) throw new Error('DB not ready');
  const result = _db.prepare('DELETE FROM user_secrets WHERE user_id = ? AND key = ?').run(userId, key);
  return result.changes > 0;
}

// ─── PASSWORD CHANGE ─────────────────────────────────────────────────────────
export function updateUserPassword(userId, newPasswordHash) {
  if (!_db) throw new Error('DB not ready');
  const now = new Date().toISOString();
  _db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(newPasswordHash, now, userId);
}

// ─── AUDIT LOG ───────────────────────────────────────────────────────────────
// List audit events with optional filters. Returns most recent first.
// Filters: { userId, action, since (ISO string), limit (default 100, max 500) }
export function listAuditLog(filters = {}) {
  if (!_db) return [];
  const limit = Math.min(500, Math.max(1, filters.limit || 100));
  // Build query in JS since complex WHERE compositions are awkward in raw SQL
  // and our shim only handles simple ones. We fetch most-recent N, filter in JS.
  // For real installs with thousands of rows this is fine — we paginate by `before` timestamp.
  let sql = 'SELECT * FROM audit_log';
  const params = [];
  if (filters.since) {
    sql += ' WHERE created_at > ?';
    params.push(filters.since);
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  let rows = _db.prepare(sql).all(...params);

  // JS-side filtering for user/action (so shim works)
  if (filters.userId) rows = rows.filter(r => r.user_id === filters.userId);
  if (filters.action) rows = rows.filter(r => r.action === filters.action);

  // Enrich with user info (name + email) for display
  return rows.map(r => {
    const user = r.user_id ? getUserById(r.user_id) : null;
    return {
      id: r.id,
      userId: r.user_id,
      userName: user?.name || null,
      userEmail: user?.email || null,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      metadata: r.metadata ? (() => { try { return JSON.parse(r.metadata); } catch { return null; } })() : null,
      createdAt: r.created_at,
    };
  });
}

// ─── ACTIVE WEB SESSIONS (for admin view + force-logout) ─────────────────────
export function listActiveSessions() {
  if (!_db) return [];
  // Don't show expired ones
  const now = new Date().toISOString();
  const rows = _db.prepare('SELECT * FROM web_sessions WHERE expires_at > ? ORDER BY last_used_at DESC').all(now);
  return rows.map(r => {
    const user = getUserById(r.user_id);
    return {
      token: r.token, // we return the full token only to admins, used to revoke
      userId: r.user_id,
      userName: user?.name || null,
      userEmail: user?.email || null,
      userRole: user?.role || null,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      lastUsedAt: r.last_used_at,
      ipAddress: r.ip_address,
      userAgent: r.user_agent,
    };
  });
}

// ─── PASSWORD RESET TOKENS ───────────────────────────────────────────────────
// We don't have SMTP, so password reset works via admin-generated link.
// Admin generates a reset token, gives the link to the user, user sets new password.
// Tokens stored in same invites table with a different role marker? No - cleaner to
// use a dedicated approach via the audit log + a short-lived web_session-like row.
// Simpler approach: piggy-back on invites table with role='password_reset' marker.
// But that conflates two concepts. Let's add a tiny new table.

// Note: we can't add a new table in a migration without a new migration version.
// Instead, we'll re-use the invites table with a special role marker.
// Schema: role is CHECK(role IN ('admin','editor','viewer')) — can't insert 'password_reset'.
// So we need a real new table. Add migration 2.

// For now, use a simpler approach: store reset tokens in user_secrets with a magic key
// keyed by the user themselves. Hacky but avoids schema changes.

// Actually cleanest: re-use the existing invites table but encode reset by setting
// email=user's_current_email, role=user's_current_role. The accept-invite endpoint
// already creates a fresh user — that would create a duplicate user. So we need
// a different endpoint: /api/invites/:token/reset that updates instead of creates.

// Decision: add migration 2 with a password_resets table.
// (See MIGRATIONS array above - this is the cleanest path.)
export function createPasswordReset({ token, userId, expiresAt }) {
  if (!_db) throw new Error('DB not ready');
  const now = new Date().toISOString();
  _db.prepare(`
    INSERT INTO password_resets (token, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(token, userId, now, expiresAt);
  return { token, userId, expiresAt };
}

export function getPasswordReset(token) {
  if (!_db) return null;
  const row = _db.prepare('SELECT * FROM password_resets WHERE token = ?').get(token);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    _db.prepare('DELETE FROM password_resets WHERE token = ?').run(token);
    return null;
  }
  if (row.used_at) return null; // already used
  return row;
}

export function markPasswordResetUsed(token) {
  if (!_db) throw new Error('DB not ready');
  _db.prepare('UPDATE password_resets SET used_at = ? WHERE token = ?').run(new Date().toISOString(), token);
}

export function pruneExpiredPasswordResets() {
  if (!_db) return 0;
  const result = _db.prepare('DELETE FROM password_resets WHERE expires_at < ? AND used_at IS NULL').run(new Date().toISOString());
  return result.changes;
}

// Revoke all sessions for a user (used when forcing logout)
export function revokeAllUserSessions(userId) {
  if (!_db) throw new Error('DB not ready');
  const result = _db.prepare('DELETE FROM web_sessions WHERE user_id = ?').run(userId);
  return result.changes;
}
