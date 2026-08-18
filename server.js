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
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const port = process.env.PORT || 3000;

// Renderなどのリバースプロキシ環境に必要な設定
app.set('trust proxy', 1);

// Body パーサー設定（JSONおよびURLエンコード）
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// --- [ファイル保存ヘルパー（データ破損防止：Atomic Write）] ---
function safeWriteFileSync(filePath, data) {
  const tempPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    if (fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (_) {}
    }
    throw err;
  }
}

// --- [ファイル・ディレクトリパス設定] ---
const USERS_FILE = path.join(__dirname, 'users.json');
const NOTICES_FILE = path.join(__dirname, 'notices.json');
const CHAT_DIR = path.join(__dirname, 'chat');
const CHAT_LOG_FILE = path.join(__dirname, 'chat.log');

if (!fs.existsSync(CHAT_DIR)) {
  fs.mkdirSync(CHAT_DIR, { recursive: true });
  console.log(`[System] Created chat directory at: ${CHAT_DIR}`);
}

// --- [AES-256-GCM 強力暗号化 / 復号処理] ---
const rawKey = process.env.CHAT_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const ENCRYPTION_KEY = Buffer.from(rawKey, 'hex');

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return {
    iv: iv.toString('hex'),
    content: encrypted,
    tag: authTag
  };
}

function decrypt(encryptedObj) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    ENCRYPTION_KEY,
    Buffer.from(encryptedObj.iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(encryptedObj.tag, 'hex'));
  let decrypted = decipher.update(encryptedObj.content, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// --- [chat.log 記録ヘルパー] ---
function appendChatLog(timestamp, sender, recipient, content) {
  const logLine = `${timestamp}\t${sender}\t${recipient}\t${content}\n`;
  try {
    fs.appendFileSync(CHAT_LOG_FILE, logLine, 'utf8');
  } catch (err) {
    console.error('[Error] Failed to write to chat.log:', err);
  }
}

// --- [ユーザーDB (JSONファイル)] ---
function loadUsersDB() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = fs.readFileSync(USERS_FILE, 'utf8');
      console.log('[System] User database loaded successfully.');
      const parsedDB = JSON.parse(data);

      // 特権管理者の保護保証
      if (parsedDB['bme280.gac@gmail.com']) {
        parsedDB['bme280.gac@gmail.com'].role = 'admin';
        parsedDB['bme280.gac@gmail.com'].status = 'active';
      }
      return parsedDB;
    }
  } catch (err) {
    console.error('[Error] Failed to read users.json:', err);
  }
  
  console.log('[System] Initializing default user database...');
  const initialData = {
    'bme280.gac@gmail.com': { 
      id: 'Admin', 
      name: '管理者', 
      email: 'bme280.gac@gmail.com', 
      userClass: '管理者', 
      role: 'admin',
      status: 'active',
      picture: 'admin.png'
    }
  };
  saveUsersDB(initialData);
  return initialData;
}

function saveUsersDB(db) {
  try {
    // 保存時にも特権管理者のステータスを強制保護
    if (db['bme280.gac@gmail.com']) {
      db['bme280.gac@gmail.com'].role = 'admin';
      db['bme280.gac@gmail.com'].status = 'active';
    }
    safeWriteFileSync(USERS_FILE, db);
    console.log('[System] User database saved successfully.');
  } catch (err) {
    console.error('[Error] Failed to save users.json:', err);
  }
}

let usersDB = loadUsersDB();

// --- [お知らせ・Classroomデータ保存用 (JSONファイル)] ---
function loadNoticesDB() {
  try {
    if (fs.existsSync(NOTICES_FILE)) {
      const data = fs.readFileSync(NOTICES_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('[Error] Failed to read notices.json:', err);
  }
  const initialNotices = [
    { id: 1, title: '7月月末テストについて', date: '2024-07-13', priority: 'high', content: '7月月末テストは7月25日(木)～7月26日(金)に実施されます。範囲表を確認してください。', icon: '📝' },
    { id: 2, title: '夏休みの宿題について', date: '2024-07-12', priority: 'normal', content: '夏休みの宿題リストを配布しました。提出期限は8月30日(金)です。', icon: '📚' }
  ];
  saveNoticesDB(initialNotices);
  return initialNotices;
}

function saveNoticesDB(notices) {
  try {
    safeWriteFileSync(NOTICES_FILE, notices);
  } catch (err) {
    console.error('[Error] Failed to save notices.json:', err);
  }
}

let noticesDB = loadNoticesDB();

// --- [Passport / Google OAuth 設定] ---
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID || 'demo-client-id',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'demo-client-secret',
    callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/google/callback'
  },
  (accessToken, refreshToken, profile, done) => {
    try {
      console.log(`[OAuth Success] Profile fetched: ID=${profile.id}, Name=${profile.displayName}`);
      
      const email = (profile.emails && profile.emails[0] && profile.emails[0].value) || '';
      const allowedDomain = 'namiki-cs.ibk.ed.jp';
      const isPrivilegedAdmin = (email === 'bme280.gac@gmail.com');

      if (!email.endsWith(`@${allowedDomain}`) && !isPrivilegedAdmin) {
        console.warn(`[OAuth Warning] Unauthorized domain attempt: ${email}`);
        return done(null, false, { message: `Only email addresses ending with namiki-cs.ibk.ed.jp are allowed.` });
      }

      let existingUser = usersDB[email];
      const isAdmin = isPrivilegedAdmin || email.startsWith('sato') || email.includes('admin') || (existingUser && existingUser.role === 'admin');

      const name = isPrivilegedAdmin ? '管理者' : (profile.displayName || (existingUser ? existingUser.name : 'ユーザー'));
      const picture = isPrivilegedAdmin ? 'admin.png' : ((profile.photos && profile.photos[0] && profile.photos[0].value) || (existingUser ? existingUser.picture : ''));

      let userId;
      if (isAdmin) {
        userId = 'Admin';
      } else {
        let extractedId = null;
        try {
          const unlock = require('./unlock');
          if (unlock && typeof unlock.getStudentNumber === 'function') {
            extractedId = unlock.getStudentNumber(profile.displayName);
          }
        } catch (e) {
          console.warn('[System] unlock.js error:', e.message);
        }
        userId = (extractedId && extractedId !== '不明') ? extractedId : 'Unknown';
      }

      // クラス名の決定ロジック：管理者以外は id の先頭2文字
      let userClass;
      if (isAdmin) {
        userClass = isPrivilegedAdmin ? '管理者' : '教職員';
      } else {
        userClass = (userId && userId !== 'Unknown' && userId.length >= 2) ? userId.substring(0, 2) : '未設定';
      }

      // ステータスの決定：特権管理者は常に active
      let userStatus = isPrivilegedAdmin ? 'active' : (existingUser ? (existingUser.status || 'active') : 'active');

      const user = {
        id: userId,
        name: name,
        email: email,
        picture: picture,
        userClass: userClass,
        role: isAdmin ? 'admin' : 'student',
        status: userStatus
      };

      usersDB[email] = user;
      saveUsersDB(usersDB);

      return done(null, user);
    } catch (err) {
      console.error('[OAuth Strategy Error]:', err);
      return done(err, null);
    }
  }
));

passport.serializeUser((user, done) => {
  done(null, user.email);
});

passport.deserializeUser((email, done) => {
  usersDB = loadUsersDB();
  const user = usersDB[email] || { email, name: 'ユーザー', role: 'student', userClass: '未設定', status: 'active', picture: '' };
  done(null, user);
});

// --- [セッションミドルウェア] ---
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

app.use(passport.initialize());
app.use(passport.session());

// --- [アカウント状態・アクセス制御ミドルウェア] ---
function checkAccountStatus(req, res, next) {
  if (req.isAuthenticated() && req.user) {
    usersDB = loadUsersDB();
    const currentUser = usersDB[req.user.email];
    
    // bme280.gac@gmail.com は絶対に停止扱いにしない
    if (currentUser && currentUser.status === 'suspended' && req.user.email !== 'bme280.gac@gmail.com') {
      console.warn(`[Access Denied] Suspended user attempted access: ${req.user.email}`);
      if (req.xhr || req.path.startsWith('/api/')) {
        return res.status(403).json({ error: 'Suspended', message: 'This account has been suspended.' });
      }
      return res.redirect('/suspended.html');
    }
  }
  next();
}

app.use(checkAccountStatus);

function ensureApiAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
}

function ensurePageAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

function ensureAdminAuthenticated(req, res, next) {
  if (req.isAuthenticated() && req.user && req.user.role === 'admin') return next();
  if (req.xhr || req.path.startsWith('/api/')) {
    return res.status(403).json({ error: 'Forbidden', message: 'Admin privileges required' });
  }
  res.redirect('/index');
}

// --- [ページルーティング] ---
app.get('/', (req, res) => res.redirect(req.isAuthenticated() ? '/index' : '/login'));
app.get('/login', (req, res) => req.isAuthenticated() ? res.redirect('/index') : res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/login-deny', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login-deny.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback', (req, res, next) => {
  passport.authenticate('google', (err, user) => {
    if (err) return res.redirect('/login?error=auth_failed');
    if (!user) return res.redirect('/login-deny');
    req.logIn(user, (loginErr) => {
      if (loginErr) return res.redirect('/login?error=session_error');
      req.session.save(() => res.redirect('/index'));
    });
  })(req, res, next);
});

app.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => res.redirect('/login'));
  });
});

app.get('/index', ensurePageAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', ensurePageAuthenticated, (req, res) => res.redirect('/index'));
app.get('/admin', ensureAdminAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// --- [Classroom / GAS連携エンドポイント] ---
app.post('/api/classroom', (req, res) => {
  try {
    const { title, content, description, dueDate, receivedAt } = req.body;
    console.log(`[Classroom/GAS API] Received payload:`, req.body);

    const itemTitle = title || 'Google Classroom 更新';
    const itemContent = content || description || '新しい投稿がありました。詳細はClassroomを確認してください。';
    const dateStr = receivedAt ? new Date(receivedAt).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

    const newNotice = {
      id: Date.now(),
      title: itemTitle,
      date: dateStr,
      priority: 'high',
      content: itemContent,
      icon: '🏫',
      dueDate: dueDate || null
    };

    noticesDB = loadNoticesDB();
    noticesDB.unshift(newNotice);
    saveNoticesDB(noticesDB);

    io.emit('newNotice', newNotice);
    console.log(`[Classroom/GAS API] Successfully added notice & broadcasted: "${itemTitle}"`);

    res.status(200).json({ status: 'success', message: 'Notice received and broadcasted', notice: newNotice });
  } catch (err) {
    console.error('[Classroom/GAS API Error]:', err);
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

// --- [一般 API エンドポイント] ---
app.get('/api/profile', ensureApiAuthenticated, (req, res) => {
  usersDB = loadUsersDB();
  res.json(usersDB[req.user.email] || req.user);
});

app.get('/api/notices', ensureApiAuthenticated, (req, res) => {
  noticesDB = loadNoticesDB();
  res.json(noticesDB);
});

app.get('/api/schedule', ensureApiAuthenticated, (req, res) => {
  const schedule = [
    { id: 1, day: '月', time: '9:00-9:50', subject: '数学', room: 'A-102', teacher: '田中先生' },
    { id: 2, day: '月', time: '10:00-10:50', subject: '英語', room: 'B-201', teacher: '佐藤先生' }
  ];
  res.json(schedule);
});

app.get('/api/links', ensureApiAuthenticated, (req, res) => {
  const links = [
    { id: 1, category: '学習', name: 'Google Classroom', url: 'https://classroom.google.com', icon: '📝', description: '担任からの連絡・課題配布' }
  ];
  res.json(links);
});

app.get('/api/calendar', ensureApiAuthenticated, (req, res) => {
  const events = [
    { date: '2024-07-25', title: '月末テスト(1日目)', type: 'exam' }
  ];
  res.json(events);
});

// --- [暗号化チャット API エンドポイント] ---
app.get('/api/chat', ensureApiAuthenticated, (req, res) => {
  const channel = req.query.channel || 'grade';
  const safeChannelName = channel.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(CHAT_DIR, `${safeChannelName}.json`);

  if (fs.existsSync(filePath)) {
    try {
      const data = fs.readFileSync(filePath, 'utf8');
      const chatData = JSON.parse(data);

      const decryptedMessages = chatData.messages.map(msg => ({
        sender: msg.sender,
        recipient: msg.recipient,
        text: decrypt(msg.encryptedData),
        timestamp: msg.timestamp
      }));

      res.json({ channel: channel, messages: decryptedMessages });
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse or decrypt chat data' });
    }
  } else {
    res.json({ channel: channel, messages: [] });
  }
});

app.post('/api/chat', ensureApiAuthenticated, (req, res) => {
  const { channel, sender, recipient, text, timestamp } = req.body;
  if (!channel || !text) return res.status(400).json({ error: 'Missing required fields' });

  const safeChannelName = channel.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(CHAT_DIR, `${safeChannelName}.json`);
  const messageTime = timestamp || new Date().toISOString();
  const senderName = sender || req.user.name || 'ユーザー';
  const targetRecipient = recipient || channel;

  const encryptedPayload = encrypt(text);

  let chatData = { channel: channel, messages: [] };
  if (fs.existsSync(filePath)) {
    try {
      chatData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.error(`[Error] Reading chat file:`, e);
    }
  }

  const newMessage = {
    sender: senderName,
    recipient: targetRecipient,
    encryptedData: encryptedPayload,
    timestamp: messageTime
  };

  chatData.messages.push(newMessage);

  try {
    safeWriteFileSync(filePath, chatData);
    appendChatLog(messageTime, senderName, targetRecipient, text);

    io.to(channel).emit('chatMessage', {
      sender: senderName,
      recipient: targetRecipient,
      text: text,
      timestamp: messageTime
    });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save encrypted chat' });
  }
});

// --- [Socket.io リアルタイム通信制御] ---
io.on('connection', (socket) => {
  const session = socket.request.session;
  if (!session || !session.passport || !session.passport.user) {
    console.warn(`[Socket.io] Unauthenticated connection attempt rejected: Socket ID ${socket.id}`);
    socket.disconnect(true);
    return;
  }

  console.log(`[Socket.io] Client connected: Socket ID ${socket.id}, User: ${session.passport.user}`);

  socket.on('joinChannel', (channel) => {
    Array.from(socket.rooms).forEach(room => {
      if (room !== socket.id) socket.leave(room);
    });
    socket.join(channel);
  });

  socket.on('disconnect', () => {
    console.log(`[Socket.io] Client disconnected: Socket ID ${socket.id}`);
  });
});

// --- [管理者 API エンドポイント] ---
app.get('/api/admin/users', ensureAdminAuthenticated, (req, res) => {
  usersDB = loadUsersDB();
  const userList = Object.values(usersDB).map(u => ({
    email: u.email,
    role: u.role || 'student',
    userClass: u.userClass || '未設定',
    name: u.name || 'ユーザー',
    status: u.status || 'active',
    picture: u.picture || ''
  }));
  res.json(userList);
});

app.post('/api/admin/user/:email', ensureAdminAuthenticated, (req, res) => {
  const targetEmail = decodeURIComponent(req.params.email);
  let { userClass, role, name, status, picture } = req.body;

  usersDB = loadUsersDB();

  if (usersDB[targetEmail]) {
    // bme280.gac@gmail.com の変更制限
    if (targetEmail === 'bme280.gac@gmail.com') {
      if (status === 'suspended') {
        return res.status(400).json({ error: 'Forbidden', message: 'Primary admin account cannot be suspended.' });
      }
      role = 'admin';
      status = 'active';
    }

    if (userClass !== undefined) usersDB[targetEmail].userClass = userClass;
    if (role !== undefined) usersDB[targetEmail].role = role;
    if (name !== undefined) usersDB[targetEmail].name = name;
    if (status !== undefined) usersDB[targetEmail].status = status;
    if (picture !== undefined) usersDB[targetEmail].picture = picture;
    
    saveUsersDB(usersDB);
    res.json({ success: true, user: usersDB[targetEmail] });
  } else {
    res.status(404).json({ error: 'Specified user email not found.' });
  }
});

app.use((req, res) => {
  res.status(404).send('404 Not Found');
});

// サーバー起動
server.listen(port, () => {
  console.log(`[Server] Server is running at http://localhost:${port}`);
});

module.exports = { app, server };