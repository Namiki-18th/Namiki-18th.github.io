const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http'); // ★ Socket.io用に追加
const { Server } = require('socket.io'); // ★ Socket.ioのインポート
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
require('dotenv').config();

const app = express();
const server = http.createServer(app); // ★ ExpressをHTTPサーバーでラップ
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const port = process.env.PORT || 3000;

// Renderなどのリバースプロキシ環境で必須の設定
app.set('trust proxy', 1);

// --- 【JSONファイルによるユーザー管理】 ---
const USERS_FILE = path.join(__dirname, 'users.json');

// ユーザーDBの読み込み関数
function loadUsersDB() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = fs.readFileSync(USERS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('[Error] users.jsonの読み込みに失敗しました:', err);
  }
  
  // 初期データ（ファイルが存在しない場合）
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

// ユーザーDBの保存関数
function saveUsersDB(db) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('[Error] users.jsonの保存に失敗しました:', err);
  }
}

// アプリ起動時にロード
let usersDB = loadUsersDB();

// --- 【暗号化チャット保存用ディレクトリの設定】 ---
const CHAT_DIR = path.join(__dirname, 'chat');
if (!fs.existsSync(CHAT_DIR)) {
  fs.mkdirSync(CHAT_DIR, { recursive: true });
}

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID || 'demo-client-id',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'demo-client-secret',
    callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/google/callback'
  },
  (accessToken, refreshToken, profile, done) => {
    try {
      console.log('[OAuth Success] Googleからプロファイルを取得しました:', profile.id, profile.displayName);
      
      const email = (profile.emails && profile.emails[0] && profile.emails[0].value) || '';
      const allowedDomain = 'namiki-cs.ibk.ed.jp';

      // 特権ユーザー判定
      const isPrivilegedAdmin = (email === 'bme280.gac@gmail.com');

      // 指定ドメイン以外、かつ特権ユーザーでもない場合はログインを拒否
      if (!email.endsWith(`@${allowedDomain}`) && !isPrivilegedAdmin) {
        console.warn(`[OAuth Warning] 許可されていないドメインからのログイン試行です: ${email}`);
        return done(null, false, { message: `namiki-cs.ibk.ed.jp のメールアドレスのみログイン可能です。` });
      }

      // 既存の登録情報があるか確認
      let existingUser = usersDB[email];
      const isAdmin = isPrivilegedAdmin || email.startsWith('sato') || email.includes('admin') || (existingUser && existingUser.role === 'admin');

      // ★ bme280.gac@gmail.com の場合は名前を「管理者」，アイコンを "admin.png" に固定
      const name = isPrivilegedAdmin ? '管理者' : (profile.displayName || (existingUser ? existingUser.name : 'ユーザー'));
      const picture = isPrivilegedAdmin ? 'admin.png' : ((profile.photos && profile.photos[0] && profile.photos[0].value) || (existingUser ? existingUser.picture : ''));

      const user = {
        id: profile.id,
        name: name,
        email: email,
        picture: picture,
        userClass: existingUser ? existingUser.userClass : (isAdmin ? '教職員' : '3-A'),
        role: isAdmin ? 'admin' : 'student',
        status: existingUser ? (existingUser.status || 'active') : 'active' // ステータスを保持
      };

      // 変更を適用してファイルに保存
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

// ★ Socket.io でもセッション情報を共有できるように設定
io.engine.use(sessionMiddleware);

app.use(passport.initialize());
app.use(passport.session());

// --- 【認証・権限・サスペンドチェックミドルウェア】 ---

// アカウント停止（suspended）されていないかチェックするミドルウェア
function checkAccountStatus(req, res, next) {
  if (req.isAuthenticated() && req.user) {
    usersDB = loadUsersDB();
    const currentUser = usersDB[req.user.email];
    if (currentUser && currentUser.status === 'suspended') {
      // 管理者は原則停止されない想定だが、もし停止されていたらブロック
      if (req.xhr || req.path.startsWith('/api/')) {
        return res.status(403).json({ error: 'Suspended', message: 'このアカウントは停止されています。' });
      }
      // 停止画面へリダイレクト（もし専用のsuspended.html等があればそこに飛ばす）
      return res.redirect('/suspended.html');
    }
  }
  next();
}

app.use(checkAccountStatus); // 全リクエストでアカウント停止状態をチェック

function ensureApiAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized', message: 'ログインが必要です' });
}

function ensurePageAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.redirect('/login');
}

function ensureAdminAuthenticated(req, res, next) {
  if (req.isAuthenticated() && req.user && req.user.role === 'admin') {
    return next();
  }
  if (req.xhr || req.path.startsWith('/api/')) {
    return res.status(403).json({ error: 'Forbidden', message: '管理者権限が必要です' });
  }
  res.redirect('/index');
}

// --- 【ページ配信ルーティング】 ---

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
      console.error('[OAuth Error] Google callback 認証エラー:', err);
      return res.redirect('/login?error=auth_failed');
    }
    if (!user) {
      console.warn('[OAuth Warning] ドメイン制限によりアクセスが拒否されました。/login-denyへ遷移します');
      return res.redirect('/login-deny');
    }
    req.logIn(user, (loginErr) => {
      if (loginErr) {
        console.error('[OAuth Error] セッション確立エラー:', loginErr);
        return res.redirect('/login?error=session_error');
      }
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('[OAuth Error] セッション保存エラー:', saveErr);
          return res.redirect('/login?error=save_error');
        }
        console.log('[OAuth Success] ログイン成功、/index へ遷移します');
        return res.redirect('/index');
      });
    });
  })(req, res, next);
});

app.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => {
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

// --- 【一般 API エンドポイント】 ---

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


// --- 【暗号化チャット用 API エンドポイント】 ---

app.get('/api/chat', ensureApiAuthenticated, (req, res) => {
  const channel = req.query.channel || 'grade';
  const safeChannelName = channel.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(CHAT_DIR, `${safeChannelName}.json`);

  if (fs.existsSync(filePath)) {
    try {
      const data = fs.readFileSync(filePath, 'utf8');
      res.json(JSON.parse(data));
    } catch (e) {
      console.error('[Error] チャットファイルのパースに失敗しました:', e);
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
    } catch (e) {}
  }

  const newMessage = {
    sender: sender || req.user.name || 'ユーザー',
    encryptedText: encryptedText,
    timestamp: timestamp || new Date().toISOString()
  };

  chatData.messages.push(newMessage);

  try {
    fs.writeFileSync(filePath, JSON.stringify(chatData, null, 2), 'utf8');
    
    // ★ リアルタイム通知（同じチャンネルに参加しているクライアントへブロードキャスト）
    io.to(channel).emit('chatMessage', newMessage);

    res.json({ success: true });
  } catch (e) {
    console.error('[Error] チャットファイルの保存に失敗しました:', e);
    res.status(500).json({ error: 'Failed to save encrypted chat' });
  }
});


// --- 【Socket.io リアルタイム通信ロジック】 ---
io.on('connection', (socket) => {
  // 認証チェック
  const session = socket.request.session;
  if (!session || !session.passport || !session.passport.user) {
    socket.disconnect(true);
    return;
  }

  // チャンネルルームへの参加
  socket.on('joinChannel', (channel) => {
    // 以前のルームから退出
    Array.from(socket.rooms).forEach(room => {
      if (room !== socket.id) socket.leave(room);
    });
    socket.join(channel);
  });
});


// --- 【管理者用 API エンドポイント】 ---

app.get('/api/admin/users', ensureAdminAuthenticated, (req, res) => {
  usersDB = loadUsersDB();
  const userList = Object.values(usersDB).map(u => ({
    email: u.email,
    role: u.role || 'student',
    userClass: u.userClass || '未設定',
    name: u.name || 'ユーザー',
    status: u.status || 'active', // ステータスを送信
    picture: u.picture || ''
  }));
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
    if (status !== undefined) usersDB[targetEmail].status = status; // ステータスを更新
    if (picture !== undefined) usersDB[targetEmail].picture = picture;
    
    saveUsersDB(usersDB);

    res.json({ success: true, user: usersDB[targetEmail] });
  } else {
    res.status(404).json({ error: '指定されたメールアドレスのユーザーが見つかりません。' });
  }
});


app.use((req, res) => {
  res.status(404).send('404 Not Found');
});

// ★ server.listen に変更（HTTPサーバー経由で起動）
server.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});

module.exports = { app, server };