// Authentication & role-based access for the Spares Ledger
const bcrypt = require('bcryptjs');
const cookieSession = require('cookie-session');

function setupAuth(app, db) {
  const secret = db.prepare("SELECT value FROM app_meta WHERE key='session_secret'").get().value;
  const prod = process.env.NODE_ENV === 'production';
  if (prod) app.set('trust proxy', 1);      // behind Caddy/Nginx
  app.use(cookieSession({
    name: 'spares_sess', keys: [secret],
    maxAge: 12 * 60 * 60 * 1000,            // 12h
    httpOnly: true, sameSite: 'lax',
    secure: prod,                            // HTTPS-only cookies in production
  }));

  // Bootstrap: if no users exist, create default admin (must change password)
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n === 0) {
    db.prepare(`INSERT INTO users (username, display_name, pw_hash, role)
                VALUES ('admin','Administrator',?, 'admin')`)
      .run(bcrypt.hashSync('ChangeMe123!', 10));
    console.log('Created default admin (username: admin, password: ChangeMe123!) — change it after first login.');
  }

  app.use((req, res, next) => {
    if (req.session && req.session.uid) {
      req.user = db.prepare('SELECT user_id, username, display_name, role, hd_code FROM users WHERE user_id=? AND active=1')
                   .get(req.session.uid);
    }
    next();
  });

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(String(username || '').trim());
    if (!u || !bcrypt.compareSync(String(password || ''), u.pw_hash)) {
      return res.status(401).json({ error: 'Wrong username or password.' });
    }
    req.session.uid = u.user_id;
    res.json({ ok: true, role: u.role });
  });

  app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });

  app.get('/api/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'not signed in' });
    const { username, display_name, role, hd_code } = req.user;
    res.json({ username, display_name, role, hd_code });
  });

  app.post('/api/change-password', requireAuth, (req, res) => {
    const { current, next: nextPw } = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE user_id=?').get(req.user.user_id);
    if (!bcrypt.compareSync(String(current || ''), u.pw_hash))
      return res.status(400).json({ error: 'Current password is wrong.' });
    if (!nextPw || String(nextPw).length < 8)
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    db.prepare('UPDATE users SET pw_hash=? WHERE user_id=?').run(bcrypt.hashSync(String(nextPw), 10), u.user_id);
    res.json({ ok: true });
  });

  // ---- admin: user management ----
  app.get('/api/admin/users', requireRole('admin'), (req, res) => {
    res.json(db.prepare('SELECT user_id, username, display_name, role, hd_code, active, created_at FROM users ORDER BY username').all());
  });
  app.post('/api/admin/users', requireRole('admin'), (req, res) => {
    const { username, display_name, password, role, hd_code } = req.body || {};
    if (!username || !password || !['admin', 'viewer', 'plant'].includes(role))
      return res.status(400).json({ error: 'username, password and a valid role are required.' });
    if (role === 'plant' && !hd_code)
      return res.status(400).json({ error: 'Plant users need a Hosiery Division.' });
    if (String(password).length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    try {
      db.prepare(`INSERT INTO users (username, display_name, pw_hash, role, hd_code)
                  VALUES (?,?,?,?,?)`)
        .run(String(username).trim(), display_name || username, bcrypt.hashSync(String(password), 10),
             role, role === 'plant' ? hd_code : null);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: 'Username already exists.' }); }
  });
  app.post('/api/admin/users/:id/delete', requireRole('admin'), (req, res) => {
    const id = +req.params.id;
    if (id === req.user.user_id) return res.status(400).json({ error: "You can't delete your own account." });
    const u = db.prepare('SELECT username, role FROM users WHERE user_id=?').get(id);
    if (!u) return res.status(404).json({ error: 'User not found.' });
    if (u.role === 'admin' && db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1").get().n <= 1)
      return res.status(400).json({ error: 'Cannot delete the last active admin.' });
    db.prepare('DELETE FROM users WHERE user_id=?').run(id);
    res.json({ ok: true });
  });

  app.post('/api/admin/users/:id', requireRole('admin'), (req, res) => {
    const id = +req.params.id;
    const { password, role, hd_code, active, display_name, username } = req.body || {};
    if (username !== undefined) {
      const un = String(username).trim();
      if (un.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters.' });
      try { db.prepare('UPDATE users SET username=? WHERE user_id=?').run(un, id); }
      catch (e) { return res.status(400).json({ error: 'That username is already taken.' }); }
    }
    if (id === req.user.user_id && active === 0)
      return res.status(400).json({ error: "You can't deactivate your own account." });
    if (password) db.prepare('UPDATE users SET pw_hash=? WHERE user_id=?').run(bcrypt.hashSync(String(password), 10), id);
    if (role && ['admin', 'viewer', 'plant'].includes(role)) db.prepare('UPDATE users SET role=? WHERE user_id=?').run(role, id);
    if (hd_code !== undefined) db.prepare('UPDATE users SET hd_code=? WHERE user_id=?').run(hd_code || null, id);
    if (display_name) db.prepare('UPDATE users SET display_name=? WHERE user_id=?').run(display_name, id);
    if (active !== undefined) db.prepare('UPDATE users SET active=? WHERE user_id=?').run(active ? 1 : 0, id);
    res.json({ ok: true });
  });
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  next();
}
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
    if (req.user.role !== role) return res.status(403).json({ error: 'Not allowed for your role.' });
    next();
  };
}

module.exports = { setupAuth, requireAuth, requireRole };
