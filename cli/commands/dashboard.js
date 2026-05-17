import chalk from 'chalk';
import http from 'http';
import path from 'path';
import fs from 'fs-extra';
import yaml from 'yaml';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import open from 'open';
import os from 'os';
import crypto from 'crypto';
import { loadIssueStore, saveIssueStore } from '../../core/tracker.js';

// Team mode imports - loaded lazily (only used when SKOPIX_TEAM_MODE=true)
let teamMode = null; // populated below if team mode is active

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAVED_TESTS_FILE = '_saved.suite.yaml';

export async function dashboardCommand(options) {
  const port = parseInt(options.port) || 9000;
  const host = options.host || process.env.SKOPIX_HOST || '127.0.0.1';
  const reportsDir = path.resolve(options.dir || './skopix-reports');
  const webRoot = path.resolve(__dirname, '..', '..', 'web');
  const suitesDir = path.resolve(process.cwd());
  const suiteRunsDir = path.join(reportsDir, '.suite-runs');

  await fs.ensureDir(reportsDir);
  await fs.ensureDir(suiteRunsDir);
  const activeRuns = new Map();

  // ─── TEAM MODE INIT (opt-in via env var or flag) ────────────────────────
  // Single-user mode (default): skip all DB/auth setup, behave exactly as before.
  // Team mode: initialise SQLite, enable /setup wizard and /api/auth routes.
  const isTeamMode = options.team === true || process.env.SKOPIX_TEAM_MODE === 'true' || process.env.SKOPIX_TEAM_MODE === '1';
  if (isTeamMode) {
    try {
      const dbModule = await import('../../core/db.js');
      const authModule = await import('../../core/auth.js');
      await dbModule.initDb();
      teamMode = { db: dbModule, auth: authModule };
      console.log(chalk.cyan('  ◆ Team mode enabled'));
    } catch (err) {
      console.error(chalk.red('  ✖ Failed to enable team mode: ') + err.message);
      console.error(chalk.dim('  Falling back to single-user mode'));
      teamMode = null;
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${port}`);
      const pathname = url.pathname;
      const method = req.method;

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      // ─── TEAM MODE: SETUP WIZARD ───────────────────────────────────────
      // Only active when team mode is on. In single-user mode these routes
      // simply don't match and execution falls through to existing logic.
      if (teamMode) {
        // Status endpoint - tells the frontend if setup is needed
        if (pathname === '/api/team/status' && method === 'GET') {
          sendJSON(res, 200, {
            teamMode: true,
            needsSetup: !teamMode.db.hasAnyAdmin(),
          });
          return;
        }

        // First-run setup: creates the initial admin
        if (pathname === '/api/setup' && method === 'POST') {
          if (teamMode.db.hasAnyAdmin()) {
            sendJSON(res, 403, { error: 'Setup already complete' });
            return;
          }
          try {
            const body = await readBody(req);
            const { email, name, password } = JSON.parse(body);
            if (!teamMode.auth.isValidEmail(email)) {
              sendJSON(res, 400, { error: 'Invalid email address' });
              return;
            }
            if (!name || typeof name !== 'string' || name.trim().length === 0) {
              sendJSON(res, 400, { error: 'Name is required' });
              return;
            }
            if (typeof password !== 'string' || password.length < 8) {
              sendJSON(res, 400, { error: 'Password must be at least 8 characters' });
              return;
            }
            const passwordHash = await teamMode.auth.hashPassword(password);
            const userId = teamMode.auth.generateUserId();
            const user = teamMode.db.createUser({
              id: userId,
              email: email.trim().toLowerCase(),
              name: name.trim(),
              passwordHash,
              role: 'admin',
            });
            teamMode.db.logAudit({
              userId: user.id,
              action: 'user.created',
              targetType: 'user',
              targetId: user.id,
              metadata: { role: 'admin', via: 'setup-wizard' },
            });
            sendJSON(res, 200, {
              ok: true,
              user: { id: user.id, email: user.email, name: user.name, role: user.role },
            });
          } catch (err) {
            sendJSON(res, 500, { error: err.message });
          }
          return;
        }

        // ─── AUTH: LOGIN ─────────────────────────────────────────────────
        if (pathname === '/api/auth/login' && method === 'POST') {
          try {
            const body = await readBody(req);
            const { email, password } = JSON.parse(body);
            if (typeof email !== 'string' || typeof password !== 'string') {
              sendJSON(res, 400, { error: 'Email and password are required' });
              return;
            }
            const user = teamMode.db.getUserByEmail(email.trim().toLowerCase());
            // Use generic error to avoid leaking which emails are registered
            const fail = () => sendJSON(res, 401, { error: 'Invalid email or password' });
            if (!user) { fail(); return; }
            if (user.status !== 'active') {
              sendJSON(res, 403, { error: 'Account is disabled. Contact your admin.' });
              return;
            }
            const ok = await teamMode.auth.verifyPassword(password, user.password_hash);
            if (!ok) { fail(); return; }

            // Create session
            const token = teamMode.auth.generateSessionToken();
            const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
            teamMode.db.createWebSession({
              token,
              userId: user.id,
              expiresAt,
              ipAddress: req.socket.remoteAddress,
              userAgent: req.headers['user-agent'] || null,
            });
            teamMode.db.updateUserLastLogin(user.id);
            teamMode.db.logAudit({
              userId: user.id,
              action: 'user.login',
              targetType: 'user',
              targetId: user.id,
            });

            // Set HTTP-only cookie
            // Note: SameSite=Lax allows the cookie to flow on same-site navigations.
            // We don't set Secure unless the request was HTTPS (so localhost still works).
            const isHttps = req.headers['x-forwarded-proto'] === 'https' || req.connection.encrypted === true;
            const cookieAttrs = [
              `skopix_session=${token}`,
              'Path=/',
              'HttpOnly',
              'SameSite=Lax',
              `Max-Age=${30 * 24 * 60 * 60}`,
              ...(isHttps ? ['Secure'] : []),
            ];
            res.setHeader('Set-Cookie', cookieAttrs.join('; '));
            sendJSON(res, 200, {
              ok: true,
              user: { id: user.id, email: user.email, name: user.name, role: user.role },
            });
          } catch (err) {
            sendJSON(res, 500, { error: err.message });
          }
          return;
        }

        // ─── AUTH: LOGOUT ────────────────────────────────────────────────
        if (pathname === '/api/auth/logout' && method === 'POST') {
          const token = parseCookie(req.headers.cookie || '', 'skopix_session');
          if (token) {
            const session = teamMode.db.getWebSession(token);
            if (session) {
              teamMode.db.logAudit({
                userId: session.user_id,
                action: 'user.logout',
                targetType: 'user',
                targetId: session.user_id,
              });
            }
            teamMode.db.deleteWebSession(token);
          }
          // Clear the cookie
          res.setHeader('Set-Cookie', 'skopix_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
          sendJSON(res, 200, { ok: true });
          return;
        }

        // ─── AUTH: ME (whoami) ───────────────────────────────────────────
        if (pathname === '/api/auth/me' && method === 'GET') {
          const token = parseCookie(req.headers.cookie || '', 'skopix_session');
          if (!token) {
            sendJSON(res, 401, { error: 'Not authenticated' });
            return;
          }
          const session = teamMode.db.getWebSession(token);
          if (!session) {
            // Token invalid or expired - clear cookie too
            res.setHeader('Set-Cookie', 'skopix_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
            sendJSON(res, 401, { error: 'Session expired' });
            return;
          }
          const user = teamMode.db.getUserById(session.user_id);
          if (!user || user.status !== 'active') {
            teamMode.db.deleteWebSession(token);
            res.setHeader('Set-Cookie', 'skopix_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
            sendJSON(res, 401, { error: 'Account no longer active' });
            return;
          }
          // Refresh last_used_at so active sessions don't expire prematurely
          teamMode.db.touchWebSession(token);
          sendJSON(res, 200, {
            user: { id: user.id, email: user.email, name: user.name, role: user.role },
          });
          return;
        }
      }

      // ─── AUTH GATE (team mode only) ────────────────────────────────────
      // In team mode, every non-public route requires a valid session.
      // Public routes (login, setup, status, static pages) are allowed through.
      // In single-user mode this check is skipped entirely.
      let currentUser = null;
      if (teamMode) {
        const resolved = resolveCurrentUser(req, teamMode);
        if (resolved) currentUser = resolved.user;

        // Special: the /app/ dashboard requires auth at the server level.
        // If not authenticated, redirect to /login so the user never sees the dashboard.
        // (The JS-level check is still there as a defence-in-depth fallback.)
        const isAppPage = (pathname === '/app' || pathname === '/app/' || pathname === '/app/index.html');
        if (isAppPage && !currentUser) {
          res.writeHead(302, { Location: '/login' });
          res.end();
          return;
        }

        // For protected API routes (everything not in the public whitelist), 401.
        if (!isPublicPath(pathname) && !currentUser) {
          sendJSON(res, 401, { error: 'Authentication required' });
          return;
        }

        // ─── ROLE-BASED WRITE BLOCK (viewers are read-only) ──────────────
        // Block any write method for viewers. The few endpoints that viewers
        // legitimately need to call (logout, change own password, etc) are
        // explicitly whitelisted below.
        if (currentUser && currentUser.role === 'viewer') {
          const isWriteMethod = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
          // Allowed writes for viewers - things they need for basic account use
          const viewerAllowedWrites = (
            pathname === '/api/auth/logout' || // can log themselves out
            pathname === '/api/user/password' || // can change own password
            pathname.startsWith('/api/user/secrets') // can manage own API keys
          );
          if (isWriteMethod && !viewerAllowedWrites) {
            sendJSON(res, 403, { error: 'Your role is read-only. Ask an admin to upgrade you to Editor to make changes.' });
            return;
          }
        }
      }

      // ─── TEAM MODE: USERS & INVITES (admin only) ───────────────────────
      // All these endpoints require admin role. currentUser is set by the auth gate above.
      if (teamMode) {
        // List all users
        if (pathname === '/api/users' && method === 'GET') {
          if (!currentUser || !teamMode.auth.canManageUsers(currentUser.role)) {
            sendJSON(res, 403, { error: 'Admin access required' });
            return;
          }
          // Defence in depth: sanitise output (never expose password_hash)
          const users = teamMode.db.listUsers().map(u => ({
            id: u.id, email: u.email, name: u.name,
            role: u.role, status: u.status,
            created_at: u.created_at, last_login_at: u.last_login_at,
          }));
          sendJSON(res, 200, users);
          return;
        }

        // Update a user (change role or status)
        if (pathname.match(/^\/api\/users\/[^/]+$/) && method === 'PATCH') {
          if (!currentUser || !teamMode.auth.canManageUsers(currentUser.role)) {
            sendJSON(res, 403, { error: 'Admin access required' });
            return;
          }
          const userId = pathname.split('/')[3];
          try {
            const body = await readBody(req);
            const { role, status } = JSON.parse(body);

            const target = teamMode.db.getUserById(userId);
            if (!target) { sendJSON(res, 404, { error: 'User not found' }); return; }

            // Safety: can't downgrade your own role
            if (role && target.id === currentUser.id && role !== currentUser.role) {
              sendJSON(res, 400, { error: "You can't change your own role. Ask another admin." });
              return;
            }
            // Safety: can't disable yourself
            if (status === 'disabled' && target.id === currentUser.id) {
              sendJSON(res, 400, { error: "You can't disable your own account." });
              return;
            }
            // Safety: can't demote/disable the last active admin
            if ((role && role !== 'admin' && target.role === 'admin') ||
                (status === 'disabled' && target.role === 'admin')) {
              if (teamMode.db.countAdmins() <= 1) {
                sendJSON(res, 400, { error: 'Cannot remove the last admin. Promote someone else first.' });
                return;
              }
            }

            let updated = target;
            if (role && teamMode.auth.isValidRole(role)) {
              updated = teamMode.db.updateUserRole(userId, role);
              teamMode.db.logAudit({
                userId: currentUser.id, action: 'user.role_changed',
                targetType: 'user', targetId: userId,
                metadata: { from: target.role, to: role },
              });
            }
            if (status && (status === 'active' || status === 'disabled')) {
              updated = teamMode.db.updateUserStatus(userId, status);
              teamMode.db.logAudit({
                userId: currentUser.id, action: status === 'disabled' ? 'user.disabled' : 'user.enabled',
                targetType: 'user', targetId: userId,
              });
              // If disabling, kill all their sessions
              if (status === 'disabled') {
                teamMode.db.getDb().prepare('DELETE FROM web_sessions WHERE user_id = ?').run(userId);
              }
            }
            sendJSON(res, 200, { id: updated.id, email: updated.email, name: updated.name, role: updated.role, status: updated.status });
          } catch (err) {
            sendJSON(res, 500, { error: err.message });
          }
          return;
        }

        // Delete a user
        if (pathname.match(/^\/api\/users\/[^/]+$/) && method === 'DELETE') {
          if (!currentUser || !teamMode.auth.canManageUsers(currentUser.role)) {
            sendJSON(res, 403, { error: 'Admin access required' });
            return;
          }
          const userId = pathname.split('/')[3];
          const target = teamMode.db.getUserById(userId);
          if (!target) { sendJSON(res, 404, { error: 'User not found' }); return; }

          // Safety rails
          if (target.id === currentUser.id) {
            sendJSON(res, 400, { error: "You can't remove yourself. Ask another admin." });
            return;
          }
          if (target.role === 'admin' && teamMode.db.countAdmins() <= 1) {
            sendJSON(res, 400, { error: 'Cannot remove the last admin.' });
            return;
          }
          teamMode.db.deleteUser(userId);
          teamMode.db.logAudit({
            userId: currentUser.id, action: 'user.deleted',
            targetType: 'user', targetId: userId,
            metadata: { email: target.email, name: target.name },
          });
          sendJSON(res, 200, { deleted: true });
          return;
        }

        // List pending invites
        if (pathname === '/api/invites' && method === 'GET') {
          if (!currentUser || !teamMode.auth.canManageUsers(currentUser.role)) {
            sendJSON(res, 403, { error: 'Admin access required' });
            return;
          }
          // Prune expired first so the list is clean
          teamMode.db.pruneExpiredInvites();
          sendJSON(res, 200, teamMode.db.listInvites());
          return;
        }

        // Create an invite
        if (pathname === '/api/invites' && method === 'POST') {
          if (!currentUser || !teamMode.auth.canManageUsers(currentUser.role)) {
            sendJSON(res, 403, { error: 'Admin access required' });
            return;
          }
          try {
            const body = await readBody(req);
            const { email, role } = JSON.parse(body);
            const trimmedEmail = (email || '').trim().toLowerCase();
            if (!teamMode.auth.isValidEmail(trimmedEmail)) {
              sendJSON(res, 400, { error: 'Invalid email address' });
              return;
            }
            if (!teamMode.auth.isValidRole(role)) {
              sendJSON(res, 400, { error: 'Invalid role. Choose admin, editor, or viewer.' });
              return;
            }
            // Reject if a user already exists with this email
            if (teamMode.db.getUserByEmail(trimmedEmail)) {
              sendJSON(res, 400, { error: 'A user with that email already exists.' });
              return;
            }
            const token = teamMode.auth.generateInviteToken();
            const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
            const invite = teamMode.db.createInvite({
              token, email: trimmedEmail, role, invitedBy: currentUser.id, expiresAt,
            });
            teamMode.db.logAudit({
              userId: currentUser.id, action: 'invite.created',
              targetType: 'invite', targetId: token,
              metadata: { email: trimmedEmail, role },
            });
            sendJSON(res, 200, {
              token: invite.token, email: invite.email, role: invite.role, expiresAt: invite.expires_at,
            });
          } catch (err) {
            sendJSON(res, 500, { error: err.message });
          }
          return;
        }

        // Revoke an invite
        if (pathname.match(/^\/api\/invites\/[^/]+$/) && method === 'DELETE') {
          if (!currentUser || !teamMode.auth.canManageUsers(currentUser.role)) {
            sendJSON(res, 403, { error: 'Admin access required' });
            return;
          }
          const token = pathname.split('/')[3];
          const deleted = teamMode.db.deleteInvite(token);
          if (deleted) {
            teamMode.db.logAudit({
              userId: currentUser.id, action: 'invite.revoked',
              targetType: 'invite', targetId: token,
            });
          }
          sendJSON(res, 200, { deleted });
          return;
        }

        // ─── AUDIT LOG (admin only) ──────────────────────────────────────
        if (pathname === '/api/audit-log' && method === 'GET') {
          if (!currentUser || !teamMode.auth.canManageUsers(currentUser.role)) {
            sendJSON(res, 403, { error: 'Admin access required' });
            return;
          }
          const url = new URL(req.url, `http://localhost:${port}`);
          const filters = {
            userId: url.searchParams.get('userId') || undefined,
            action: url.searchParams.get('action') || undefined,
            since: url.searchParams.get('since') || undefined,
            limit: parseInt(url.searchParams.get('limit') || '100'),
          };
          sendJSON(res, 200, teamMode.db.listAuditLog(filters));
          return;
        }

        // ─── ACTIVE SESSIONS (admin only) ────────────────────────────────
        if (pathname === '/api/sessions/active' && method === 'GET') {
          if (!currentUser || !teamMode.auth.canManageUsers(currentUser.role)) {
            sendJSON(res, 403, { error: 'Admin access required' });
            return;
          }
          const sessions = teamMode.db.listActiveSessions().map(s => ({
            // Hash the token before sending so the actual session cookie isn't leaked
            // even to admins. We only need the token to revoke - keep a short id instead.
            shortId: s.token.slice(0, 8) + '...' + s.token.slice(-4),
            tokenHash: crypto.createHash('sha256').update(s.token).digest('hex').slice(0, 16),
            userId: s.userId, userName: s.userName, userEmail: s.userEmail, userRole: s.userRole,
            createdAt: s.createdAt, expiresAt: s.expiresAt, lastUsedAt: s.lastUsedAt,
            ipAddress: s.ipAddress, userAgent: s.userAgent,
            isCurrent: s.userId === currentUser.id,
          }));
          sendJSON(res, 200, sessions);
          return;
        }

        // Force logout: revoke all sessions for a user (admin only)
        if (pathname.match(/^\/api\/users\/[^/]+\/sessions$/) && method === 'DELETE') {
          if (!currentUser || !teamMode.auth.canManageUsers(currentUser.role)) {
            sendJSON(res, 403, { error: 'Admin access required' });
            return;
          }
          const userId = pathname.split('/')[3];
          const target = teamMode.db.getUserById(userId);
          if (!target) { sendJSON(res, 404, { error: 'User not found' }); return; }
          if (target.id === currentUser.id) {
            sendJSON(res, 400, { error: "You can't force-logout yourself. Use the logout button instead." });
            return;
          }
          const revoked = teamMode.db.revokeAllUserSessions(userId);
          teamMode.db.logAudit({
            userId: currentUser.id, action: 'user.sessions_revoked',
            targetType: 'user', targetId: userId,
            metadata: { sessionsRevoked: revoked },
          });
          sendJSON(res, 200, { ok: true, revoked });
          return;
        }

        // ─── ADMIN-GENERATED PASSWORD RESET LINK ─────────────────────────
        if (pathname.match(/^\/api\/users\/[^/]+\/reset-password$/) && method === 'POST') {
          if (!currentUser || !teamMode.auth.canManageUsers(currentUser.role)) {
            sendJSON(res, 403, { error: 'Admin access required' });
            return;
          }
          const userId = pathname.split('/')[3];
          const target = teamMode.db.getUserById(userId);
          if (!target) { sendJSON(res, 404, { error: 'User not found' }); return; }
          const token = teamMode.auth.generateInviteToken();
          const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h
          teamMode.db.createPasswordReset({ token, userId, expiresAt });
          teamMode.db.logAudit({
            userId: currentUser.id, action: 'user.reset_generated',
            targetType: 'user', targetId: userId,
            metadata: { email: target.email },
          });
          sendJSON(res, 200, { token, expiresAt });
          return;
        }

        // ─── PUBLIC INVITE ENDPOINTS (no auth needed) ──────────────────
        // Get invite details (for the accept page to show context)
        if (pathname.match(/^\/api\/invites\/[^/]+$/) && method === 'GET') {
          const token = pathname.split('/')[3];
          const invite = teamMode.db.getInvite(token);
          if (!invite) { sendJSON(res, 404, { error: 'Invalid or expired invite' }); return; }
          if (new Date(invite.expires_at) < new Date()) {
            sendJSON(res, 410, { error: 'This invite has expired' });
            return;
          }
          if (invite.accepted_at) {
            sendJSON(res, 410, { error: 'This invite has already been used' });
            return;
          }
          const inviter = teamMode.db.getUserById(invite.invited_by);
          sendJSON(res, 200, {
            email: invite.email,
            role: invite.role,
            invitedByName: inviter?.name || 'an admin',
            expiresAt: invite.expires_at,
          });
          return;
        }

        // Accept an invite + create the account
        if (pathname.match(/^\/api\/invites\/[^/]+\/accept$/) && method === 'POST') {
          const token = pathname.split('/')[3];
          const invite = teamMode.db.getInvite(token);
          if (!invite) { sendJSON(res, 404, { error: 'Invalid invite' }); return; }
          if (new Date(invite.expires_at) < new Date()) {
            sendJSON(res, 410, { error: 'This invite has expired' });
            return;
          }
          if (invite.accepted_at) {
            sendJSON(res, 410, { error: 'This invite has already been used' });
            return;
          }
          try {
            const body = await readBody(req);
            const { name, password } = JSON.parse(body);
            if (!name || typeof name !== 'string' || name.trim().length === 0) {
              sendJSON(res, 400, { error: 'Name is required' });
              return;
            }
            if (typeof password !== 'string' || password.length < 8) {
              sendJSON(res, 400, { error: 'Password must be at least 8 characters' });
              return;
            }
            // Double-check email isn't taken (in case admin manually created since invite)
            if (teamMode.db.getUserByEmail(invite.email)) {
              sendJSON(res, 400, { error: 'A user with that email already exists' });
              return;
            }
            const passwordHash = await teamMode.auth.hashPassword(password);
            const userId = teamMode.auth.generateUserId();
            const user = teamMode.db.createUser({
              id: userId,
              email: invite.email,
              name: name.trim(),
              passwordHash,
              role: invite.role,
            });
            teamMode.db.markInviteAccepted(token);
            teamMode.db.logAudit({
              userId: user.id, action: 'user.created',
              targetType: 'user', targetId: user.id,
              metadata: { role: invite.role, via: 'invite', invitedBy: invite.invited_by },
            });

            // Auto-login: create session + cookie
            const sessionToken = teamMode.auth.generateSessionToken();
            const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
            teamMode.db.createWebSession({
              token: sessionToken,
              userId: user.id,
              expiresAt: sessionExpires,
              ipAddress: req.socket.remoteAddress,
              userAgent: req.headers['user-agent'] || null,
            });
            teamMode.db.updateUserLastLogin(user.id);

            const isHttps = req.headers['x-forwarded-proto'] === 'https' || req.connection.encrypted === true;
            const cookieAttrs = [
              `skopix_session=${sessionToken}`,
              'Path=/', 'HttpOnly', 'SameSite=Lax',
              `Max-Age=${30 * 24 * 60 * 60}`,
              ...(isHttps ? ['Secure'] : []),
            ];
            res.setHeader('Set-Cookie', cookieAttrs.join('; '));
            sendJSON(res, 200, {
              ok: true,
              user: { id: user.id, email: user.email, name: user.name, role: user.role },
            });
          } catch (err) {
            sendJSON(res, 500, { error: err.message });
          }
          return;
        }

        // GET password reset details (public)
        if (pathname.match(/^\/api\/password-reset\/[^/]+$/) && method === 'GET') {
          const token = pathname.split('/')[3];
          const reset = teamMode.db.getPasswordReset(token);
          if (!reset) { sendJSON(res, 404, { error: 'Invalid or expired link' }); return; }
          const user = teamMode.db.getUserById(reset.user_id);
          if (!user) { sendJSON(res, 404, { error: 'User no longer exists' }); return; }
          sendJSON(res, 200, {
            email: user.email,
            name: user.name,
            expiresAt: reset.expires_at,
          });
          return;
        }

        // Use password reset link (public)
        if (pathname.match(/^\/api\/password-reset\/[^/]+$/) && method === 'POST') {
          const token = pathname.split('/')[3];
          const reset = teamMode.db.getPasswordReset(token);
          if (!reset) { sendJSON(res, 404, { error: 'Invalid or expired link' }); return; }
          try {
            const body = await readBody(req);
            const { newPassword } = JSON.parse(body);
            if (typeof newPassword !== 'string' || newPassword.length < 8) {
              sendJSON(res, 400, { error: 'Password must be at least 8 characters' });
              return;
            }
            const user = teamMode.db.getUserById(reset.user_id);
            if (!user) { sendJSON(res, 404, { error: 'User no longer exists' }); return; }
            const newHash = await teamMode.auth.hashPassword(newPassword);
            teamMode.db.updateUserPassword(user.id, newHash);
            teamMode.db.markPasswordResetUsed(token);
            // Revoke all existing sessions so old logins force a re-login
            teamMode.db.revokeAllUserSessions(user.id);
            teamMode.db.logAudit({
              userId: user.id, action: 'user.password_reset',
              targetType: 'user', targetId: user.id,
              metadata: { via: 'admin-link' },
            });
            sendJSON(res, 200, { ok: true });
          } catch (err) {
            sendJSON(res, 500, { error: err.message });
          }
          return;
        }

        // ─── USER SECRETS (per-user encrypted tokens) ────────────────────
        // List secret keys this user has set (returns keys only, never values).
        if (pathname === '/api/user/secrets' && method === 'GET') {
          if (!currentUser) { sendJSON(res, 401, { error: 'Auth required' }); return; }
          const keys = teamMode.db.getUserSecretKeys(currentUser.id);
          sendJSON(res, 200, keys);
          return;
        }

        // Set a single secret. Body: { value: '...' }. Empty value = delete.
        if (pathname.match(/^\/api\/user\/secrets\/[A-Z_]+$/) && method === 'PUT') {
          if (!currentUser) { sendJSON(res, 401, { error: 'Auth required' }); return; }
          // Note: viewers ARE allowed to set their own secrets (they manage their own account).
          // The viewer write-block above is overridden here because this endpoint only affects the user themselves.
          const key = pathname.split('/').pop();
          if (!teamMode.auth.isValidSecretKey(key)) {
            sendJSON(res, 400, { error: 'Unknown secret key. Allowed: ' + teamMode.auth.USER_SECRET_KEYS.join(', ') });
            return;
          }
          try {
            const body = await readBody(req);
            const { value } = JSON.parse(body);
            if (typeof value !== 'string') { sendJSON(res, 400, { error: 'Value must be a string' }); return; }

            // Empty string = delete the secret
            if (value.trim() === '') {
              teamMode.db.deleteUserSecret(currentUser.id, key);
              teamMode.db.logAudit({
                userId: currentUser.id, action: 'user.secret_deleted',
                targetType: 'user_secret', targetId: key,
              });
              sendJSON(res, 200, { ok: true, deleted: true });
              return;
            }

            // Encrypt and store
            const encrypted = teamMode.auth.encryptSecret(value);
            teamMode.db.setUserSecret(currentUser.id, key, encrypted);
            teamMode.db.logAudit({
              userId: currentUser.id, action: 'user.secret_set',
              targetType: 'user_secret', targetId: key,
            });
            sendJSON(res, 200, { ok: true, key });
          } catch (err) {
            sendJSON(res, 500, { error: err.message });
          }
          return;
        }

        // Delete a single secret explicitly.
        if (pathname.match(/^\/api\/user\/secrets\/[A-Z_]+$/) && method === 'DELETE') {
          if (!currentUser) { sendJSON(res, 401, { error: 'Auth required' }); return; }
          const key = pathname.split('/').pop();
          if (!teamMode.auth.isValidSecretKey(key)) {
            sendJSON(res, 400, { error: 'Unknown secret key' });
            return;
          }
          teamMode.db.deleteUserSecret(currentUser.id, key);
          teamMode.db.logAudit({
            userId: currentUser.id, action: 'user.secret_deleted',
            targetType: 'user_secret', targetId: key,
          });
          sendJSON(res, 200, { ok: true });
          return;
        }

        // ─── CHANGE OWN PASSWORD ─────────────────────────────────────────
        if (pathname === '/api/user/password' && method === 'POST') {
          if (!currentUser) { sendJSON(res, 401, { error: 'Auth required' }); return; }
          try {
            const body = await readBody(req);
            const { currentPassword, newPassword } = JSON.parse(body);
            if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
              sendJSON(res, 400, { error: 'currentPassword and newPassword are required' });
              return;
            }
            if (newPassword.length < 8) {
              sendJSON(res, 400, { error: 'New password must be at least 8 characters' });
              return;
            }
            // Verify current password
            const fresh = teamMode.db.getUserById(currentUser.id);
            const ok = await teamMode.auth.verifyPassword(currentPassword, fresh.password_hash);
            if (!ok) {
              sendJSON(res, 401, { error: 'Current password is incorrect' });
              return;
            }
            const newHash = await teamMode.auth.hashPassword(newPassword);
            teamMode.db.updateUserPassword(currentUser.id, newHash);
            teamMode.db.logAudit({
              userId: currentUser.id, action: 'user.password_changed',
              targetType: 'user', targetId: currentUser.id,
            });
            sendJSON(res, 200, { ok: true });
          } catch (err) {
            sendJSON(res, 500, { error: err.message });
          }
          return;
        }
      }

      // ─── SESSIONS ──────────────────────────────────────────────────────
      if (pathname === '/api/sessions' && method === 'GET') {
        sendJSON(res, 200, await listSessions(reportsDir));
        return;
      }
      if (pathname === '/api/stats' && method === 'GET') {
        const sessions = await listSessions(reportsDir);
        sendJSON(res, 200, computeStats(sessions));
        return;
      }
      if (pathname.startsWith('/api/session/') && method === 'GET') {
        const id = pathname.split('/')[3];
        const data = await getSession(reportsDir, id);
        if (!data) sendJSON(res, 404, { error: 'Not found' });
        else sendJSON(res, 200, data);
        return;
      }
      if (pathname.startsWith('/api/session/') && method === 'DELETE') {
        const id = pathname.split('/')[3];
        await deleteSession(reportsDir, id);
        sendJSON(res, 200, { deleted: true });
        return;
      }
      if (pathname === '/api/sessions' && method === 'DELETE') {
        // Delete all sessions
        await deleteAllSessions(reportsDir);
        sendJSON(res, 200, { deleted: true });
        return;
      }
      if (pathname === '/api/config' && method === 'GET') {
        sendJSON(res, 200, await getConfig());
        return;
      }

      // ─── RUN ───────────────────────────────────────────────────────────
      if (pathname === '/api/run' && method === 'POST') {
        const body = await readBody(req);
        const config = JSON.parse(body);
        const userEnv = await resolveUserSecretsEnv(currentUser?.id, teamMode);
        const runId = startRun(config, activeRuns, reportsDir, currentUser, userEnv);
        sendJSON(res, 200, { runId });
        return;
      }
      if (pathname.startsWith('/api/stream/') && method === 'GET') {
        const runId = pathname.split('/')[3];
        streamRun(req, res, runId, activeRuns);
        return;
      }
      if (pathname.startsWith('/api/report/') && method === 'GET') {
        const id = pathname.split('/')[3];
        const reportPath = path.join(reportsDir, id, 'report.html');
        if (await fs.pathExists(reportPath)) {
          // Instead of trying to open a local file (breaks in Docker), redirect to
          // the HTTP-served report route which works everywhere.
          res.writeHead(302, { Location: '/report/' + id + '/' });
          res.end();
        } else sendJSON(res, 404, { error: 'Not found' });
        return;
      }

      // Serve report HTML and its assets over HTTP.
      // Works in Docker (no local file access needed) and on bare-metal installs.
      // Route: /report/:sessionId/         -> serves report.html
      //        /report/:sessionId/<asset>  -> serves screenshots/videos/etc
      if (pathname.startsWith('/report/') && method === 'GET') {
        const parts = pathname.split('/').filter(Boolean); // ['report', id, ...rest]
        const id = parts[1];
        if (!id) { sendJSON(res, 404, { error: 'Not found' }); return; }
        // Remaining path after /report/:id/ - defaults to report.html
        const assetPath = parts.slice(2).join('/') || 'report.html';
        // Prevent path traversal
        const safeAsset = path.normalize(assetPath).replace(/^(\.\.\/|\/)+/, '');
        const filePath = path.join(reportsDir, id, safeAsset);
        if (!await fs.pathExists(filePath)) { sendJSON(res, 404, { error: 'Not found' }); return; }
        // Serve the file with appropriate Content-Type
        const ext = path.extname(filePath).toLowerCase();
        const mime = {
          '.html': 'text/html; charset=utf-8',
          '.css': 'text/css',
          '.js': 'application/javascript',
          '.json': 'application/json',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.webm': 'video/webm',
          '.mp4': 'video/mp4',
          '.svg': 'image/svg+xml',
          '.woff2': 'font/woff2',
          '.woff': 'font/woff',
        }[ext] || 'application/octet-stream';
        const stat = await fs.stat(filePath);
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size });
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
        return;
      }

      // ─── ALL TESTS (universal view) ─────────────────────────────────────
      if (pathname === '/api/tests' && method === 'GET') {
        sendJSON(res, 200, await listAllTests(suitesDir));
        return;
      }

      // /api/test/<scope>/<testId>  - get/update/delete a specific test
      // Scope is either "saved" or a suite filename
      if (pathname.match(/^\/api\/test\/[^/]+\/[^/]+$/) && method === 'GET') {
        const parts = pathname.split('/');
        const scope = decodeURIComponent(parts[3]);
        const testId = decodeURIComponent(parts[4]);
        const test = await getTest(suitesDir, scope, testId);
        if (!test) sendJSON(res, 404, { error: 'Not found' });
        else sendJSON(res, 200, test);
        return;
      }
      if (pathname.match(/^\/api\/test\/[^/]+\/[^/]+$/) && method === 'PUT') {
        const parts = pathname.split('/');
        const scope = decodeURIComponent(parts[3]);
        const testId = decodeURIComponent(parts[4]);
        const body = await readBody(req);
        const data = JSON.parse(body);
        try {
          const result = await updateTest(suitesDir, scope, testId, data);
          sendJSON(res, 200, result);
        } catch (err) {
          sendJSON(res, 400, { error: err.message });
        }
        return;
      }
      if (pathname.match(/^\/api\/test\/[^/]+\/[^/]+$/) && method === 'DELETE') {
        const parts = pathname.split('/');
        const scope = decodeURIComponent(parts[3]);
        const testId = decodeURIComponent(parts[4]);
        await deleteTest(suitesDir, scope, testId);
        sendJSON(res, 200, { deleted: true });
        return;
      }

      // /api/test - create a new test in a scope
      if (pathname === '/api/test' && method === 'POST') {
        const body = await readBody(req);
        const data = JSON.parse(body); // { scope, test }
        try {
          const result = await createTest(suitesDir, data.scope, data.test);
          sendJSON(res, 200, result);
        } catch (err) {
          sendJSON(res, 400, { error: err.message });
        }
        return;
      }

      // /api/test/<scope>/<testId>/duplicate - create a copy in the same scope
      if (pathname.match(/^\/api\/test\/[^/]+\/[^/]+\/duplicate$/) && method === 'POST') {
        const parts = pathname.split('/');
        const scope = decodeURIComponent(parts[3]);
        const testId = decodeURIComponent(parts[4]);
        try {
          const result = await duplicateTest(suitesDir, scope, testId);
          if (!result) { sendJSON(res, 404, { error: 'Test not found' }); return; }
          // Audit log entry if in team mode
          if (teamMode && currentUser) {
            teamMode.db.logAudit({
              userId: currentUser.id, action: 'test.duplicated',
              targetType: 'test', targetId: result.id,
              metadata: { scope, sourceTestId: testId, newName: result.name },
            });
          }
          sendJSON(res, 200, result);
        } catch (err) {
          sendJSON(res, 400, { error: err.message });
        }
        return;
      }

      // /api/test/<scope>/<testId>/move  - move to different scope
      if (pathname.match(/^\/api\/test\/[^/]+\/[^/]+\/move$/) && method === 'POST') {
        const parts = pathname.split('/');
        const fromScope = decodeURIComponent(parts[3]);
        const testId = decodeURIComponent(parts[4]);
        const body = await readBody(req);
        const { toScope } = JSON.parse(body);
        try {
          const result = await moveTest(suitesDir, fromScope, testId, toScope);
          sendJSON(res, 200, result);
        } catch (err) {
          sendJSON(res, 400, { error: err.message });
        }
        return;
      }

      // /api/test/<scope>/<testId>/run  - run a single test by reference
      if (pathname.match(/^\/api\/test\/[^/]+\/[^/]+\/run$/) && method === 'POST') {
        const parts = pathname.split('/');
        const scope = decodeURIComponent(parts[3]);
        const testId = decodeURIComponent(parts[4]);
        const test = await getTest(suitesDir, scope, testId);
        if (!test) { sendJSON(res, 404, { error: 'Not found' }); return; }
        const config = {
          url: test.url,
          goal: test.goal,
          maxSteps: test.maxSteps,
          credentials: test.credentials,
          provider: test.provider,
          model: test.model,
          github: !!test.github,
          jira: !!test.jira,
          linear: !!test.linear,
          headless: !!test.headless,
          testName: test.name,
        };
        const userEnv = await resolveUserSecretsEnv(currentUser?.id, teamMode);
        const runId = startRun(config, activeRuns, reportsDir, currentUser, userEnv);
        sendJSON(res, 200, { runId });
        return;
      }

      // ─── SUITES ────────────────────────────────────────────────────────
      if (pathname === '/api/suites' && method === 'GET') {
        sendJSON(res, 200, await listSuites(suitesDir));
        return;
      }
      if (pathname === '/api/suites' && method === 'POST') {
        const body = await readBody(req);
        const data = JSON.parse(body);
        const result = await saveSuite(suitesDir, data);
        sendJSON(res, 200, result);
        return;
      }
      if (pathname.match(/^\/api\/suite\/[^/]+\/duplicate$/) && method === 'POST') {
        const name = decodeURIComponent(pathname.split('/')[3]);
        const result = await duplicateSuite(suitesDir, name);
        sendJSON(res, 200, result);
        return;
      }
      if (pathname.match(/^\/api\/suite\/[^/]+\/run$/) && method === 'POST') {
        const name = decodeURIComponent(pathname.split('/')[3]);
        const userEnv = await resolveUserSecretsEnv(currentUser?.id, teamMode);
        const result = await startSuiteRun(suitesDir, name, activeRuns, suiteRunsDir, reportsDir, currentUser, userEnv);
        if (!result) sendJSON(res, 404, { error: 'Not found' });
        else sendJSON(res, 200, result);
        return;
      }
      if (pathname.match(/^\/api\/suite\/[^/]+$/) && method === 'GET') {
        const name = decodeURIComponent(pathname.split('/')[3]);
        const suite = await getSuite(suitesDir, name);
        if (!suite) sendJSON(res, 404, { error: 'Not found' });
        else sendJSON(res, 200, suite);
        return;
      }
      if (pathname.match(/^\/api\/suite\/[^/]+$/) && method === 'PUT') {
        const name = decodeURIComponent(pathname.split('/')[3]);
        const body = await readBody(req);
        const data = JSON.parse(body);
        const result = await updateSuite(suitesDir, name, data);
        sendJSON(res, 200, result);
        return;
      }
      if (pathname.match(/^\/api\/suite\/[^/]+$/) && method === 'DELETE') {
        const name = decodeURIComponent(pathname.split('/')[3]);
        await deleteSuite(suitesDir, name);
        sendJSON(res, 200, { deleted: true });
        return;
      }

      // ─── ISSUES ────────────────────────────────────────────────────────
      if (pathname === '/api/issues' && method === 'GET') {
        const store = await loadIssueStore();
        sendJSON(res, 200, store.issues || []);
        return;
      }
      if (pathname === '/api/issues/sync' && method === 'POST') {
        // Sync all open issues' status from their trackers
        const result = await syncIssuesStatus();
        sendJSON(res, 200, result);
        return;
      }
      if (pathname.match(/^\/api\/issues\/[^/]+$/) && method === 'PATCH') {
        // Manual status update: { status: 'open' | 'resolved' }
        const id = decodeURIComponent(pathname.split('/')[3]);
        const body = await readBody(req);
        const data = JSON.parse(body);
        const store = await loadIssueStore();
        const issue = store.issues.find(i => i.fingerprint + ':' + i.tracker === id);
        if (!issue) { sendJSON(res, 404, { error: 'Not found' }); return; }
        if (data.status) issue.status = data.status;
        await saveIssueStore(store);
        sendJSON(res, 200, issue);
        return;
      }
      if (pathname.match(/^\/api\/issues\/[^/]+$/) && method === 'DELETE') {
        const id = decodeURIComponent(pathname.split('/')[3]);
        const url = new URL(req.url, `http://localhost:${port}`);
        const closeRemote = url.searchParams.get('closeRemote') === 'true';
        const store = await loadIssueStore();
        const issue = store.issues.find(i => (i.fingerprint + ':' + i.tracker) === id);
        let remoteResult = null;
        if (issue && closeRemote) {
          try {
            await closeRemoteIssue(issue);
            remoteResult = 'closed';
          } catch (err) {
            remoteResult = 'failed: ' + err.message;
          }
        }
        store.issues = store.issues.filter(i => (i.fingerprint + ':' + i.tracker) !== id);
        await saveIssueStore(store);
        sendJSON(res, 200, { deleted: true, remoteResult });
        return;
      }

      // ─── CREDENTIALS ───────────────────────────────────────────────────
      if (pathname === '/api/credentials' && method === 'GET') {
        sendJSON(res, 200, await listCredentials());
        return;
      }
      if (pathname === '/api/credentials' && method === 'POST') {
        const body = await readBody(req);
        const data = JSON.parse(body);
        try {
          await saveCredentialSet(data.name, data.values);
          sendJSON(res, 200, { saved: true });
        } catch (err) {
          sendJSON(res, 400, { error: err.message });
        }
        return;
      }
      if (pathname.match(/^\/api\/credentials\/[^/]+$/) && method === 'GET') {
        const name = decodeURIComponent(pathname.split('/')[3]);
        const values = await getCredentialSet(name);
        if (!values) sendJSON(res, 404, { error: 'Not found' });
        else sendJSON(res, 200, { name, values });
        return;
      }
      if (pathname.match(/^\/api\/credentials\/[^/]+$/) && method === 'PUT') {
        const name = decodeURIComponent(pathname.split('/')[3]);
        const body = await readBody(req);
        const data = JSON.parse(body);
        try {
          await saveCredentialSet(data.name || name, data.values, name);
          sendJSON(res, 200, { saved: true });
        } catch (err) {
          sendJSON(res, 400, { error: err.message });
        }
        return;
      }
      if (pathname.match(/^\/api\/credentials\/[^/]+$/) && method === 'DELETE') {
        const name = decodeURIComponent(pathname.split('/')[3]);
        await deleteCredentialSet(name);
        sendJSON(res, 200, { deleted: true });
        return;
      }

      // ─── SUITE RUNS ────────────────────────────────────────────────────
      if (pathname === '/api/suite-runs' && method === 'GET') {
        sendJSON(res, 200, await listSuiteRuns(suiteRunsDir, reportsDir));
        return;
      }
      if (pathname.startsWith('/api/suite-run/') && method === 'GET') {
        const id = pathname.split('/')[3];
        const data = await getSuiteRun(suiteRunsDir, reportsDir, id);
        if (!data) sendJSON(res, 404, { error: 'Not found' });
        else sendJSON(res, 200, data);
        return;
      }
      if (pathname.startsWith('/api/suite-run/') && method === 'DELETE') {
        const id = pathname.split('/')[3];
        const url = new URL(req.url, `http://localhost:${port}`);
        const cascade = url.searchParams.get('cascade') === 'true';
        await deleteSuiteRun(suiteRunsDir, reportsDir, id, cascade);
        sendJSON(res, 200, { deleted: true });
        return;
      }
      if (pathname === '/api/suite-runs' && method === 'DELETE') {
        await deleteAllSuiteRuns(suiteRunsDir);
        sendJSON(res, 200, { deleted: true });
        return;
      }

      // ─── STATIC FILES ──────────────────────────────────────────────────
      let filePath;
      if (pathname === '/' || pathname === '/index.html') filePath = path.join(webRoot, 'index.html');
      else if (pathname === '/app' || pathname === '/app/' || pathname === '/app/index.html') filePath = path.join(webRoot, 'app', 'index.html');
      else if (pathname === '/setup' || pathname === '/setup/' || pathname === '/setup.html') filePath = path.join(webRoot, 'setup.html');
      else if (pathname === '/login' || pathname === '/login/' || pathname === '/login.html') filePath = path.join(webRoot, 'login.html');
      else if (pathname.startsWith('/invite/')) filePath = path.join(webRoot, 'invite.html');
      else if (pathname.startsWith('/reset/')) filePath = path.join(webRoot, 'reset.html');
      else if (pathname.startsWith('/reports/')) filePath = path.join(reportsDir, pathname.replace('/reports/', ''));
      else filePath = path.join(webRoot, pathname);

      if (filePath && await fs.pathExists(filePath)) {
        const stat = await fs.stat(filePath);
        if (stat.isFile()) {
          const ext = path.extname(filePath);
          const ct = {
            '.html':'text/html','.css':'text/css','.js':'application/javascript',
            '.json':'application/json','.png':'image/png','.jpg':'image/jpeg',
            '.webm':'video/webm','.svg':'image/svg+xml',
          }[ext] || 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': ct });
          fs.createReadStream(filePath).pipe(res);
          return;
        }
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (err) {
      console.error('Server error:', err);
      sendJSON(res, 500, { error: err.message });
    }
  });

  server.listen(port, host, () => {
    const displayHost = (host === '0.0.0.0' || host === '::') ? 'localhost' : host;
    console.log(chalk.cyan('━'.repeat(60)));
    console.log(chalk.white.bold('  Skopix Dashboard'));
    console.log(chalk.cyan('━'.repeat(60)));
    console.log();
    console.log(chalk.green('  ✓ ') + 'Server: ' + chalk.cyan(`http://${displayHost}:${port}`));
    if (host === '0.0.0.0' || host === '::') {
      console.log(chalk.green('  ✓ ') + 'Listening on all interfaces (team mode bind)');
    }
    console.log(chalk.green('  ✓ ') + 'Reports: ' + chalk.cyan(reportsDir));
    console.log(chalk.green('  ✓ ') + 'Suites: ' + chalk.cyan(suitesDir));
    if (teamMode) {
      console.log(chalk.green('  ✓ ') + 'Mode: ' + chalk.cyan('team (multi-user)'));
      console.log(chalk.green('  ✓ ') + 'Database: ' + chalk.cyan(teamMode.db.getDbPath()));
      if (!teamMode.db.hasAnyAdmin()) {
        console.log();
        console.log(chalk.yellow('  ⚠ Setup required: visit ') + chalk.cyan(`http://${displayHost}:${port}/setup`) + chalk.yellow(' to create the first admin'));
      }
    } else {
      console.log(chalk.green('  ✓ ') + 'Mode: ' + chalk.cyan('single-user'));
    }
    console.log();
    console.log(chalk.dim('  Press Ctrl+C to stop'));
    console.log();
    if (!options.noOpen) {
      const openPath = (teamMode && !teamMode.db.hasAnyAdmin()) ? '/setup' : '/app/';
      open(`http://${displayHost}:${port}${openPath}`).catch(() => {});
    }
  });

  process.on('SIGINT', () => { console.log(chalk.yellow('\n  Stopping...')); server.close(); process.exit(0); });
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Parse a single cookie value out of a Cookie header string.
// Returns null if not found. Safe against malformed input.
function parseCookie(cookieHeader, name) {
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    const value = trimmed.slice(eqIdx + 1);
    if (key === name) return decodeURIComponent(value);
  }
  return null;
}

// Resolve the request to a user via the session cookie.
// Returns: { user } if valid session and active user, null otherwise.
// Pass `tm` (the teamMode object) so this works without globals.
function resolveCurrentUser(req, tm) {
  if (!tm) return null;
  const token = parseCookie(req.headers.cookie || '', 'skopix_session');
  if (!token) return null;
  const session = tm.db.getWebSession(token);
  if (!session) return null;
  const user = tm.db.getUserById(session.user_id);
  if (!user || user.status !== 'active') return null;
  // Touch the session so active users don't expire prematurely
  tm.db.touchWebSession(token);
  return { user, sessionToken: token };
}

// Decide whether a request path should bypass auth in team mode.
// Public paths: setup wizard, login flow, status check, static assets.
// Everything else (incl. /app/ JS-loaded API calls) requires a session.
function isPublicPath(pathname) {
  // API routes that don't require auth
  const publicApis = new Set([
    '/api/team/status',
    '/api/setup',
    '/api/auth/login',
    '/api/auth/logout',
    '/api/auth/me', // returns 401 itself, doesn't need to be blocked here
  ]);
  if (publicApis.has(pathname)) return true;
  // Public invite endpoints: GET invite details + accept invite (no auth needed)
  // /api/invites/<token> GET, /api/invites/<token>/accept POST
  if (pathname.match(/^\/api\/invites\/[^/]+$/)) return true;
  if (pathname.match(/^\/api\/invites\/[^/]+\/accept$/)) return true;
  // Password reset (admin-generated link, used by the recipient who isn't logged in)
  if (pathname.match(/^\/api\/password-reset\/[^/]+$/)) return true;
  // Static pages everyone can fetch (the JS inside enforces auth)
  if (pathname === '/' || pathname === '/index.html') return true;
  if (pathname === '/login' || pathname === '/login/' || pathname === '/login.html') return true;
  if (pathname === '/setup' || pathname === '/setup/' || pathname === '/setup.html') return true;
  // Accept invite page - public
  if (pathname.startsWith('/invite/')) return true;
  if (pathname.startsWith('/reset/')) return true;
  // /app/ is NOT in the public list - handled specially in the auth gate (redirects to /login if no session).
  // Static assets used by the pages above (fonts, css, images served from web/)
  // Anything outside /api/ that's a static file should be allowed.
  if (!pathname.startsWith('/api/')) return true;
  return false;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function testIdFromName(name) {
  return slugify(name) || 'test-' + Math.random().toString(36).slice(2, 8);
}

// ─── SESSIONS ─────────────────────────────────────────────────────────────────
async function listSessions(reportsDir) {
  if (!await fs.pathExists(reportsDir)) return [];
  const entries = await fs.readdir(reportsDir);
  const sessions = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const sessionPath = path.join(reportsDir, entry);
    const stat = await fs.stat(sessionPath);
    if (!stat.isDirectory()) continue;
    const jsonPath = path.join(sessionPath, 'report.json');
    if (await fs.pathExists(jsonPath)) {
      try {
        const data = await fs.readJson(jsonPath);
        const status = data.goalAchieved ? 'passed' : data.stuck ? 'stuck' : 'failed';
        // Read run attribution if present (team mode)
        let runBy = null;
        const runByPath = path.join(sessionPath, 'runBy.json');
        if (await fs.pathExists(runByPath)) {
          try { runBy = await fs.readJson(runByPath); } catch {}
        }
        sessions.push({
          id: data.sessionId || entry, status,
          url: data.url, goal: data.goal,
          steps: data.steps?.length || 0,
          issues: data.issues?.length || 0,
          duration: formatDuration(data.duration || 0),
          durationMs: data.duration || 0,
          when: relativeTime(stat.mtime),
          mtime: stat.mtime.toISOString(),
          model: data.model, provider: data.provider,
          runBy, // null in single-user mode or when no attribution recorded
        });
      } catch {}
    }
  }
  sessions.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
  return sessions;
}
async function getSession(reportsDir, id) {
  const jsonPath = path.join(reportsDir, id, 'report.json');
  if (!await fs.pathExists(jsonPath)) return null;
  try {
    const data = await fs.readJson(jsonPath);
    // Attach runBy if present
    const runByPath = path.join(reportsDir, id, 'runBy.json');
    if (await fs.pathExists(runByPath)) {
      try { data.runBy = await fs.readJson(runByPath); } catch {}
    }
    return data;
  } catch { return null; }
}
function computeStats(sessions) {
  const total = sessions.length;
  const passed = sessions.filter(s => s.status === 'passed').length;
  const failed = sessions.filter(s => s.status === 'failed').length;
  const stuck = sessions.filter(s => s.status === 'stuck').length;
  const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;
  const totalIssues = sessions.reduce((sum, s) => sum + (s.issues || 0), 0);
  const avgMs = total > 0 ? sessions.reduce((sum, s) => sum + (s.durationMs || 0), 0) / total : 0;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const thisWeek = sessions.filter(s => new Date(s.mtime).getTime() > weekAgo).length;
  return { total, passed, failed, stuck, passRate, totalIssues, avgDuration: formatDuration(avgMs), avgDurationMs: avgMs, thisWeek };
}
async function getConfig() {
  const envPath = path.resolve(process.cwd(), '.skopix.env');
  if (!await fs.pathExists(envPath)) return [];
  const content = await fs.readFile(envPath, 'utf-8');
  const config = [];
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const value = t.slice(eq + 1).trim();
    const isSecret = key.includes('KEY') || key.includes('TOKEN') || key.includes('PASSWORD');
    config.push({ key, value: isSecret ? value.slice(0, 6) + '••••••••••••••' : value, isSecret });
  }
  return config;
}

// ─── SUITES ───────────────────────────────────────────────────────────────────
async function listSuites(suitesDir) {
  const files = await fs.readdir(suitesDir);
  const suiteFiles = files.filter(f => (f.endsWith('.suite.yaml') || f.endsWith('.suite.yml')) && f !== SAVED_TESTS_FILE);
  const suites = [];
  for (const file of suiteFiles) {
    try {
      const content = await fs.readFile(path.join(suitesDir, file), 'utf-8');
      const data = yaml.parse(content);
      const stat = await fs.stat(path.join(suitesDir, file));
      suites.push({
        filename: file,
        name: data.name || file,
        description: data.description || '',
        testCount: data.tests?.length || 0,
        defaults: data.defaults || {},
        tags: collectTags(data.tests),
        modified: stat.mtime.toISOString(),
        modifiedRelative: relativeTime(stat.mtime),
      });
    } catch {}
  }
  return suites;
}
function collectTags(tests) {
  if (!tests) return [];
  const set = new Set();
  tests.forEach(t => (t.tags || []).forEach(tag => set.add(tag)));
  return Array.from(set);
}
async function getSuite(suitesDir, filename) {
  const filePath = path.join(suitesDir, filename);
  if (!await fs.pathExists(filePath)) return null;
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return { filename, ...yaml.parse(content) };
  } catch { return null; }
}
function suiteFileName(name) { return slugify(name) + '.suite.yaml'; }
async function saveSuite(suitesDir, data) {
  const filename = suiteFileName(data.name || 'untitled');
  const filePath = path.join(suitesDir, filename);
  const suite = {
    name: data.name || 'Untitled Suite',
    description: data.description || '',
    defaults: data.defaults || {},
    waitBetweenTests: data.waitBetweenTests || 2000,
    tests: data.tests || [],
  };
  if (data.parallel && data.parallel > 1) suite.parallel = data.parallel;
  await fs.writeFile(filePath, yaml.stringify(suite));
  return { filename, ...suite };
}
async function updateSuite(suitesDir, filename, data) {
  const filePath = path.join(suitesDir, filename);
  const suite = {
    name: data.name || 'Untitled Suite',
    description: data.description || '',
    defaults: data.defaults || {},
    waitBetweenTests: data.waitBetweenTests || 2000,
    tests: data.tests || [],
  };
  if (data.parallel && data.parallel > 1) suite.parallel = data.parallel;
  await fs.writeFile(filePath, yaml.stringify(suite));
  return { filename, ...suite };
}
async function duplicateSuite(suitesDir, filename) {
  const filePath = path.join(suitesDir, filename);
  if (!await fs.pathExists(filePath)) return null;
  const content = await fs.readFile(filePath, 'utf-8');
  const data = yaml.parse(content);
  data.name = (data.name || 'Suite') + ' (copy)';
  return await saveSuite(suitesDir, data);
}
async function deleteSuite(suitesDir, filename) {
  const filePath = path.join(suitesDir, filename);
  if (await fs.pathExists(filePath)) await fs.remove(filePath);
}

// ─── TESTS (across all scopes) ────────────────────────────────────────────────
function scopeToFilename(scope) {
  if (scope === 'saved') return SAVED_TESTS_FILE;
  return scope; // already a filename like "smoke.suite.yaml"
}
function filenameToScope(filename) {
  if (filename === SAVED_TESTS_FILE) return 'saved';
  return filename;
}

async function readSuiteFile(suitesDir, filename) {
  const filePath = path.join(suitesDir, filename);
  if (!await fs.pathExists(filePath)) return null;
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return yaml.parse(content);
  } catch { return null; }
}
async function writeSuiteFile(suitesDir, filename, data) {
  const filePath = path.join(suitesDir, filename);
  await fs.writeFile(filePath, yaml.stringify(data));
}
async function ensureSavedTestsFile(suitesDir) {
  const fp = path.join(suitesDir, SAVED_TESTS_FILE);
  if (!await fs.pathExists(fp)) {
    await fs.writeFile(fp, yaml.stringify({
      name: 'Saved Tests',
      description: 'Standalone tests not in any suite',
      tests: [],
    }));
  }
}

async function listAllTests(suitesDir) {
  const files = await fs.readdir(suitesDir);
  const suiteFiles = files.filter(f => f.endsWith('.suite.yaml') || f.endsWith('.suite.yml'));
  const allTests = [];

  for (const file of suiteFiles) {
    const data = await readSuiteFile(suitesDir, file);
    if (!data) continue;
    const scope = filenameToScope(file);
    const scopeName = file === SAVED_TESTS_FILE ? 'Saved tests' : (data.name || file);

    for (const test of (data.tests || [])) {
      const id = test.id || testIdFromName(test.name);
      allTests.push({
        id,
        scope,
        scopeName,
        scopeIsSaved: scope === 'saved',
        name: test.name || 'Untitled',
        url: test.url,
        goal: test.goal,
        maxSteps: test.maxSteps,
        tags: test.tags || [],
        provider: test.provider,
        model: test.model,
        credentials: test.credentials || '',
      });
    }
  }
  return allTests;
}

async function getTest(suitesDir, scope, testId) {
  const filename = scopeToFilename(scope);
  const data = await readSuiteFile(suitesDir, filename);
  if (!data || !data.tests) return null;
  const test = data.tests.find(t => (t.id || testIdFromName(t.name)) === testId);
  if (!test) return null;
  return { ...test, id: test.id || testIdFromName(test.name), scope };
}

async function createTest(suitesDir, scope, testData) {
  const filename = scopeToFilename(scope);
  if (scope === 'saved') await ensureSavedTestsFile(suitesDir);
  const data = await readSuiteFile(suitesDir, filename);
  if (!data) throw new Error('Scope not found: ' + scope);

  data.tests = data.tests || [];

  const id = testIdFromName(testData.name);

  // Check uniqueness within scope
  if (data.tests.some(t => (t.id || testIdFromName(t.name)) === id)) {
    throw new Error(`A test named "${testData.name}" already exists in this scope`);
  }

  const newTest = { id, ...cleanTest(testData) };
  data.tests.push(newTest);
  await writeSuiteFile(suitesDir, filename, data);
  return { ...newTest, scope };
}

async function updateTest(suitesDir, scope, testId, testData) {
  const filename = scopeToFilename(scope);
  const data = await readSuiteFile(suitesDir, filename);
  if (!data || !data.tests) throw new Error('Test not found');

  const idx = data.tests.findIndex(t => (t.id || testIdFromName(t.name)) === testId);
  if (idx === -1) throw new Error('Test not found');

  // If renaming, check the new name doesn't collide with a different test
  const newId = testIdFromName(testData.name);
  if (newId !== testId && data.tests.some((t, i) => i !== idx && (t.id || testIdFromName(t.name)) === newId)) {
    throw new Error(`A test named "${testData.name}" already exists in this scope`);
  }

  data.tests[idx] = { id: newId, ...cleanTest(testData) };
  await writeSuiteFile(suitesDir, filename, data);
  return { ...data.tests[idx], scope };
}

async function deleteTest(suitesDir, scope, testId) {
  const filename = scopeToFilename(scope);
  const data = await readSuiteFile(suitesDir, filename);
  if (!data || !data.tests) return;
  data.tests = data.tests.filter(t => (t.id || testIdFromName(t.name)) !== testId);
  await writeSuiteFile(suitesDir, filename, data);
}

async function duplicateTest(suitesDir, scope, testId) {
  const test = await getTest(suitesDir, scope, testId);
  if (!test) return null;

  // Strip the id and scope from the source test, copy everything else
  const { scope: _scope, id: _id, ...testData } = test;

  // Build a unique copy name: "Login test" -> "Login test (copy)", "Login test (copy 2)", etc.
  const filename = scopeToFilename(scope);
  const data = await readSuiteFile(suitesDir, filename);
  const existingNames = new Set((data?.tests || []).map(t => t.name));
  const baseName = (testData.name || 'Test').replace(/\s*\(copy(?:\s+\d+)?\)\s*$/i, '');
  let newName = baseName + ' (copy)';
  let copyNum = 2;
  while (existingNames.has(newName)) {
    newName = baseName + ' (copy ' + copyNum + ')';
    copyNum++;
  }
  testData.name = newName;

  return await createTest(suitesDir, scope, testData);
}

async function moveTest(suitesDir, fromScope, testId, toScope) {
  if (fromScope === toScope) return { moved: false };
  const test = await getTest(suitesDir, fromScope, testId);
  if (!test) throw new Error('Test not found');

  // Strip the scope from test before adding
  const { scope: _omit, id: _id, ...testData } = test;

  // Will throw if duplicate name in target scope
  const created = await createTest(suitesDir, toScope, testData);
  await deleteTest(suitesDir, fromScope, testId);
  return { moved: true, newScope: toScope, test: created };
}

function cleanTest(t) {
  const out = { name: t.name, goal: t.goal };
  if (t.url) out.url = t.url;
  if (t.maxSteps) out.maxSteps = t.maxSteps;
  if (t.tags && t.tags.length > 0) out.tags = t.tags;
  if (t.provider) out.provider = t.provider;
  if (t.model) out.model = t.model;
  if (t.credentials) out.credentials = t.credentials;
  if (t.github) out.github = true;
  if (t.jira) out.jira = true;
  if (t.linear) out.linear = true;
  if (t.headless) out.headless = true;
  return out;
}

// ─── SUITE RUNS ───────────────────────────────────────────────────────────────
async function listSuiteRuns(suiteRunsDir, reportsDir) {
  if (!await fs.pathExists(suiteRunsDir)) return [];
  const files = await fs.readdir(suiteRunsDir);
  const runs = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = await fs.readJson(path.join(suiteRunsDir, file));
      const stat = await fs.stat(path.join(suiteRunsDir, file));
      runs.push({
        ...data,
        when: relativeTime(stat.mtime),
        mtime: stat.mtime.toISOString(),
      });
    } catch {}
  }
  runs.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
  return runs;
}

async function getSuiteRun(suiteRunsDir, reportsDir, id) {
  const filePath = path.join(suiteRunsDir, id + '.json');
  if (!await fs.pathExists(filePath)) return null;
  const data = await fs.readJson(filePath);

  // Resolve session details for each test
  const enrichedResults = [];
  for (const result of (data.results || [])) {
    if (result.sessionId) {
      const session = await getSession(reportsDir, result.sessionId);
      if (session) {
        const status = session.goalAchieved ? 'passed' : session.stuck ? 'stuck' : 'failed';
        enrichedResults.push({
          ...result,
          status,
          duration: formatDuration(session.duration || 0),
          steps: session.steps?.length || 0,
          issues: session.issues?.length || 0,
        });
        continue;
      }
    }
    enrichedResults.push(result);
  }
  return { ...data, results: enrichedResults };
}

async function startSuiteRun(suitesDir, filename, activeRuns, suiteRunsDir, reportsDir, currentUser, userEnv) {
  const runBy = currentUser ? {
    id: currentUser.id, name: currentUser.name,
    email: currentUser.email, role: currentUser.role,
  } : null;
  const suite = await getSuite(suitesDir, filename);
  if (!suite || !suite.tests || suite.tests.length === 0) return null;

  const runId = Math.random().toString(36).slice(2, 10);
  const startedAt = new Date().toISOString();
  const run = {
    id: runId, type: 'suite',
    suiteName: suite.name, suiteFilename: filename,
    status: 'running', output: [], listeners: [],
    sessionIds: [], testResults: [], startedAt,
  };
  activeRuns.set(runId, run);

  const broadcast = (line) => {
    run.output.push(line);
    run.listeners.forEach(l => l(line));
  };

  (async () => {
    // Determine concurrency: from suite.parallel (default 1 for backwards compat)
    const parallel = Math.max(1, Math.min(5, suite.parallel || suite.defaults?.parallel || 1));
    const isParallel = parallel > 1;

    broadcast({ type: 'stdout', text: `\n━━━ Suite: ${suite.name} ━━━` });
    broadcast({ type: 'stdout', text: `${suite.tests.length} test(s) to run${isParallel ? ` (running ${parallel} in parallel)` : ''}\n` });

    let completedCount = 0;
    let runningCount = 0;

    // Pre-resolve test configs (skip invalid ones up front)
    const testTasks = suite.tests.map((test, i) => ({
      index: i,
      test,
      config: {
        url: test.url || suite.defaults?.url,
        goal: test.goal,
        credentials: test.credentials || suite.defaults?.credentials,
        maxSteps: test.maxSteps || suite.defaults?.maxSteps || 20,
        provider: test.provider || suite.defaults?.provider || 'gemini',
        model: test.model || suite.defaults?.model,
        github: test.github !== undefined ? test.github : suite.defaults?.github,
        jira: test.jira !== undefined ? test.jira : suite.defaults?.jira,
        linear: test.linear !== undefined ? test.linear : suite.defaults?.linear,
        headless: test.headless !== undefined ? test.headless : suite.defaults?.headless,
        testName: test.name,
        suiteName: suite.name,
      },
    }));

    // Build a per-test broadcast that tags lines with [T<n>] in parallel mode
    const taggedBroadcast = (workerNum) => (line) => {
      if (isParallel && (line.type === 'stdout' || line.type === 'stderr')) {
        broadcast({ ...line, text: `[T${workerNum}] ${line.text}` });
      } else if (line.type === 'sessionId') {
        // Pass session IDs through directly so the dashboard can pick them up
        broadcast(line);
      } else if (line.type !== 'done' && line.type !== 'suiteProgress') {
        // Non-stdout (e.g. status updates) we just pass along
        broadcast(line);
      }
    };

    // Execute a single test task
    const runOne = async (task, workerNum) => {
      const t = task.test;
      runningCount++;
      broadcast({ type: 'suiteProgress', current: completedCount + 1, total: suite.tests.length, testName: t.name, runningCount });
      const header = `\n━━━ Test ${task.index + 1}/${suite.tests.length}${isParallel ? ` [worker T${workerNum}]` : ''}: ${t.name} ━━━`;
      broadcast({ type: 'stdout', text: header });

      if (!task.config.url || !task.config.goal) {
        broadcast({ type: 'stdout', text: `[SKIP] Test "${t.name}" has no url or goal` });
        run.testResults.push({ name: t.name, testId: t.id || testIdFromName(t.name), status: 'skipped' });
        runningCount--;
        completedCount++;
        return;
      }

      const result = await runSingleTestSync(task.config, isParallel ? taggedBroadcast(workerNum) : broadcast, userEnv, reportsDir, runBy);
      run.testResults.push({
        name: t.name,
        testId: t.id || testIdFromName(t.name),
        status: result.status,
        sessionId: result.sessionId,
      });
      if (result.sessionId) run.sessionIds.push(result.sessionId);
      runningCount--;
      completedCount++;
      broadcast({ type: 'suiteProgress', current: completedCount, total: suite.tests.length, testName: t.name, runningCount });
    };

    // Pool execution: keep up to N workers busy at all times
    let nextIdx = 0;
    const workers = [];
    for (let w = 1; w <= parallel; w++) {
      workers.push((async () => {
        while (nextIdx < testTasks.length) {
          const task = testTasks[nextIdx++];
          await runOne(task, w);
          // Wait between tests on this worker (sequential or parallel)
          if (nextIdx < testTasks.length) {
            const wait = suite.waitBetweenTests || (isParallel ? 500 : 2000);
            await new Promise(r => setTimeout(r, wait));
          }
        }
      })());
    }
    await Promise.all(workers);

    const passed = run.testResults.filter(r => r.status === 'passed').length;
    const failed = run.testResults.filter(r => r.status !== 'passed' && r.status !== 'skipped').length;
    run.status = failed === 0 ? 'passed' : 'failed';

    // Persist the suite run record
    const record = {
      id: runId,
      suiteName: suite.name,
      suiteFilename: filename,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: run.status,
      passed,
      failed,
      total: run.testResults.length,
      results: run.testResults,
    };
    try {
      await fs.writeJson(path.join(suiteRunsDir, runId + '.json'), record, { spaces: 2 });
    } catch (err) {
      console.error('Failed to write suite run record:', err);
    }

    broadcast({ type: 'stdout', text: '\n━━━ Suite Complete ━━━' });
    broadcast({ type: 'stdout', text: `${passed} passed, ${failed} failed of ${run.testResults.length}` });
    broadcast({ type: 'done', status: run.status, results: run.testResults, suiteRunId: runId });

    setTimeout(() => activeRuns.delete(runId), 60000);
  })();

  return { runId };
}

async function resolveCredsToFile(credRef) {
  if (!credRef) return null;
  // Already a file path? use as-is
  if (credRef.includes('/') || credRef.endsWith('.yaml') || credRef.endsWith('.yml')) {
    if (await fs.pathExists(credRef)) return credRef;
  }
  // Look up by name in vault, write to temp file
  const data = await loadCredentialsFile();
  if (!data[credRef]) return null;
  const tmpPath = path.join(os.tmpdir(), `skopix-creds-${Date.now()}-${Math.random().toString(36).slice(2,6)}.yaml`);
  // CLI expects format:
  //   credentials:
  //     - label: "Main account"
  //       fields:
  //         username: ...
  //         password: ...
  const fileFormat = {
    credentials: [
      { label: credRef, fields: data[credRef] }
    ]
  };
  await fs.writeFile(tmpPath, yaml.stringify(fileFormat));
  // Cleanup after 60s
  setTimeout(() => fs.remove(tmpPath).catch(() => {}), 60000);
  return tmpPath;
}

function runSingleTestSync(config, broadcast, userEnv, reportsDir, runBy) {
  return new Promise(async (resolve) => {
    const args = ['run', '--url', config.url, '--goal', config.goal];
    const credsFile = await resolveCredsToFile(config.credentials);
    if (credsFile) args.push('--credentials', credsFile);
    if (config.maxSteps) args.push('--max-steps', String(config.maxSteps));
    if (config.provider) args.push('--provider', config.provider);
    if (config.model) args.push('--model', config.model);
    if (config.github) args.push('--github');
    if (config.jira) args.push('--jira');
    if (config.linear) args.push('--linear');
    if (config.headless) args.push('--headless');
    if (config.testName) args.push('--test-name', config.testName);
    if (config.suiteName) args.push('--suite-name', config.suiteName);

    const cliPath = path.resolve(__dirname, '..', 'index.js');
    const childEnv = { ...process.env, ...(userEnv || {}) };
    const child = spawn('node', [cliPath, ...args], { cwd: process.cwd(), env: childEnv });
    let sessionId = null;

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      text.split('\n').forEach(line => { if (line.length > 0) broadcast({ type: 'stdout', text: line }); });
      const m = text.match(/Session:\s+([a-f0-9]{8})/);
      if (m && !sessionId) {
        sessionId = m[1];
        // Persist run attribution (for suite tests, mirrors what startRun does for single tests)
        if (runBy && reportsDir) {
          const sessionDir = path.join(reportsDir, sessionId);
          fs.ensureDir(sessionDir).then(() => {
            return fs.writeJson(path.join(sessionDir, 'runBy.json'), runBy, { spaces: 2 });
          }).catch(() => {});
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      chunk.toString().split('\n').forEach(line => { if (line.length > 0) broadcast({ type: 'stderr', text: line }); });
    });
    child.on('close', (code) => resolve({ status: code === 0 ? 'passed' : 'failed', sessionId }));
    child.on('error', (err) => {
      broadcast({ type: 'stderr', text: 'Error: ' + err.message });
      resolve({ status: 'error', sessionId });
    });
  });
}

function startRun(config, activeRuns, reportsDir, currentUser, userEnv) {
  const runId = Math.random().toString(36).slice(2, 10);
  const run = { id: runId, type: 'single', status: 'running', output: [], listeners: [], sessionId: null };
  activeRuns.set(runId, run);

  // Build the env for the child process. User-specific secrets (if any) override
  // workspace defaults from .skopix.env which the child loads via dotenv.
  // process.env wins over .skopix.env (dotenv doesn't overwrite existing vars),
  // and userEnv wins over process.env (last spread wins).
  const childEnv = { ...process.env, ...(userEnv || {}) };

  const broadcast = (line) => { run.output.push(line); run.listeners.forEach(l => l(line)); };

  // Run attribution - records who triggered this run.
  // Written as a small companion file alongside the session.
  const runBy = currentUser ? {
    id: currentUser.id,
    name: currentUser.name,
    email: currentUser.email,
    role: currentUser.role,
  } : null;

  // Async credential resolve - kick off the spawn after we have the creds file
  (async () => {
    const args = ['run', '--url', config.url, '--goal', config.goal];
    const credsFile = await resolveCredsToFile(config.credentials);
    if (credsFile) args.push('--credentials', credsFile);
  if (config.maxSteps) args.push('--max-steps', String(config.maxSteps));
  if (config.provider) args.push('--provider', config.provider);
  if (config.model) args.push('--model', config.model);
  if (config.headless) args.push('--headless');
  if (config.github) args.push('--github');
  if (config.jira) args.push('--jira');
  if (config.linear) args.push('--linear');
  if (config.testName) args.push('--test-name', config.testName);
  if (config.suiteName) args.push('--suite-name', config.suiteName);

    const cliPath = path.resolve(__dirname, '..', 'index.js');
    const child = spawn('node', [cliPath, ...args], { cwd: process.cwd(), env: childEnv });

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      text.split('\n').forEach(line => { if (line.length > 0) broadcast({ type: 'stdout', text: line }); });
      const m = text.match(/Session:\s+([a-f0-9]{8})/);
      if (m && !run.sessionId) {
        run.sessionId = m[1];
        broadcast({ type: 'sessionId', sessionId: m[1] });
        // Persist run attribution
        if (runBy && reportsDir) {
          const sessionDir = path.join(reportsDir, run.sessionId);
          fs.ensureDir(sessionDir).then(() => {
            return fs.writeJson(path.join(sessionDir, 'runBy.json'), runBy, { spaces: 2 });
          }).catch(() => {});
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      chunk.toString().split('\n').forEach(line => { if (line.length > 0) broadcast({ type: 'stderr', text: line }); });
    });
    child.on('close', (code) => {
      run.status = code === 0 ? 'passed' : 'failed';
      broadcast({ type: 'done', exitCode: code, status: run.status });
      setTimeout(() => activeRuns.delete(runId), 60000);
    });
    child.on('error', (err) => { broadcast({ type: 'error', error: err.message }); run.status = 'error'; });
  })();

  return runId;
}

function streamRun(req, res, runId, activeRuns) {
  const run = activeRuns.get(runId);
  if (!run) { sendJSON(res, 404, { error: 'Run not found' }); return; }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  run.output.forEach(line => res.write(`data: ${JSON.stringify(line)}\n\n`));
  if (run.status !== 'running') {
    res.write(`data: ${JSON.stringify({ type: 'done', status: run.status })}\n\n`);
    res.end();
    return;
  }
  const listener = (line) => {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
    if (line.type === 'done') res.end();
  };
  run.listeners.push(listener);
  req.on('close', () => { run.listeners = run.listeners.filter(l => l !== listener); });
}

function formatDuration(ms) {
  if (!ms || ms < 1000) return `${ms || 0}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}
function relativeTime(date) {
  const now = Date.now();
  const then = new Date(date).getTime();
  const diff = (now - then) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} mins ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(date).toLocaleDateString();
}


// ─── CREDENTIALS ──────────────────────────────────────────────────────────────
const CREDENTIALS_PATH = path.join(os.homedir(), '.skopix', 'credentials.yaml');

async function loadCredentialsFile() {
  try {
    if (!await fs.pathExists(CREDENTIALS_PATH)) return {};
    const content = await fs.readFile(CREDENTIALS_PATH, 'utf-8');
    return yaml.parse(content) || {};
  } catch (err) {
    console.error('Failed to read credentials file:', err);
    return {};
  }
}

async function writeCredentialsFile(data) {
  await fs.ensureDir(path.dirname(CREDENTIALS_PATH));
  await fs.writeFile(CREDENTIALS_PATH, yaml.stringify(data));
  // Set restrictive permissions on Unix
  try { await fs.chmod(CREDENTIALS_PATH, 0o600); } catch {}
}

async function listCredentials() {
  const data = await loadCredentialsFile();
  // Return masked - just names + key list, never values
  return Object.entries(data).map(([name, values]) => ({
    name,
    keys: Object.keys(values || {}),
    keyCount: Object.keys(values || {}).length,
  }));
}

async function getCredentialSet(name) {
  const data = await loadCredentialsFile();
  if (!data[name]) return null;
  // Mask values: return key + length-aware mask
  const masked = {};
  for (const [k, v] of Object.entries(data[name])) {
    masked[k] = String(v).slice(0, 2) + '••••••••';
  }
  return masked;
}

async function saveCredentialSet(name, values, oldName) {
  if (!name || !name.trim()) throw new Error('Credential set name is required');
  if (!values || typeof values !== 'object') throw new Error('Values must be an object');
  const cleanName = name.trim();
  // Reject names with whitespace or weird chars - keep keys clean
  if (!/^[a-z0-9_-]+$/i.test(cleanName)) throw new Error('Name can only contain letters, numbers, dashes and underscores');

  const data = await loadCredentialsFile();
  if (oldName && oldName !== cleanName) {
    // Renaming - remove old entry
    delete data[oldName];
  }
  // Filter out empty keys/values - merge with existing if values are placeholder masks
  const existing = data[cleanName] || {};
  const cleaned = {};
  for (const [k, v] of Object.entries(values)) {
    if (!k || !k.trim()) continue;
    const trimKey = k.trim();
    // If value looks like a mask (contains ••), keep the existing value
    if (typeof v === 'string' && v.includes('•') && existing[trimKey]) {
      cleaned[trimKey] = existing[trimKey];
    } else {
      cleaned[trimKey] = v;
    }
  }
  data[cleanName] = cleaned;
  await writeCredentialsFile(data);
}

async function deleteCredentialSet(name) {
  const data = await loadCredentialsFile();
  delete data[name];
  await writeCredentialsFile(data);
}

// Resolve a credential reference to actual values (used during test execution)
async function resolveCredentials(ref) {
  if (!ref) return null;
  // If it's a path that exists as a file, treat as old-style yaml file
  if (ref.includes('/') || ref.endsWith('.yaml') || ref.endsWith('.yml')) {
    if (await fs.pathExists(ref)) {
      try {
        const content = await fs.readFile(ref, 'utf-8');
        return yaml.parse(content);
      } catch { return null; }
    }
  }
  // Otherwise look up by name in the vault
  const data = await loadCredentialsFile();
  return data[ref] || null;
}


async function deleteSession(reportsDir, id) {
  const sessionPath = path.join(reportsDir, id);
  if (await fs.pathExists(sessionPath)) {
    await fs.remove(sessionPath);
  }
}

async function deleteAllSessions(reportsDir) {
  if (!await fs.pathExists(reportsDir)) return;
  const entries = await fs.readdir(reportsDir);
  for (const entry of entries) {
    if (entry.startsWith('.')) continue; // preserve .suite-runs/
    const p = path.join(reportsDir, entry);
    const stat = await fs.stat(p);
    if (stat.isDirectory()) await fs.remove(p);
  }
}

async function deleteSuiteRun(suiteRunsDir, reportsDir, id, cascade) {
  const filePath = path.join(suiteRunsDir, id + '.json');
  let sessionIds = [];
  if (cascade && await fs.pathExists(filePath)) {
    try {
      const data = await fs.readJson(filePath);
      sessionIds = (data.results || []).map(r => r.sessionId).filter(Boolean);
    } catch {}
  }
  if (await fs.pathExists(filePath)) await fs.remove(filePath);
  if (cascade) {
    for (const sid of sessionIds) {
      await deleteSession(reportsDir, sid);
    }
  }
}

async function deleteAllSuiteRuns(suiteRunsDir) {
  if (!await fs.pathExists(suiteRunsDir)) return;
  const files = await fs.readdir(suiteRunsDir);
  for (const f of files) {
    if (f.endsWith('.json')) await fs.remove(path.join(suiteRunsDir, f));
  }
}


async function closeRemoteIssue(issue) {
  const axios = (await import('axios')).default;
  const dotenv = (await import('dotenv')).default;
  dotenv.config({ path: path.resolve(process.cwd(), '.skopix.env') });
  dotenv.config();

  if (issue.tracker === 'github') {
    const { GITHUB_TOKEN, GITHUB_REPO } = process.env;
    if (!GITHUB_TOKEN || !GITHUB_REPO) throw new Error('GitHub env vars not set');
    await axios.patch(
      `https://api.github.com/repos/${GITHUB_REPO}/issues/${issue.trackerRef}`,
      { state: 'closed', state_reason: 'completed' },
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
    );
  } else if (issue.tracker === 'jira') {
    const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
    if (!JIRA_BASE_URL) throw new Error('Jira env vars not set');
    // Jira needs a transition - find the "Done" transition for this issue
    const transRes = await axios.get(
      `${JIRA_BASE_URL}/rest/api/3/issue/${issue.trackerRef}/transitions`,
      { auth: { username: JIRA_EMAIL, password: JIRA_API_TOKEN } }
    );
    const doneTransition = (transRes.data.transitions || []).find(t =>
      t.to?.statusCategory?.key === 'done' || /done|closed|resolved/i.test(t.name)
    );
    if (!doneTransition) throw new Error('No done transition available');
    await axios.post(
      `${JIRA_BASE_URL}/rest/api/3/issue/${issue.trackerRef}/transitions`,
      { transition: { id: doneTransition.id } },
      { auth: { username: JIRA_EMAIL, password: JIRA_API_TOKEN } }
    );
  } else if (issue.tracker === 'linear') {
    const { LINEAR_API_KEY, LINEAR_TEAM_ID } = process.env;
    if (!LINEAR_API_KEY) throw new Error('Linear env vars not set');
    // Find a completed state on this team
    const stateQuery = `query States($teamId: String!) { team(id: $teamId) { states { nodes { id type } } } }`;
    const stateRes = await axios.post(
      'https://api.linear.app/graphql',
      { query: stateQuery, variables: { teamId: LINEAR_TEAM_ID } },
      { headers: { Authorization: LINEAR_API_KEY } }
    );
    const states = stateRes.data.data?.team?.states?.nodes || [];
    const doneState = states.find(s => s.type === 'completed');
    if (!doneState) throw new Error('No completed state available');
    const updateQuery = `mutation UpdateIssue($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`;
    await axios.post(
      'https://api.linear.app/graphql',
      { query: updateQuery, variables: { id: issue.trackerRef, stateId: doneState.id } },
      { headers: { Authorization: LINEAR_API_KEY } }
    );
  } else {
    throw new Error('Unknown tracker: ' + issue.tracker);
  }
}

// Build an env-var dictionary from a user's stored secrets (team mode only).
// Returns {} in single-user mode or if user has no secrets.
// GOOGLE_API_KEY <- GEMINI_API_KEY, ANTHROPIC_API_KEY <- CLAUDE_API_KEY (provide both aliases).
async function resolveUserSecretsEnv(userId, teamMode) {
  if (!teamMode || !userId) return {};
  const keys = teamMode.db.getUserSecretKeys(userId);
  if (!keys.length) return {};
  const env = {};
  for (const { key } of keys) {
    const encrypted = teamMode.db.getUserSecret(userId, key);
    if (!encrypted) continue;
    try {
      const value = teamMode.auth.decryptSecret(encrypted);
      env[key] = value;
      // Provide common aliases so users don't have to set both
      if (key === 'GEMINI_API_KEY' && !env.GOOGLE_API_KEY) env.GOOGLE_API_KEY = value;
      if (key === 'GOOGLE_API_KEY' && !env.GEMINI_API_KEY) env.GEMINI_API_KEY = value;
      if (key === 'CLAUDE_API_KEY' && !env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = value;
      if (key === 'ANTHROPIC_API_KEY' && !env.CLAUDE_API_KEY) env.CLAUDE_API_KEY = value;
    } catch (err) {
      // Decryption failed - log and skip. Could happen if SKOPIX_SECRET_KEY changed since the value was encrypted.
      console.error(`Failed to decrypt secret ${key} for user ${userId}: ${err.message}`);
    }
  }
  return env;
}

async function syncIssuesStatus() {
  const axios = (await import('axios')).default;
  const dotenv = (await import('dotenv')).default;
  dotenv.config({ path: path.resolve(process.cwd(), '.skopix.env') });
  dotenv.config();

  const store = await loadIssueStore();
  let updated = 0;
  let failed = 0;

  for (const issue of store.issues) {
    if (issue.status !== 'open') continue;
    try {
      let liveStatus = null;
      if (issue.tracker === 'github') {
        const { GITHUB_TOKEN, GITHUB_REPO } = process.env;
        if (!GITHUB_TOKEN || !GITHUB_REPO) continue;
        const r = await axios.get(
          `https://api.github.com/repos/${GITHUB_REPO}/issues/${issue.trackerRef}`,
          { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
        );
        liveStatus = r.data.state === 'closed' ? 'resolved' : 'open';
      } else if (issue.tracker === 'jira') {
        const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
        if (!JIRA_BASE_URL) continue;
        const r = await axios.get(
          `${JIRA_BASE_URL}/rest/api/3/issue/${issue.trackerRef}?fields=status`,
          { auth: { username: JIRA_EMAIL, password: JIRA_API_TOKEN } }
        );
        const cat = r.data.fields?.status?.statusCategory?.key;
        liveStatus = cat === 'done' ? 'resolved' : 'open';
      } else if (issue.tracker === 'linear') {
        const { LINEAR_API_KEY } = process.env;
        if (!LINEAR_API_KEY) continue;
        const query = `query GetIssue($id: String!) { issue(id: $id) { state { type } } }`;
        const r = await axios.post(
          'https://api.linear.app/graphql',
          { query, variables: { id: issue.trackerRef } },
          { headers: { Authorization: LINEAR_API_KEY } }
        );
        const t = r.data.data?.issue?.state?.type;
        liveStatus = (t === 'completed' || t === 'canceled') ? 'resolved' : 'open';
      }
      if (liveStatus && liveStatus !== issue.status) {
        issue.status = liveStatus;
        updated++;
      }
    } catch {
      failed++;
    }
  }

  await saveIssueStore(store);
  return { updated, failed, total: store.issues.length };
}
