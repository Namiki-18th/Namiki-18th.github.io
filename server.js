const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.CORS_ORIGIN || "*", methods: ["GET", "POST"] } });
const PORT = process.env.PORT || 3000;

// --- [基本設定] ---
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// --- [パス定義 & ストレージ管理] ---
const PATHS = {
  USERS: path.join(__dirname, 'users.json'),
  NOTICES: path.join(__dirname, 'notices.json'),
  CLASSROOM: path.join(__dirname, 'classroom.json'),
  SCHEDULE: path.join(__dirname, 'schedule.json'),
  EVENTS: path.join(__dirname, 'events.json'),
  SETTINGS: path.join(__dirname, 'settings.json'),
  CHAT_DIR: path.join(__dirname, 'chat'),
  CHAT_LOG: path.join(__dirname, 'chat.log')
};

if (!fs.existsSync(PATHS.CHAT_DIR)) fs.mkdirSync(PATHS.CHAT_DIR, { recursive: true });

function safeWriteJSON(filePath, data) {
  const tempPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    throw err;
  }
}

function safeReadJSON(filePath, fallback = {}) {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : fallback;
  } catch (e) {
    return fallback;
  }
}

// --- [インメモリキャッシュ（I/O負荷低減）] ---
let usersDB = safeReadJSON(PATHS.USERS, {
  'bme280.gac@gmail.com': { id: 'Admin', name: '管理者', email: 'bme280.gac@gmail.com', userClass: '管理者', role: 'admin', status: 'active', picture: 'admin.png' }
});
let systemSettings = safeReadJSON(PATHS.SETTINGS, { maintenanceMode: false });

function saveUsersDB() {
  if (usersDB['bme280.gac@gmail.com']) {
    usersDB['bme280.gac@gmail.com'].role = 'admin';
    usersDB['bme280.gac@gmail.com'].status = 'active';
  }
  safeWriteJSON(PATHS.USERS, usersDB);
}

// --- [暗号化ユーティリティ] ---
const ENCRYPTION_KEY = Buffer.from(process.env.CHAT_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const content = cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
  return { iv: iv.toString('hex'), content, tag: cipher.getAuthTag().toString('hex') };
}

function decrypt({ iv, content, tag }) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return decipher.update(content, 'hex', 'utf8') + decipher.final('utf8');
}

// --- [認証設定] ---
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID || 'demo-id',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'demo-secret',
  callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/google/callback'
}, (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails?.[0]?.value || '';
    const isPrivilegedAdmin = (email === 'bme280.gac@gmail.com');
    if (!email.endsWith('@namiki-cs.ibk.ed.jp') && !isPrivilegedAdmin) return done(null, false);

    const existingUser = usersDB[email];
    const isAdmin = isPrivilegedAdmin || (existingUser && existingUser.role === 'admin');
    
    let userId = 'Unknown';
    if (isAdmin) userId = 'Admin';
    else {
      try { userId = require('./unlock').getStudentNumber(profile.displayName) || 'Unknown'; } catch (_) {}
    }

    const user = {
      id: userId,
      name: isPrivilegedAdmin ? '管理者' : (profile.displayName || 'ユーザー'),
      email,
      picture: isPrivilegedAdmin ? 'admin.png' : (profile.photos?.[0]?.value || ''),
      userClass: isAdmin ? (isPrivilegedAdmin ? '管理者' : '教職員') : (userId.length >= 2 ? userId.substring(0, 2) : '未設定'),
      role: isAdmin ? 'admin' : 'student',
      status: isPrivilegedAdmin ? 'active' : (existingUser?.status || 'active')
    };

    usersDB[email] = user;
    saveUsersDB();
    return done(null, user);
  } catch (err) {
    return done(err, null);
  }
}));

passport.serializeUser((user, done) => done(null, user.email));
passport.deserializeUser((email, done) => done(null, usersDB[email] || { email, role: 'student', status: 'active' }));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'secret-key',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, sameSite: 'lax', maxAge: 86400000 }
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

// --- [アクセス制御ミドルウェア] ---
function checkAccountStatus(req, res, next) {
  if (req.isAuthenticated() && req.user) {
    const currentUser = usersDB[req.user.email];
    if (currentUser?.status === 'suspended' && req.user.email !== 'bme280.gac@gmail.com') {
      return (req.xhr || req.path.startsWith('/api/')) ? res.status(403).json({ error: 'Suspended' }) : res.redirect('/suspended.html');
    }
  }
  next();
}

function checkMaintenanceMode(req, res, next) {
  if (systemSettings.maintenanceMode) {
    const isAdmin = req.user?.role === 'admin';
    const isExempt = req.path === '/offline' || req.path.startsWith('/api/') || req.path.startsWith('/auth/');
    if (!isAdmin && !isExempt) return res.redirect('/offline');
  }
  next();
}

app.use(checkAccountStatus);
app.use(checkMaintenanceMode);

const ensureAuth = (req, res, next) => req.isAuthenticated() ? next() : res.status(401).json({ error: 'Unauthorized' });
const ensureAdmin = (req, res, next) => (req.isAuthenticated() && req.user?.role === 'admin') ? next() : res.status(403).json({ error: 'Forbidden' });

// --- [ルーティング: 認証 & 画面] ---
app.get('/', (req, res) => res.redirect(req.isAuthenticated() ? '/index' : '/login'));
app.get('/login', (req, res) => req.isAuthenticated() ? res.redirect('/index') : res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login-deny' }), (req, res) => res.redirect('/index'));
app.get('/logout', (req, res, next) => req.logout(() => res.redirect('/login')));

['index', 'terms', 'privacy'].forEach(p => app.get(`/${p}`, (req, res) => req.isAuthenticated() ? res.sendFile(path.join(__dirname, 'public', `${p}.html`)) : res.redirect('/login')));
['admin', 'report'].forEach(p => app.get(`/${p}`, ensureAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', `${p}.html`))));
app.get('/offline', (req, res) => res.sendFile(path.join(__dirname, 'public', 'offline.html')));

// --- [API: 一般機能] ---
app.get('/api/profile', ensureAuth, (req, res) => res.json(usersDB[req.user.email] || req.user));
app.get('/api/notices', ensureAuth, (req, res) => res.json(safeReadJSON(PATHS.NOTICES, [])));
app.get('/api/classroom', ensureAuth, (req, res) => res.json(safeReadJSON(PATHS.CLASSROOM, [])));

// ※ 認証を必須へ修正
app.post('/api/classroom', ensureAdmin, (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Array required' });
  safeWriteJSON(PATHS.CLASSROOM, items);
  io.emit('classroomUpdated', items);
  res.json({ success: true, count: items.length });
});

// --- [API: チャット] ---
app.get('/api/chat', ensureAuth, (req, res) => {
  const channel = (req.query.channel || 'grade').replace(/[^a-zA-Z0-9_-]/g, '_');
  const file = path.join(PATHS.CHAT_DIR, `${channel}.json`);
  const data = safeReadJSON(file, { messages: [] });
  res.json({ channel, messages: data.messages.map(m => ({ ...m, text: decrypt(m.encryptedData) })) });
});

app.post('/api/chat', ensureAuth, (req, res) => {
  const { channel, text } = req.body;
  if (!channel || !text) return res.status(400).json({ error: 'Missing fields' });

  const safeChannel = channel.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(PATHS.CHAT_DIR, `${safeChannel}.json`);
  const chatData = safeReadJSON(filePath, { channel, messages: [] });
  
  const msg = { sender: req.user.name, recipient: channel, encryptedData: encrypt(text), timestamp: new Date().toISOString() };
  chatData.messages.push(msg);

  safeWriteJSON(filePath, chatData);
  io.to(channel).emit('chatMessage', { sender: msg.sender, recipient: msg.recipient, text, timestamp: msg.timestamp });
  res.json({ success: true });
});

// --- [API: 管理者機能] ---
app.get('/api/admin/users', ensureAdmin, (req, res) => res.json(Object.values(usersDB)));
app.post('/api/admin/settings/maintenance', ensureAdmin, (req, res) => {
  systemSettings.maintenanceMode = !!req.body.enabled;
  safeWriteJSON(PATHS.SETTINGS, systemSettings);
  io.emit('systemSettingsUpdated', systemSettings);
  res.json({ success: true, maintenanceMode: systemSettings.maintenanceMode });
});

// --- [Socket.io 制御] ---
io.on('connection', (socket) => {
  if (!socket.request.session?.passport?.user) return socket.disconnect(true);
  socket.on('joinChannel', (ch) => {
    socket.rooms.forEach(r => r !== socket.id && socket.leave(r));
    socket.join(ch);
  });
});

// --- [エラーハンドラー] ---
app.use((req, res, next) => {
  const err = new Error('Not Found');
  err.status = 404;
  next(err);
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 400 && status < 500) console.warn(`[HTTP ${status}] ${req.method} ${req.url} - ${err.message}`);
  else console.error(`[System Error - ${status}] ${req.method} ${req.url}`, err.stack);

  if (req.xhr || req.path.startsWith('/api/')) return res.status(status).json({ error: err.message });

  const customPage = path.join(__dirname, 'public', 'error', `${status}.html`);
  res.status(status).sendFile(fs.existsSync(customPage) ? customPage : path.join(__dirname, 'public', 'error', 'error.html'));
});

server.listen(PORT, () => console.log(`[Server] Running on port ${PORT}`));