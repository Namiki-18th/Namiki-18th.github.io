const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const crypto = require('crypto');
const cors = require('cors');
const RssParser = require('rss-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const rssParser = new RssParser();

const corsOrigin = process.env.CORS_ORIGIN || process.env.RENDER_EXTERNAL_URL || true;
const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    methods: ["GET", "POST"],
    credentials: true
  }
});
const PORT = process.env.PORT || 3000;

// --- [基本設定] ---
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.use(cors({
  origin: corsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key']
}));

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

// --- [インメモリキャッシュ] ---
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
const googleCallbackURL =
  process.env.GOOGLE_CALLBACK_URL ||
  (process.env.RENDER_EXTERNAL_URL
    ? `${process.env.RENDER_EXTERNAL_URL}/auth/google/callback`
    : 'http://localhost:3000/auth/google/callback');

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: googleCallbackURL
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
passport.deserializeUser((email, done) => {
  const user = usersDB[email];
  if (!user) {
    console.warn(`[Auth] User not found during deserialization: ${email}`);
    return done(null, false);
  }
  done(null, user);
});

const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
const useSecureCookie = isProduction && process.env.GOOGLE_CALLBACK_URL?.startsWith('https://');

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'secret-key-change-this',
  resave: false,
  saveUninitialized: false,
  proxy: isProduction,
  cookie: {
    secure: useSecureCookie,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 86400000
  }
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
    const isExempt = 
      req.path === '/' || 
      req.path === '/login' || 
      req.path === '/login.html' || 
      req.path === '/login-deny' ||
      req.path === '/offline' || 
      req.path === '/offline.html' ||
      req.path.startsWith('/api/') || 
      req.path.startsWith('/auth/') ||
      req.path.startsWith('/public/') ||
      req.path.match(/\.(css|js|png|jpg|jpeg|gif|webp|ico|svg|woff|woff2|ttf|eot)$/i);
    
    if (!isAdmin && !isExempt) return res.redirect('/offline.html');
  }
  next();
}

const publicPaths = ['/', '/login', '/login.html', '/login-deny', '/offline', '/offline.html', '/auth/google', '/auth/google/callback', '/logout'];
const publicApiPaths = ['/api/auth'];

function shouldRequireAuth(req) {
  if (publicPaths.includes(req.path)) return false;
  if (publicApiPaths.some(p => req.path.startsWith(p))) return false;
  if (req.path.match(/\.(css|js|png|jpg|jpeg|gif|webp|ico|svg|woff|woff2|ttf|eot)$/i)) return false;
  if (req.path.startsWith('/public/')) return false;
  return true;
}

app.use((req, res, next) => {
  if (shouldRequireAuth(req)) {
    checkAccountStatus(req, res, () => checkMaintenanceMode(req, res, next));
  } else {
    checkMaintenanceMode(req, res, next);
  }
});

const ensureAuth = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  if (req.xhr || req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
};

const ensureAdmin = (req, res, next) => {
  if (req.isAuthenticated() && req.user?.role === 'admin') return next();
  if (req.xhr || req.path.startsWith('/api/')) return res.status(403).json({ error: 'Forbidden' });
  res.redirect('/login');
};

const ensureApiKeyOrAdmin = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  const validKey = process.env.API_SECRET_KEY;
  if (validKey && apiKey === validKey) return next();
  return ensureAdmin(req, res, next);
};

// --- [ルーティング: 認証 & 画面] ---
app.get('/', (req, res) => res.redirect(req.isAuthenticated() ? '/index' : '/login'));
app.get('/login', (req, res) => req.isAuthenticated() ? res.redirect('/index') : res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/auth/google', (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).send('Google OAuth is not configured on the server.');
  }
  passport.authenticate('google', { scope: ['profile', 'email'], prompt: 'select_account' })(req, res, next);
});

app.get('/auth/google/callback', (req, res, next) => {
  passport.authenticate('google', { failureRedirect: '/login-deny' }, (err, user) => {
    if (err) return next(err);
    if (!user) return res.redirect('/login-deny');

    req.logIn(user, (loginErr) => {
      if (loginErr) return next(loginErr);
      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);
        return res.redirect('/index');
      });
    });
  })(req, res, next);
});

app.get('/login-deny', (req, res) => {
  res.status(403).send(`
    <!doctype html>
    <html lang="ja">
    <head><meta charset="utf-8"><title>ログインできません</title></head>
    <body>
      <h1>ログインできません</h1>
      <p>Googleアカウントが許可されていないか、Google OAuthの設定に問題があります。</p>
      <p><a href="/login">ログイン画面へ戻る</a></p>
    </body>
    </html>
  `);
});

app.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => res.redirect('/login'));
  });
});

['index', 'terms', 'privacy', 'report', 'link', 'calendar', 'schedule', 'chat', 'notice', 'classroom'].forEach(p => app.get(`/${p}`, ensureAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', `${p}.html`))));
['admin'].forEach(p => app.get(`/${p}`, ensureAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', `${p}.html`))));
app.get('/offline', (req, res) => res.sendFile(path.join(__dirname, 'public', 'offline.html')));

// --- [API: 一般機能] ---
app.get('/api/profile', ensureAuth, (req, res) => res.json(usersDB[req.user.email] || req.user));
app.get('/api/notices', ensureAuth, (req, res) => res.json(safeReadJSON(PATHS.NOTICES, [])));
app.get('/api/classroom', ensureAuth, (req, res) => res.json(safeReadJSON(PATHS.CLASSROOM, [])));

app.post('/api/classroom', ensureApiKeyOrAdmin, (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Array required' });
  safeWriteJSON(PATHS.CLASSROOM, items);
  io.emit('classroomUpdated', items);
  res.json({ success: true, count: items.length });
});

// --- [API: リアルタイム交通運行情報] ---
app.get('/api/transit', ensureAuth, async (req, res) => {
  const results = {};

  // 1. JR常磐線（JR東日本 公式サイトから直接取得）
  try {
    const jrRes = await axios.get('https://traininfo.jreast.co.jp/train_info/kanto.aspx', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'ja-JP,ja;q=0.9'
      },
      timeout: 5000
    });

    const html = jrRes.data;
    const jobanMatch = html.match(/常磐線[\s\S]*?<\/tr>/);
    const jobanText = jobanMatch ? jobanMatch[0].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';

    const isTrouble = jobanText.includes('遅延') || jobanText.includes('見合わせ') || jobanText.includes('運休');
    
    results.jr = {
      status: isTrouble ? '遅延・見合わせ等' : '平常運行',
      detail: jobanText || '平常通り運転しています。',
      isTrouble
    };
  } catch (err) {
    console.error(`[Transit API Error] jr (JR East Official):`, err.message);
    results.jr = {
      status: '取得エラー',
      detail: 'JR公式Webサイトをご確認ください。',
      isTrouble: false
    };
  }

  // 2. つくばエクスプレス & 関東鉄道（Yahoo! RSS）
  const otherUrls = {
    tx: 'https://transit.yahoo.co.jp/rss/diainfo/210/0',
    kantetsu: 'https://transit.yahoo.co.jp/rss/diainfo/211/0'
  };

  for (const [key, url] of Object.entries(otherUrls)) {
    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept-Language': 'ja-JP,ja;q=0.9',
          'Referer': 'https://transit.yahoo.co.jp/'
        },
        timeout: 5000
      });

      const feed = await rssParser.parseString(response.data);
      const firstItem = feed.items && feed.items.length > 0 ? feed.items[0] : null;
      
      const isNormal = !firstItem || 
                       firstItem.title.includes('平常運転') || 
                       firstItem.title.includes('平常通り');
      
      results[key] = {
        status: isNormal ? '平常運行' : '遅延・見合わせ等',
        detail: firstItem ? firstItem.title : '現在、１５分以上の遅延ガイド情報はありません。',
        isTrouble: !isNormal
      };
    } catch (err) {
      console.error(`[Transit API Error] ${key}:`, err.message);
      results[key] = {
        status: '取得エラー',
        detail: '最新情報の取得に失敗しました。',
        isTrouble: false
      };
    }
  }

  res.json(results);
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
  if (status >= 400 && status < 500) {
    console.warn(`[HTTP ${status}] ${req.method} ${req.url} - ${err.message} | User: ${req.user?.email || 'anonymous'}`);
  } else {
    console.error(`[System Error - ${status}] ${req.method} ${req.url} | User: ${req.user?.email || 'anonymous'}`, err.stack);
  }

  if (req.xhr || req.path.startsWith('/api/')) return res.status(status).json({ error: err.message });

  const customPage = path.join(__dirname, 'public', 'error', `${status}.html`);
  res.status(status).sendFile(fs.existsSync(customPage) ? customPage : path.join(__dirname, 'public', 'error', 'error.html'), (err) => {
    if (err) res.status(status).send(`<h1>${status} Error</h1><p>${err.message}</p>`);
  });
});

server.listen(PORT, () => console.log(`[Server] Running on port ${PORT}`));