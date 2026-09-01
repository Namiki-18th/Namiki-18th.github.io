const express = require('express');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const http = require('http');
const { Server } = require('socket.io');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const FirebaseStore = require('connect-session-firebase')(session);
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const RssParser = require('rss-parser');
const axios = require('axios');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
require('dotenv').config();

// --- [オプショナルモジュールの読み込み] ---
let unlockModule = null;
try {
  unlockModule = require('./unlock');
} catch (e) {
  console.log('[System] unlock.js は見つかりませんでした。標準設定で動作します。');
}

// GitHub Storage モジュールのフォールバック設計
let githubStorage = {
  isGithubConfigured: () => false,
  getFileFromGithub: async (f, fallback) => fallback,
  uploadJsonToGithub: async () => {},
  appendLogToGithub: async () => {}
};
try {
  githubStorage = require('./githubStorage');
} catch (e) {
  console.log('[System] githubStorage.js は見つかりませんでした。ローカルファイルストレージを使用します。');
}
const { isGithubConfigured, getFileFromGithub, uploadJsonToGithub, appendLogToGithub } = githubStorage;

// 非同期ハンドラーラッパー
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// グローバルエラーハンドリング
process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Promise Rejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err);
});

// --- [Firebase Realtime Database 設定] ---
const FIREBASE_DB_URL = process.env.FIREBASE_DATABASE_URL;
let firebaseDb = null;

if (FIREBASE_DB_URL) {
  try {
    let serviceAccount = null;
    if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    } else if (fs.existsSync(path.join(__dirname, 'serviceAccountKey.json'))) {
      serviceAccount = require('./serviceAccountKey.json');
    }

    if (serviceAccount) {
      if (!getApps().length) {
        initializeApp({
          credential: cert(serviceAccount),
          databaseURL: FIREBASE_DB_URL
        });
      }
      firebaseDb = getDatabase();
      console.log('[Firebase] Realtime Database initialized successfully.');
    } else {
      console.warn('[Firebase] Service account credential not found. Falling back to local storage.');
    }
  } catch (e) {
    console.error('[Firebase Initialization Error]:', e.message);
  }
}

// 管理者メールアドレスの読み込み
const PRIVILEGED_ADMINS = (process.env.PRIVILEGED_ADMINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const isPrivilegedAdminEmail = (email) => PRIVILEGED_ADMINS.includes(email);

// サーバー初期化
const app = express();
const server = http.createServer(app);
const rssParser = new RssParser();

const rawCorsOrigin = process.env.CORS_ORIGIN || process.env.RENDER_EXTERNAL_URL || '';
const corsOrigin = rawCorsOrigin
  ? rawCorsOrigin.includes(',')
    ? rawCorsOrigin.split(',').map((s) => s.trim())
    : rawCorsOrigin
  : false;

const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST'],
    credentials: true
  }
});
const PORT = process.env.PORT || 3000;

// --- [基本設定 & セキュリティ (Helmet, CSP, Nonce)] ---
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});

const connectSrcUrls = [
  "'self'",
  'https://api.odpt.org',
  'https://api.allorigins.win',
  'https://*.firebasedatabase.app',
  'wss://*.firebaseio.com'
];
if (process.env.ROAD_INFO_WORKER_URL) connectSrcUrls.push(process.env.ROAD_INFO_WORKER_URL);
if (process.env.JOBAN_LINE_WORKER_URL) connectSrcUrls.push(process.env.JOBAN_LINE_WORKER_URL);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          (req, res) => `'nonce-${res.locals.cspNonce}'`,
          'https://cdn.jsdelivr.net',
          'https://cdnjs.cloudflare.com'
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'", // nonce 記述を削除して unsafe-inline を正常動作させる
          'https://fonts.googleapis.com'
        ],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: connectSrcUrls,
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'"]
      }
    },
    crossOriginEmbedderPolicy: false
  })
);

async function sendHtmlWithNonce(res, filePath) {
  try {
    const html = await fsPromises.readFile(filePath, 'utf8');
    const nonce = res.locals.cspNonce;
    const injected = html.replace(/%%CSP_NONCE%%/g, nonce);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(injected);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).end('Not Found');
    return res.status(500).end('Internal Server Error');
  }
}

// レート制限の設定
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(globalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: true }));

app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key']
  })
);

// 不正パス防止
app.use((req, res, next) => {
  if (req.path.startsWith('/http:/') || req.path.startsWith('/https:/')) {
    return res.status(404).json({ error: 'Invalid URL routing path' });
  }
  next();
});

// 認証不要ルート
app.get(['/privacy-noauth', '/privacy-noauth.html'], asyncHandler(async (req, res) => await sendHtmlWithNonce(res, path.join(__dirname, 'public', 'privacy.html'))));
app.get(['/terms-noauth', '/terms-noauth.html'], asyncHandler(async (req, res) => await sendHtmlWithNonce(res, path.join(__dirname, 'public', 'terms.html'))));

// --- [パス定義 & ストレージ管理] ---
const DATA_DIR = path.join(__dirname, 'data');
const CHAT_DIR = path.join(DATA_DIR, 'chat');

const PATHS = {
  USERS: path.join(DATA_DIR, 'users.json'),
  NOTICES: path.join(DATA_DIR, 'notices.json'),
  CLASSROOM: path.join(DATA_DIR, 'classroom.json'),
  SCHEDULE: path.join(DATA_DIR, 'schedule.json'),
  EVENTS: path.join(DATA_DIR, 'events.json'),
  SETTINGS: path.join(DATA_DIR, 'settings.json'),
  LOGS: path.join(DATA_DIR, 'logs.json'),
  REPORTS: path.join(DATA_DIR, 'reports.json'),
  LINKS: path.join(DATA_DIR, 'links.json'),
  CHAT_DIR: CHAT_DIR
};

async function safeWriteJSON(filePath, data) {
  const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).substring(2)}.tmp`;
  try {
    await fsPromises.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
    await fsPromises.rename(tempPath, filePath);
  } catch (err) {
    try {
      await fsPromises.unlink(tempPath);
    } catch (_) {}
    throw err;
  }
}

async function safeReadJSON(filePath, fallback = {}) {
  try {
    const data = await fsPromises.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return fallback;
  }
}

// --- [インメモリキャッシュ (既存のデータ用)] ---
let defaultUsers = {};
if (PRIVILEGED_ADMINS.length > 0) {
  const mainAdmin = PRIVILEGED_ADMINS[0];
  defaultUsers[mainAdmin] = {
    id: 'Admin',
    name: '管理者',
    email: mainAdmin,
    userClass: '管理者',
    role: 'admin',
    status: 'active',
    picture: 'admin.png'
  };
}

let usersDB = {};
let systemSettings = {};
let systemLogs = [];
const MAX_LOGS_LIMIT = 1000; // メモリおよびディスク肥大化防止のログ件数上限

// --- [GitHub 同期処理] ---
async function syncWithGithub() {
  if (!isGithubConfigured()) return;
  console.log('[GitHub Storage] Synchronizing data from GitHub...');

  try {
    const remoteLogs = await getFileFromGithub('logs.json', null);
    if (remoteLogs && Array.isArray(remoteLogs)) {
      systemLogs = remoteLogs.slice(0, MAX_LOGS_LIMIT);
      await safeWriteJSON(PATHS.LOGS, systemLogs);
    }

    const remoteUsers = await getFileFromGithub('users.json', null);
    if (remoteUsers && typeof remoteUsers === 'object' && !Array.isArray(remoteUsers)) {
      usersDB = remoteUsers;
      await safeWriteJSON(PATHS.USERS, usersDB);
    }

    const remoteSettings = await getFileFromGithub('settings.json', null);
    if (remoteSettings && typeof remoteSettings === 'object' && !Array.isArray(remoteSettings)) {
      systemSettings = remoteSettings;
      await safeWriteJSON(PATHS.SETTINGS, systemSettings);
    }

    const syncFiles = [
      { name: 'notices.json', path: PATHS.NOTICES },
      { name: 'classroom.json', path: PATHS.CLASSROOM },
      { name: 'schedule.json', path: PATHS.SCHEDULE },
      { name: 'events.json', path: PATHS.EVENTS },
      { name: 'reports.json', path: PATHS.REPORTS },
      { name: 'links.json', path: PATHS.LINKS }
    ];

    for (const file of syncFiles) {
      const data = await getFileFromGithub(file.name, null);
      if (data) await safeWriteJSON(file.path, data);
    }

    console.log('[GitHub Storage] Synchronization complete.');
  } catch (error) {
    console.error('[GitHub Storage] Synchronization failed:', error.message);
  }
}

// --- [ログ同期（Firebase バッファ -> GitHub アーカイブ）処理] ---
async function flushLogsToGithub() {
  if (!firebaseDb || !isGithubConfigured()) return;
  try {
    const snapshot = await firebaseDb.ref('pending_logs').once('value');
    const pendingObj = snapshot.val();
    if (!pendingObj) return;

    const pendingLogs = Object.values(pendingObj);
    if (pendingLogs.length === 0) return;

    const existingLogs = await getFileFromGithub('logs.json', []);
    const updatedLogs = [...pendingLogs.reverse(), ...existingLogs].slice(0, MAX_LOGS_LIMIT);

    await uploadJsonToGithub('logs.json', updatedLogs, `Batch sync ${pendingLogs.length} logs from Firebase buffer`);
    await firebaseDb.ref('pending_logs').remove();
    console.log(`[Log Sync] Successfully transferred ${pendingLogs.length} logs to GitHub.`);
  } catch (err) {
    console.error('[Log Sync Error]:', err.message);
  }
}

setInterval(() => {
  flushLogsToGithub().catch((err) => console.error('[Log Batch Interval Error]:', err.message));
}, 6 * 60 * 60 * 1000);

// --- [最適化されたログ追加関数 (デバウンス・上限付き)] ---
let logSaveTimeout = null;
function scheduleLogSave() {
  if (logSaveTimeout) return;
  logSaveTimeout = setTimeout(() => {
    logSaveTimeout = null;
    safeWriteJSON(PATHS.LOGS, systemLogs).catch((err) => {
      console.error('[Log Disk Save Error]:', err.message);
    });
  }, 2000); // ログ書き込みを2秒間統合してディスクI/Oを激減させる
}

async function addLog(req, action, email, details = '') {
  const ip = req.headers['x-forwarded-for']
    ? req.headers['x-forwarded-for'].split(',')[0].trim()
    : req.socket?.remoteAddress || req.ip || 'Unknown';

  const userAgent = req.headers['user-agent'] || 'Unknown';

  const logEntry = {
    timestamp: new Date().toISOString(),
    action,
    email,
    ip,
    userAgent,
    details,
    method: req.method || 'Unknown',
    url: req.originalUrl || req.url || 'Unknown'
  };

  systemLogs.unshift(logEntry);
  if (systemLogs.length > MAX_LOGS_LIMIT) {
    systemLogs = systemLogs.slice(0, MAX_LOGS_LIMIT);
  }

  // ディスク保存は一括書き込み（デバウンス）処理でI/Oパンクを防ぐ
  scheduleLogSave();

  if (firebaseDb) {
    try {
      const newRef = firebaseDb.ref('pending_logs').push();
      await newRef.set(logEntry);

      const snapshot = await firebaseDb.ref('pending_logs').once('value');
      const count = snapshot.numChildren();

      if (count >= 500) {
        await flushLogsToGithub();
      }
    } catch (err) {
      console.error('[Firebase Log Buffer Error]:', err.message);
    }
  } else if (isGithubConfigured()) {
    appendLogToGithub('logs.json', logEntry, `Log: ${action} by ${email}`).catch((err) => {
      console.error('[GitHub Storage] addLog sync failed:', err.message);
    });
  }
}

async function saveUsersDB() {
  PRIVILEGED_ADMINS.forEach((adminEmail) => {
    if (usersDB[adminEmail]) {
      usersDB[adminEmail].role = 'admin';
      usersDB[adminEmail].status = 'active';
    }
  });
  await safeWriteJSON(PATHS.USERS, usersDB);
  if (isGithubConfigured()) {
    uploadJsonToGithub('users.json', usersDB, 'Update users DB').catch(() => {});
  }
}

// --- [暗号化ユーティリティ (AES-256-GCM)] ---
if (!process.env.CHAT_ENCRYPTION_KEY) {
  console.error('[FATAL ERROR] CHAT_ENCRYPTION_KEY が設定されていません。セキュリティのためサーバーを停止します。');
  process.exit(1);
}
const ENCRYPTION_KEY = Buffer.from(process.env.CHAT_ENCRYPTION_KEY, 'hex');

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const content = cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
  return { iv: iv.toString('hex'), content, tag: cipher.getAuthTag().toString('hex') };
}

function decrypt(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, Buffer.from(data.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(data.tag, 'hex'));
    return decipher.update(data.content, 'hex', 'utf8') + decipher.final('utf8');
  } catch (err) {
    return '[復号化エラー]';
  }
}

// --- [Firebase リアルタイム同期リスナー（チャット用）] ---
if (firebaseDb) {
  firebaseDb.ref('chats').on('child_added', (channelSnapshot) => {
    const channelKey = channelSnapshot.key;
    channelSnapshot.ref.limitToLast(1).on('child_added', (msgSnapshot) => {
      const msg = msgSnapshot.val();
      if (msg && msg.content) {
        const decryptedContent = decrypt(msg.content);
        io.to(channelKey).emit('newMessage', { ...msg, content: decryptedContent });
      }
    });
  });
}

// --- [認証設定 (Passport Google OAuth 2.0)] ---
const googleCallbackURL =
  process.env.GOOGLE_CALLBACK_URL ||
  (process.env.RENDER_EXTERNAL_URL
    ? `${process.env.RENDER_EXTERNAL_URL}/auth/google/callback`
    : 'http://localhost:3000/auth/google/callback');

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: googleCallbackURL
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value || '';
          const isPrivilegedAdmin = isPrivilegedAdminEmail(email);

          if (!email.endsWith('@namiki-cs.ibk.ed.jp') && !isPrivilegedAdmin) {
            return done(null, false);
          }

          const existingUser = usersDB[email];
          const isAdmin = isPrivilegedAdmin || (existingUser && existingUser.role === 'admin');

          let userId = 'Unknown';
          if (isAdmin) userId = 'Admin';
          else if (unlockModule && typeof unlockModule.getStudentNumber === 'function') {
            try {
              userId = unlockModule.getStudentNumber(profile.displayName) || 'Unknown';
            } catch (_) {}
          }

          const user = {
            id: userId,
            name: isPrivilegedAdmin ? '管理者' : profile.displayName || 'ユーザー',
            email,
            picture: isPrivilegedAdmin ? 'admin.png' : profile.photos?.[0]?.value || '',
            userClass: isAdmin ? (isPrivilegedAdmin ? '管理者' : '教職員') : userId.length >= 2 ? userId.substring(0, 2) : '未設定',
            role: isAdmin ? 'admin' : 'student',
            status: isPrivilegedAdmin ? 'active' : existingUser?.status || 'active'
          };

          usersDB[email] = user;
          await saveUsersDB();
          return done(null, user);
        } catch (err) {
          return done(err, null);
        }
      }
    )
  );
} else {
  console.error('[SECURITY ERROR] GOOGLE_CLIENT_ID または GOOGLE_CLIENT_SECRET が未設定です。OAuth 認証は無効化されています。');
}

passport.serializeUser((user, done) => done(null, user.email));
passport.deserializeUser((email, done) => {
  const user = usersDB[email];
  if (!user) return done(null, false);
  done(null, user);
});

const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RENDER;

// セッションストア
let sessionStore;
if (firebaseDb) {
  sessionStore = new FirebaseStore({
    database: firebaseDb
  });
  console.log('[Session] Firebase をセッションストアとして使用します。');
} else {
  console.warn('[SECURITY WARNING] Firebase未接続のため MemoryStore を使用します。');
}

if (!process.env.SESSION_SECRET) {
  console.error('[FATAL ERROR] SESSION_SECRET が設定されていません。セキュリティのためサーバーを停止します。');
  process.exit(1);
}

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  proxy: isProduction,
  cookie: {
    secure: isProduction,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 86400000
  }
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

// --- [全リクエストログのディスク書き込みミドルウェアを撤去し、軽快なアクセス制御へ] ---

// --- [アクセス制御ミドルウェア] ---
function checkAccountStatus(req, res, next) {
  if (req.isAuthenticated() && req.user) {
    const currentUser = usersDB[req.user.email];
    if (currentUser?.status === 'suspended' && !isPrivilegedAdminEmail(req.user.email)) {
      return req.xhr || req.path.startsWith('/api/')
        ? res.status(403).json({ error: 'Suspended' })
        : res.redirect('/suspended.html');
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

const publicPaths = ['/', '/login', '/login.html', '/login-deny', '/offline', '/offline.html', '/privacy-noauth', '/terms-noauth', '/auth/google', '/auth/google/callback', '/logout'];
const publicApiPaths = ['/api/auth', '/api/offline/config'];

function shouldRequireAuth(req) {
  if (publicPaths.includes(req.path)) return false;
  if (publicApiPaths.some((p) => req.path.startsWith(p))) return false;
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

function safeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const ensureApiKeyOrAdmin = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  const validKey = process.env.API_SECRET_KEY;
  if (validKey && apiKey && safeCompare(apiKey, validKey)) return next();
  return ensureAdmin(req, res, next);
};

// --- [ルーティング: 認証 & 画面表示] ---
app.get('/', (req, res) => res.redirect(req.isAuthenticated() ? '/index' : '/login'));
app.get('/login', asyncHandler(async (req, res) => (req.isAuthenticated() ? res.redirect('/index') : await sendHtmlWithNonce(res, path.join(__dirname, 'public', 'login.html')))));

app.get('/auth/google', authLimiter, (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).send('Google OAuth is not configured on the server.');
  }
  passport.authenticate('google', { scope: ['profile', 'email'], prompt: 'select_account', state: true })(req, res, next);
});

app.get('/auth/google/callback', authLimiter, (req, res, next) => {
  passport.authenticate('google', { failureRedirect: '/login-deny' }, (err, user) => {
    if (err) return next(err);
    if (!user) return res.redirect('/login-deny');

    req.logIn(user, (loginErr) => {
      if (loginErr) return next(loginErr);
      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);
        addLog(req, 'login', user.email, 'Google OAuth Login').catch((e) => console.error(e));
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

['index', 'terms', 'privacy', 'report', 'link', 'calendar', 'schedule', 'chat', 'notice', 'classroom', 'setting'].forEach((p) => {
  app.get([`/${p}`, `/${p}.html`], ensureAuth, asyncHandler(async (req, res) => await sendHtmlWithNonce(res, path.join(__dirname, 'public', `${p}.html`))));
});
['admin'].forEach((p) => {
  app.get([`/${p}`, `/${p}.html`], ensureAdmin, asyncHandler(async (req, res) => await sendHtmlWithNonce(res, path.join(__dirname, 'public', `${p}.html`))));
});
app.get(['/offline', '/offline.html'], asyncHandler(async (req, res) => await sendHtmlWithNonce(res, path.join(__dirname, 'public', 'offline.html'))));

// --- [静的ファイル配信 (画面ルーティングの後ろに配置)] ---
app.use(
  express.static(path.join(__dirname, 'public'), {
    index: false,
    extensions: ['html'],
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store');
      }
    }
  })
);

// --- [API: 一般機能 & データ取得] ---
app.get('/api/profile', ensureAuth, (req, res) => res.json(usersDB[req.user.email] || req.user));

app.get('/api/notices', ensureAuth, asyncHandler(async (req, res) => res.json(await safeReadJSON(PATHS.NOTICES, []))));
app.get('/api/classroom', ensureAuth, asyncHandler(async (req, res) => res.json(await safeReadJSON(PATHS.CLASSROOM, []))));
app.get('/api/calendar', ensureAuth, asyncHandler(async (req, res) => res.json(await safeReadJSON(PATHS.EVENTS, []))));
app.get('/api/schedule', ensureAuth, asyncHandler(async (req, res) => res.json(await safeReadJSON(PATHS.SCHEDULE, {}))));
app.get('/api/links', ensureAuth, asyncHandler(async (req, res) => res.json(await safeReadJSON(PATHS.LINKS, []))));

app.post(
  '/api/classroom',
  ensureApiKeyOrAdmin,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { items } = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'Array required' });
    if (items.length > 1000) return res.status(400).json({ error: 'Too many items' });
    if (!items.every((it) => it && typeof it === 'object' && !Array.isArray(it))) {
      return res.status(400).json({ error: 'Each item must be an object' });
    }
    await safeWriteJSON(PATHS.CLASSROOM, items);
    if (isGithubConfigured()) {
      await uploadJsonToGithub('classroom.json', items, 'Update classroom items');
    }
    io.emit('classroomUpdated', items);
    await addLog(req, 'notice_post', req.user ? req.user.email : 'System/API', `Items: ${items.length}`);
    res.json({ success: true, count: items.length });
  })
);

const ALLOWED_NOTICE_PRIORITIES = ['high', 'normal', 'low'];

app.post(
  '/api/notices',
  ensureAdmin,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { title, priority, type, content, date } = req.body;

    if (typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'タイトル(title)は必須です。' });
    }
    if (title.length > 200) {
      return res.status(400).json({ error: 'タイトルが長すぎます。' });
    }
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: '本文(content)は必須です。' });
    }
    if (content.length > 5000) {
      return res.status(400).json({ error: '本文が長すぎます。' });
    }
    const safePriority = ALLOWED_NOTICE_PRIORITIES.includes(priority) ? priority : 'normal';
    const safeDate = typeof date === 'string' && date.trim() ? date.trim() : new Date().toISOString().split('T')[0];

    const notices = await safeReadJSON(PATHS.NOTICES, []);

    const newNotice = {
      id: Date.now().toString(),
      title: title.trim(),
      priority: safePriority,
      type: typeof type === 'string' && type.trim() ? type.trim() : 'general',
      content: content.trim(),
      date: safeDate
    };

    notices.unshift(newNotice);
    await safeWriteJSON(PATHS.NOTICES, notices);
    if (isGithubConfigured()) {
      await uploadJsonToGithub('notices.json', notices, `Notice posted by ${req.user.email}`);
    }
    io.emit('noticesUpdated', notices);
    await addLog(req, 'notice_post', req.user.email, `Notice ID: ${newNotice.id}`);
    res.json({ success: true, notice: newNotice });
  })
);

app.delete(
  '/api/notices/:id',
  ensureAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const notices = await safeReadJSON(PATHS.NOTICES, []);

    const nextNotices = notices.filter((n) => String(n.id) !== String(id));
    if (nextNotices.length === notices.length) {
      return res.status(404).json({ error: 'Notice not found' });
    }

    await safeWriteJSON(PATHS.NOTICES, nextNotices);
    if (isGithubConfigured()) {
      await uploadJsonToGithub('notices.json', nextNotices, `Notice ${id} deleted by ${req.user.email}`);
    }
    io.emit('noticesUpdated', nextNotices);
    await addLog(req, 'notice_delete', req.user.email, `Notice ID: ${id}`);
    res.json({ success: true });
  })
);

app.get('/api/offline/config', (req, res) => {
  res.json({
    maintenanceMode: systemSettings.maintenanceMode,
    config: systemSettings.offlineConfig || {
      title: 'Maintenance',
      subtitle: '只今システムメンテナンス中です',
      message: 'サービス向上およびシステム保守のため、一時的に<strong>ログイン後の全機能</strong>を停止しております。<br>ご不便をおかけいたしますが、復旧までしばらくお待ちください。',
      recoveryTime: ''
    }
  });
});

app.post(
  '/api/reports',
  ensureAuth,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { message, subject, type } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: '送信内容(message)は必須です。' });
    }
    if (message.length > 5000) {
      return res.status(400).json({ error: '送信内容が長すぎます。' });
    }

    const reports = await safeReadJSON(PATHS.REPORTS, []);

    const newReport = {
      id: Date.now().toString(),
      userId: req.user.email,
      userName: req.user.name,
      userClass: req.user.userClass,
      subject: subject || 'No Subject',
      type: type || 'report',
      message: message.trim(),
      timestamp: new Date().toISOString()
    };

    reports.push(newReport);

    await safeWriteJSON(PATHS.REPORTS, reports);
    if (isGithubConfigured()) {
      await uploadJsonToGithub('reports.json', reports, `Report submitted by ${req.user.email}`);
    }

    await addLog(req, 'form_submit', req.user.email, `Report ID: ${newReport.id}`);
    res.json({ success: true, message: '送信が完了しました。' });
  })
);

// --- [キャッシュ機能: 運行情報・道路交通情報] ---
let cachedTransitData = {
  jr: { status: '取得中', detail: '最新情報を取得しています...', isTrouble: false },
  tx: { status: '取得中', detail: '最新情報を取得しています...', isTrouble: false },
};

let cachedRoadData = {
  status: '取得中',
  detail: '最新情報を取得しています...',
  icon: 'ico_info_info.svg'
};

async function updateTransitCache() {
  const newTransitData = { ...cachedTransitData };

  const jobanUrl = process.env.JOBAN_LINE_WORKER_URL;
  if (jobanUrl) {
    try {
      const jobanRes = await axios.get(jobanUrl, { timeout: 5000 });
      const data = jobanRes.data;
      const statusText = data.status || '運行情報';
      let detailText = data.detail || data.text || data.message || '最新の情報を取得しました。';

      if (detailText.includes('現在､事故･遅延に関する情報はありません') || detailText.includes('現在、事故・遅延に関する情報はありません')) {
        detailText = '平常通り運転しています。';
      }

      const isTrouble = statusText.includes('遅延') || statusText.includes('見合わせ') || statusText.includes('運休') || detailText.includes('遅延') || detailText.includes('見合わせ');
      newTransitData.jr = { status: isTrouble ? '遅延・運転見合わせ等' : '平常運転', detail: detailText, isTrouble };
    } catch (err) {
      console.error('[Transit API - Joban Error]:', err.message);
    }
  }

  const odptKey = process.env.ODPT_CONSUMER_KEY;
  if (odptKey) {
    try {
      const txApiUrl = `https://api.odpt.org/api/v4/odpt:TrainInformation?odpt:operator=odpt.Operator:MIR&acl:consumerKey=${odptKey}`;
      const txRes = await axios.get(txApiUrl, { timeout: 5000 });
      const data = txRes.data;

      let infoText = '情報なし';
      if (Array.isArray(data) && data.length > 0) {
        infoText = data[0]['odpt:trainInformationText']?.ja || '情報なし';
      }

      if (infoText === '現在、平常通り運転しています。') {
        infoText = '平常通り運転しています。';
      }

      const isTrouble = !infoText.includes('平常');
      newTransitData.tx = { status: isTrouble ? '遅延・見合わせ等' : '平常運行', detail: infoText, isTrouble };
    } catch (err) {
      console.error('[Transit API - TX Error]:', err.message);
    }
  }

  cachedTransitData = newTransitData;
}

async function updateRoadCache() {
  const roadUrl = process.env.ROAD_INFO_WORKER_URL;
  if (!roadUrl) return;

  try {
    const roadRes = await axios.get(roadUrl, { timeout: 5000 });
    const data = roadRes.data;

    if (data.error || (data.road && data.road.error)) {
      console.error('[Road API Logic Error]:', data.road?.error || data.detail);
      return;
    }

    const road = data.road || {};

    const toHankakuNum = (str) => {
      if (!str) return '';
      return String(str).replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xfee0));
    };

    const hasKonzatsu5km = road.hasKonzatsu5km || (road.items && road.items.some(item => {
      const text = (item.text || item.detail || item.status || '').toLowerCase();
      const isKonzatsu = text.includes('混雑');
      const isWithin5km = item.distance === undefined || parseFloat(item.distance) <= 5;
      return isKonzatsu && isWithin5km;
    }));

    if (road.hasCritical) {
      const details = (road.criticalDetails || []).map(toHankakuNum).join('<br>');
      cachedRoadData = { status: '渋滞・規制あり', detail: details, icon: 'ico_info_adjust.svg' };
    } else if (road.hasWarning || hasKonzatsu5km) {
      let warningList = road.warningDetails || [];
      if (road.konzatsuDetails) {
        warningList = warningList.concat(road.konzatsuDetails);
      }
      const details = warningList.length > 0
        ? warningList.map(toHankakuNum).join('<br>')
        : '周辺5km圏内で混雑が発生しています。';
      cachedRoadData = { status: '周辺注意', detail: details, icon: 'ico_info_delay.svg' };
    } else {
      const updatedAt = toHankakuNum(data.updatedAt || '');
      cachedRoadData = {
        status: '平常',
        detail: `周辺10km圏内に渋滞・規制情報はありません。<br>（更新: ${updatedAt}）`,
        icon: 'ico_info_normal.svg'
      };
    }
  } catch (err) {
    console.error('[Road API Error]:', err.message);
  }
}

setInterval(updateTransitCache, 60 * 1000);
setInterval(updateRoadCache, 60 * 1000);

app.get('/api/transit', ensureAuth, asyncHandler(async (req, res) => res.json(cachedTransitData)));
app.get('/api/road', ensureAuth, asyncHandler(async (req, res) => res.json(cachedRoadData)));

// --- [チャット機能 Utility & API] ---
function getSafeChannelName(channel) {
  return (channel || 'grade').replace(/[^a-zA-Z0-9_-]/g, '_');
}
function getChannelFilePath(channel) {
  return path.join(PATHS.CHAT_DIR, `${getSafeChannelName(channel)}.json`);
}
async function readChannelData(channel) {
  return await safeReadJSON(getChannelFilePath(channel), { channel: getSafeChannelName(channel), messages: [] });
}

function resolveChannelKey(currentUser, rawChannel) {
  const ch = (rawChannel || 'grade').toString();
  if (ch === 'grade') return 'grade';
  if (ch === 'class') {
    if (!currentUser.userClass || currentUser.userClass === '未設定') return null;
    return getSafeChannelName(`class_${currentUser.userClass}`);
  }
  if (ch.startsWith('dm_')) {
    const targetId = ch.slice(3);
    const selfId = String(currentUser.id || '');
    if (!targetId || !selfId || targetId === selfId) return null;
    const pair = [selfId, targetId].sort();
    return getSafeChannelName(`dm_${pair[0]}_${pair[1]}`);
  }
  return currentUser.role === 'admin' ? getSafeChannelName(ch) : null;
}

function isChannelVisibleToUser(currentUser, channelId) {
  if (channelId === 'grade') return true;
  if (currentUser.role === 'admin') return true;
  if (channelId === getSafeChannelName(`class_${currentUser.userClass}`)) return true;
  if (channelId.startsWith('dm_')) {
    const parts = channelId.slice(3).split('_');
    return parts.includes(String(currentUser.id || ''));
  }
  return false;
}

app.get(
  '/api/chat/channels',
  ensureAuth,
  asyncHandler(async (req, res) => {
    try {
      const currentUser = usersDB[req.user.email] || req.user;

      if (firebaseDb) {
        const snapshot = await firebaseDb.ref('chats').once('value');
        const chats = snapshot.val() || {};
        const channelIds = Object.keys(chats).filter((id) => isChannelVisibleToUser(currentUser, id));

        const channels = channelIds.map((id) => ({
          id,
          name: id,
          messageCount: Object.keys(chats[id] || {}).length
        }));

        if (!channels.some((c) => c.id === 'grade')) channels.push({ id: 'grade', name: 'grade', messageCount: 0 });
        return res.json(channels);
      }

      const files = (await fsPromises.readdir(PATHS.CHAT_DIR)).filter((f) => f.endsWith('.json'));
      const visibleFiles = files.filter((f) => isChannelVisibleToUser(currentUser, f.replace('.json', '')));

      const channels = await Promise.all(
        visibleFiles.map(async (f) => {
          const data = await safeReadJSON(path.join(PATHS.CHAT_DIR, f), { messages: [] });
          return { id: f.replace('.json', ''), name: f.replace('.json', ''), messageCount: data.messages.length };
        })
      );

      if (!channels.some((c) => c.id === 'grade')) channels.push({ id: 'grade', name: 'grade', messageCount: 0 });
      res.json(channels);
    } catch (err) {
      res.status(500).json({ error: 'Failed to read channels' });
    }
  })
);

app.get(
  '/api/chat/messages',
  ensureAuth,
  asyncHandler(async (req, res) => {
    const currentUser = usersDB[req.user.email] || req.user;
    const key = resolveChannelKey(currentUser, req.query.channel);
    if (!key) return res.status(403).json({ error: 'Forbidden' });

    if (firebaseDb) {
      try {
        const snapshot = await firebaseDb.ref(`chats/${key}`).once('value');
        const rawMsgs = snapshot.val() || {};
        const decrypted = Object.values(rawMsgs).map((m) => ({
          ...m,
          content: decrypt(m.content),
          isEdited: !!m.isEdited
        }));
        return res.json(decrypted);
      } catch (err) {
        console.error('[Firebase Chat Get Error]', err.message);
      }
    }

    const data = await readChannelData(key);
    const decrypted = data.messages.map((m) => ({
      ...m,
      content: decrypt(m.content),
      isEdited: !!m.isEdited
    }));
    res.json(decrypted);
  })
);

app.post(
  '/api/chat/messages',
  ensureAuth,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const currentUser = usersDB[req.user.email] || req.user;
    const key = resolveChannelKey(currentUser, req.query.channel);
    if (!key) return res.status(403).json({ error: 'Forbidden' });

    const { content } = req.body;
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'Message content is required' });
    }
    const trimmedContent = content.trim();
    if (trimmedContent.length > 4000) {
      return res.status(400).json({ error: 'Message content is too long (max 4000 chars)' });
    }

    const encryptedData = encrypt(trimmedContent);
    const newMessage = {
      id: Date.now().toString(),
      userId: currentUser.email,
      userName: currentUser.name,
      userPicture: currentUser.picture,
      content: encryptedData,
      timestamp: new Date().toISOString()
    };

    if (firebaseDb) {
      try {
        await firebaseDb.ref(`chats/${key}/${newMessage.id}`).set(newMessage);
        return res.json({ success: true, message: { ...newMessage, content: trimmedContent } });
      } catch (err) {
        console.error('[Firebase Chat Write Error]', err.message);
      }
    }

    const data = await readChannelData(key);
    data.messages.push(newMessage);
    await safeWriteJSON(getChannelFilePath(key), data);
    io.to(key).emit('newMessage', { ...newMessage, content: trimmedContent });
    res.json({ success: true, message: { ...newMessage, content: trimmedContent } });
  })
);

// --- [管理者向け API] ---
app.get('/api/admin/users', ensureAdmin, (req, res) => res.json(Object.values(usersDB)));

app.get('/api/admin/reports', ensureAdmin, asyncHandler(async (req, res) => {
  const reports = await safeReadJSON(PATHS.REPORTS, []);
  res.json(reports);
}));

app.get('/api/admin/logs', ensureAdmin, (req, res) => {
  res.json(systemLogs);
});

app.post(
  '/api/admin/settings/maintenance',
  ensureAdmin,
  asyncHandler(async (req, res) => {
    systemSettings.maintenanceMode = !!req.body.enabled;
    await safeWriteJSON(PATHS.SETTINGS, systemSettings);
    if (isGithubConfigured()) {
      await uploadJsonToGithub('settings.json', systemSettings, 'Toggle maintenance mode');
    }
    io.emit('systemSettingsUpdated', systemSettings);
    await addLog(req, 'maintenance_toggle', req.user.email, `Status: ${req.body.enabled}`);
    res.json({ success: true, maintenanceMode: systemSettings.maintenanceMode });
  })
);

app.post(
  '/api/admin/settings/offline',
  ensureAdmin,
  asyncHandler(async (req, res) => {
    const { title, subtitle, message, recoveryTime } = req.body;
    if (!systemSettings.offlineConfig) systemSettings.offlineConfig = {};

    if (title !== undefined) systemSettings.offlineConfig.title = title;
    if (subtitle !== undefined) systemSettings.offlineConfig.subtitle = subtitle;
    if (message !== undefined) systemSettings.offlineConfig.message = message;
    if (recoveryTime !== undefined) systemSettings.offlineConfig.recoveryTime = recoveryTime;

    await safeWriteJSON(PATHS.SETTINGS, systemSettings);
    if (isGithubConfigured()) {
      await uploadJsonToGithub('settings.json', systemSettings, 'Update offline settings');
    }
    io.emit('systemSettingsUpdated', systemSettings);
    await addLog(req, 'offline_config_update', req.user.email, 'Updated offline message config');

    res.json({ success: true, offlineConfig: systemSettings.offlineConfig });
  })
);

const ALLOWED_ROLES = ['admin', 'student'];
const ALLOWED_STATUSES = ['active', 'suspended'];
const FORBIDDEN_USER_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const hasUser = (email) => Object.prototype.hasOwnProperty.call(usersDB, email);

app.post('/api/admin/user/:email', ensureAdmin, asyncHandler(async (req, res) => {
  const email = decodeURIComponent(req.params.email);

  if (FORBIDDEN_USER_KEYS.has(email) || !hasUser(email)) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (isPrivilegedAdminEmail(email)) {
    return res.status(400).json({ error: 'Cannot modify the privileged admin account' });
  }

  const { userClass, role, status } = req.body;
  if (userClass !== undefined) {
    if (typeof userClass !== 'string' || userClass.length > 50) {
      return res.status(400).json({ error: 'Invalid userClass' });
    }
    usersDB[email].userClass = userClass;
  }
  if (role !== undefined) {
    if (!ALLOWED_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    usersDB[email].role = role;
  }
  if (status !== undefined) {
    if (!ALLOWED_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    usersDB[email].status = status;
  }
  await saveUsersDB();
  await addLog(req, 'user_update', req.user.email, `Updated target: ${email}`);
  res.json({ success: true });
}));

// --- [アカウント削除 API] ---
app.delete('/api/admin/user/:email', ensureAdmin, asyncHandler(async (req, res) => {
  const email = decodeURIComponent(req.params.email);

  if (FORBIDDEN_USER_KEYS.has(email) || !hasUser(email)) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (isPrivilegedAdminEmail(email)) {
    return res.status(400).json({ error: 'Cannot delete a privileged admin account' });
  }

  delete usersDB[email];
  await saveUsersDB();

  await addLog(req, 'user_delete', req.user.email, `Deleted target: ${email}`);
  res.json({ success: true });
}));

// --- [Socket.IO 接続リスナー] ---
io.on('connection', (socket) => {
  socket.on('joinChannel', (ch) => {
    const session = socket.request.session;
    const email = session?.passport?.user;
    const currentUser = email ? usersDB[email] : null;
    if (!currentUser) return;

    if (currentUser.status === 'suspended' && !isPrivilegedAdminEmail(currentUser.email)) return;

    const key = resolveChannelKey(currentUser, ch);
    if (!key) return;

    socket.rooms.forEach((r) => r !== socket.id && socket.leave(r));
    socket.join(key);
  });
});

// --- [404 & エラーハンドラー] ---
app.use((req, res, next) => {
  const err = new Error('Not Found');
  err.status = 404;
  next(err);
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 400 && status < 500) {
    console.warn(`[HTTP ${status}] ${req.method} ${req.url} - ${err.message}`);
  } else {
    console.error(`[System Error - ${status}] ${req.method} ${req.url}`, err.stack);
  }
  if (req.xhr || req.path.startsWith('/api/')) {
    return res.status(status).json({ error: err.message });
  }
  res.redirect('/offline.html');
});

// --- [サーバー非同期初期化 & 起動] ---
async function initServer() {
  try {
    await fsPromises.mkdir(DATA_DIR, { recursive: true });
    await fsPromises.mkdir(CHAT_DIR, { recursive: true });

    usersDB = await safeReadJSON(PATHS.USERS, defaultUsers);
    systemSettings = await safeReadJSON(PATHS.SETTINGS, {
      maintenanceMode: false,
      offlineConfig: {
        title: 'Maintenance',
        subtitle: '只今システムメンテナンス中です',
        message: 'サービス向上およびシステム保守のため、一時的に<strong>ログイン後の全機能</strong>を停止しております。<br>ご不便をおかけいたしますが、復旧までしばらくお待ちください。',
        recoveryTime: ''
      }
    });
    const loadedLogs = await safeReadJSON(PATHS.LOGS, []);
    systemLogs = Array.isArray(loadedLogs) ? loadedLogs.slice(0, MAX_LOGS_LIMIT) : [];

    if (isGithubConfigured()) {
      await syncWithGithub();
    }

    updateTransitCache();
    updateRoadCache();

    server.listen(PORT, () => {
      console.log(`[Server] Running on port ${PORT}`);
    });
  } catch (err) {
    console.error('[Server Init Error]:', err);
    process.exit(1);
  }
}

initServer();