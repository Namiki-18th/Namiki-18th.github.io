const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http'); // Added for Socket.io
const { Server } = require('socket.io'); // Socket.io import
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
require('dotenv').config();

const app = express();
const server = http.createServer(app); // Wrap Express with HTTP server
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const port = process.env.PORT || 3000;

// Required setting for reverse proxy environments like Render
app.set('trust proxy', 1);

// --- [User Management via JSON File] ---
const USERS_FILE = path.join(__dirname, 'users.json');

// Function to load User DB
function loadUsersDB() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = fs.readFileSync(USERS_FILE, 'utf8');
      console.log('[System] User database loaded successfully.');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('[Error] Failed to read users.json:', err);
  }
  
  // Initial data if file does not exist
  console.log('[System] Initializing default user database...');
  const initialData = {
    'bme280.gac@gmail.com': { 
      id: 'bme280_admin', 
      name: '管理者', 
      email: 'bme280.gac@gmail.com', 
      userClass: '特権管理者', 
      role: 'admin',
      status: 'active',
      picture: 'admin.png'
    }
  };
  saveUsersDB(initialData);
  return initialData;
}

// Function to save User DB
function saveUsersDB(db) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(db, null, 2), 'utf8');
    console.log('[System] User database saved successfully.');
  } catch (err) {
    console.error('[Error] Failed to save users.json:', err);
  }
}

// Load DB at application startup
let usersDB = loadUsersDB();

// --- [Encrypted Chat Storage Directory Configuration] ---
const CHAT_DIR = path.join(__dirname, 'chat');
if (!fs.existsSync(CHAT_DIR)) {
  fs.mkdirSync(CHAT_DIR, { recursive: true });
  console.log(`[System] Created chat directory at: ${CHAT_DIR}`);
}

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID || 'demo-client-id',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'demo-client-secret',
    callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/google/callback'
  },
  (accessToken, refreshToken, profile, done) => {
    try {
      console.log(`[OAuth Success] Profile fetched from Google: ID=${profile.id}, Name=${profile.displayName}`);
      
      const email = (profile.emails && profile.emails[0] && profile.emails[0].value) || '';
      const allowedDomain = 'namiki-cs.ibk.ed.jp';

      // Privileged user check
      const isPrivilegedAdmin = (email === 'bme280.gac@gmail.com');

      // Reject login if domain does not match and user is not privileged
      if (!email.endsWith(`@${allowedDomain}`) && !isPrivilegedAdmin) {
        console.warn(`[OAuth Warning] Unauthorized domain login attempt: ${email}`);
        return done(null, false, { message: `Only email addresses ending with namiki-cs.ibk.ed.jp are allowed to log in.` });
      }

      // Check for existing registration
      let existingUser = usersDB[email];
      const isAdmin = isPrivilegedAdmin || email.startsWith('sato') || email.includes('admin') || (existingUser && existingUser.role === 'admin');

      // Set fixed name and icon for bme280.gac@gmail.com
      const name = isPrivilegedAdmin ? '管理者' : (profile.displayName || (existingUser ? existingUser.name : 'ユーザー'));
      const picture = isPrivilegedAdmin ? 'admin.png' : ((profile.photos && profile.photos[0] && profile.photos[0].value) || (existingUser ? existingUser.picture : ''));

      const user = {
        id: profile.id,
        name: name,
        email: email,
        picture: picture,
        userClass: existingUser ? existingUser.userClass : (isAdmin ? '教職員' : '3-A'),
        role: isAdmin ? 'admin' : 'student',
        status: existingUser ? (existingUser.status || 'active') : 'active'
      };

      // Apply changes and persist to file
      usersDB[email] = user;
      saveUsersDB(usersDB);

      console.log(`[OAuth] User authenticated and profile updated: ${email}`);
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

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

// Share session middleware with Socket.io
io.engine.use(sessionMiddleware);

app.use(passport.initialize());
app.use(passport.session());

// --- [Authentication, Authorization, and Account Status Middlewares] ---

function checkAccountStatus(req, res, next) {
  if (req.isAuthenticated() && req.user) {
    usersDB = loadUsersDB();
    const currentUser = usersDB[req.user.email];
    if (currentUser && currentUser.status === 'suspended') {
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
  if (req.isAuthenticated()) {
    return next();
  }
  console.warn(`[API Access Denied] Unauthenticated request to: ${req.originalUrl}`);
  res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
}

function ensurePageAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  console.warn(`[Page Access Denied] Unauthenticated request to: ${req.originalUrl}`);
  res.redirect('/login');
}

function ensureAdminAuthenticated(req, res, next) {
  if (req.isAuthenticated() && req.user && req.user.role === 'admin') {
    return next();
  }
  console.warn(`[Admin Access Denied] Non-admin user attempted access: ${req.user ? req.user.email : 'Unauthenticated'}`);
  if (req.xhr || req.path.startsWith('/api/')) {
    return res.status(403).json({ error: 'Forbidden', message: 'Admin privileges required' });
  }
  res.redirect('/index');
}

// --- [Page Routes] ---

app.get('/', (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect('/index');
  }
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect('/index');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/login-deny', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login-deny.html'));
});

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback', (req, res, next) => {
  passport.authenticate('google', (err, user, info) => {
    if (err) {
      console.error('[OAuth Error] Google callback authentication failed:', err);
      return res.redirect('/login?error=auth_failed');
    }
    if (!user) {
      console.warn('[OAuth Warning] Access denied due to domain restrictions. Redirecting to /login-deny');
      return res.redirect('/login-deny');
    }
    req.logIn(user, (loginErr) => {
      if (loginErr) {
        console.error('[OAuth Error] Session initialization failed:', loginErr);
        return res.redirect('/login?error=session_error');
      }
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('[OAuth Error] Session save failed:', saveErr);
          return res.redirect('/login?error=save_error');
        }
        console.log(`[OAuth Success] User ${user.email} logged in successfully. Redirecting to /index`);
        return res.redirect('/index');
      });
    });
  })(req, res, next);
});

app.get('/logout', (req, res, next) => {
  const userEmail = req.user ? req.user.email : 'Unknown user';
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => {
      console.log(`[Logout] User logged out: ${userEmail}`);
      res.redirect('/login');
    });
  });
});

app.get('/index', ensurePageAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', ensurePageAuthenticated, (req, res) => {
  res.redirect('/index');
});

app.get('/admin', ensureAdminAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// --- [General API Endpoints] ---

app.get('/api/profile', ensureApiAuthenticated, (req, res) => {
  usersDB = loadUsersDB();
  res.json(usersDB[req.user.email] || req.user);
});

app.get('/api/schedule', ensureApiAuthenticated, (req, res) => {
  const schedule = [
    { id: 1, day: '月', time: '9:00-9:50', subject: '数学', room: 'A-102', teacher: '田中先生' },
    { id: 2, day: '月', time: '10:00-10:50', subject: '英語', room: 'B-201', teacher: '佐藤先生' },
    { id: 3, day: '月', time: '11:00-11:50', subject: '国語', room: 'A-102', teacher: '鈴木先生' },
    { id: 4, day: '月', time: '13:00-13:50', subject: '理科', room: 'C-101', teacher: '山田先生' },
    { id: 5, day: '月', time: '14:00-14:50', subject: '社会', room: 'A-102', teacher: '小林先生' },
    { id: 6, day: '火', time: '9:00-9:50', subject: '国語', room: 'A-102', teacher: '鈴木先生' },
    { id: 7, day: '火', time: '10:00-10:50', subject: '理科', room: 'C-101', teacher: '山田先生' },
    { id: 8, day: '火', time: '11:00-11:50', subject: '体育', room: 'C-301', teacher: '山口先生' },
    { id: 9, day: '火', time: '13:00-13:50', subject: '数学', room: 'A-102', teacher: '田中先生' },
    { id: 10, day: '火', time: '14:00-14:50', subject: '音楽', room: 'B-105', teacher: '中村先生' },
  ];
  res.json(schedule);
});

app.get('/api/notices', ensureApiAuthenticated, (req, res) => {
  const notices = [
    { id: 1, title: '7月月末テストについて', date: '2024-07-13', priority: 'high', content: '7月月末テストは7月25日(木)～7月26日(金)に実施されます。範囲表を確認してください。', icon: '📝' },
    { id: 2, title: '夏休みの宿題について', date: '2024-07-12', priority: 'normal', content: '夏休みの宿題リストを配布しました。提出期限は8月30日(金)です。', icon: '📚' },
    { id: 3, title: '学校祭の参加について', date: '2024-07-10', priority: 'normal', content: '今年の学校祭は9月15日(日)に開催予定です。クラスの出し物を決めてください。', icon: '🎉' },
    { id: 4, title: '健康診断実施日程', date: '2024-07-08', priority: 'normal', content: '定期健康診断を7月17日(水)に実施します。午前中に受診してください。', icon: '🏥' },
    { id: 5, title: '図書館の蔵書検索システムが新しくなりました', date: '2024-07-05', priority: 'low', content: 'より使いやすい検索システムに更新されました。ぜひご利用ください。', icon: '📖' },
  ];
  res.json(notices);
});

app.get('/api/links', ensureApiAuthenticated, (req, res) => {
  const links = [
    { id: 1, category: '学習', name: '学校LMS', url: 'https://lms.school.edu', icon: '📚', description: '授業資料やレポート提出用システム' },
    { id: 2, category: '学習', name: 'Google Classroom', url: 'https://classroom.google.com', icon: '📝', description: '担任からの連絡・課題配布' },
    { id: 3, category: '図書館', name: '図書館蔵書検索', url: 'https://library.school.edu', icon: '📖', description: '学校図書館の蔵書を検索' },
    { id: 4, category: '学校情報', name: '学校ホームページ', url: 'https://school.edu', icon: '🏫', description: '学校の公式情報サイト' },
    { id: 5, category: '学校情報', name: '校舎案内', url: 'https://school.edu/facility', icon: '🗺️', description: '校舎の配置図・施設情報' },
    { id: 6, category: '行事', name: '年間行事予定', url: 'https://school.edu/schedule', icon: '📅', description: '学校の年間行事予定表' },
    { id: 7, category: '連絡先', name: '学校電話番号', url: 'tel:03-1234-5678', icon: '☎️', description: '学校代表電話' },
    { id: 8, category: 'その他', name: 'Zoom接続ガイド', url: 'https://school.edu/zoom-guide', icon: '💻', description: 'オンライン授業の接続方法' },
  ];
  res.json(links);
});

app.get('/api/calendar', ensureApiAuthenticated, (req, res) => {
  const events = [
    { date: '2024-07-15', title: '開校記念日', type: 'holiday' },
    { date: '2024-07-22', title: '海の日', type: 'holiday' },
    { date: '2024-07-25', title: '月末テスト(1日目)', type: 'exam' },
    { date: '2024-07-26', title: '月末テスト(2日目)', type: 'exam' },
    { date: '2024-08-10', title: 'お盆休み', type: 'holiday' },
    { date: '2024-09-15', title: '学校祭', type: 'event' },
    { date: '2024-10-12', title: '体育大会', type: 'event' },
  ];
  res.json(events);
});

// --- [Encrypted Chat API Endpoints] ---

app.get('/api/chat', ensureApiAuthenticated, (req, res) => {
  const channel = req.query.channel || 'grade';
  const safeChannelName = channel.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(CHAT_DIR, `${safeChannelName}.json`);

  if (fs.existsSync(filePath)) {
    try {
      const data = fs.readFileSync(filePath, 'utf8');
      res.json(JSON.parse(data));
    } catch (e) {
      console.error(`[Error] Failed to parse chat file for channel '${safeChannelName}':`, e);
      res.status(500).json({ error: 'Failed to parse chat data' });
    }
  } else {
    res.json({ channel: channel, messages: [] });
  }
});

app.post('/api/chat', ensureApiAuthenticated, (req, res) => {
  const { channel, sender, encryptedText, timestamp } = req.body;
  if (!channel || !encryptedText) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const safeChannelName = channel.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(CHAT_DIR, `${safeChannelName}.json`);

  let chatData = { channel: channel, messages: [] };
  if (fs.existsSync(filePath)) {
    try {
      chatData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.error(`[Error] Failed to read existing chat data for '${safeChannelName}':`, e);
    }
  }

  const newMessage = {
    sender: sender || req.user.name || 'ユーザー',
    encryptedText: encryptedText,
    timestamp: timestamp || new Date().toISOString()
  };

  chatData.messages.push(newMessage);

  try {
    fs.writeFileSync(filePath, JSON.stringify(chatData, null, 2), 'utf8');
    
    // Broadcast via Socket.io to users in the same channel
    io.to(channel).emit('chatMessage', newMessage);
    console.log(`[Socket.io] Broadcasted new chat message to channel: ${channel}`);

    res.json({ success: true });
  } catch (e) {
    console.error(`[Error] Failed to save chat file for channel '${safeChannelName}':`, e);
    res.status(500).json({ error: 'Failed to save encrypted chat' });
  }
});

// --- [Socket.io Real-time Logic] ---

io.on('connection', (socket) => {
  const session = socket.request.session;
  if (!session || !session.passport || !session.passport.user) {
    console.warn(`[Socket.io] Unauthenticated connection attempt rejected: Socket ID ${socket.id}`);
    socket.disconnect(true);
    return;
  }

  console.log(`[Socket.io] Client connected: Socket ID ${socket.id}, User: ${session.passport.user}`);

  socket.on('joinChannel', (channel) => {
    // Leave previous channel rooms
    Array.from(socket.rooms).forEach(room => {
      if (room !== socket.id) socket.leave(room);
    });
    socket.join(channel);
    console.log(`[Socket.io] Socket ${socket.id} joined channel: ${channel}`);
  });

  socket.on('disconnect', () => {
    console.log(`[Socket.io] Client disconnected: Socket ID ${socket.id}`);
  });
});

// --- [Admin API Endpoints] ---

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
  console.log(`[Admin] User list retrieved by ${req.user.email}`);
  res.json(userList);
});

app.post('/api/admin/user/:email', ensureAdminAuthenticated, (req, res) => {
  const targetEmail = decodeURIComponent(req.params.email);
  const { userClass, role, name, status, picture } = req.body;

  usersDB = loadUsersDB();

  if (usersDB[targetEmail]) {
    if (userClass !== undefined) usersDB[targetEmail].userClass = userClass;
    if (role !== undefined) usersDB[targetEmail].role = role;
    if (name !== undefined) usersDB[targetEmail].name = name;
    if (status !== undefined) usersDB[targetEmail].status = status;
    if (picture !== undefined) usersDB[targetEmail].picture = picture;
    
    saveUsersDB(usersDB);
    console.log(`[Admin] Updated user profile for: ${targetEmail} by Admin ${req.user.email}`);

    res.json({ success: true, user: usersDB[targetEmail] });
  } else {
    console.warn(`[Admin Warning] Update failed. Target user not found: ${targetEmail}`);
    res.status(404).json({ error: 'Specified user email not found.' });
  }
});

app.use((req, res) => {
  console.warn(`[404 Not Found] Request path: ${req.originalUrl}`);
  res.status(404).send('404 Not Found');
});

// Start HTTP Server
server.listen(port, () => {
  console.log(`[Server] Server is running at http://localhost:${port}`);
});

module.exports = { app, server };