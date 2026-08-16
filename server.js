const express = require('express');
const path = require('path');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

const users = new Map();

// Passportの設定
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID || 'demo-client-id',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'demo-client-secret',
    callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/google/callback'
  },
  (accessToken, refreshToken, profile, done) => {
    // ユーザー情報をデータベースに保存（ここではメモリーに保存）
    const user = {
      id: profile.id,
      name: profile.displayName,
      email: profile.emails[0].value,
      picture: profile.photos[0]?.value || ''
    };
    users.set(profile.id, user);
    return done(null, user);
  }
));

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser((id, done) => {
  const user = users.get(id);
  done(null, user);
});

// ミドルウェア設定
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production', // HTTPSを使用している場合のみtrueに
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24時間
  }
}));

app.use(passport.initialize());
app.use(passport.session());

// 認証チェック用ミドルウェア
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.redirect('/login');
}

// ルート
app.get('/', (req, res) => {
  if (req.isAuthenticated()) {
    res.redirect('/dashboard');
    return;
  }
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  if (req.isAuthenticated()) {
    res.redirect('/dashboard');
    return;
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// プライバシーポリシー
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

// Google OAuth認証ルート
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login' }),
  (req, res) => {
    // 認証成功後、ダッシュボードにリダイレクト
    res.redirect('/dashboard');
  }
);

// ログアウト
app.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.redirect('/login');
  });
});


app.get('/dashboard', ensureAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/api/profile', ensureAuthenticated, (req, res) => {
  res.json(req.user);
});

// 時間割/授業スケジュール
app.get('/api/schedule', ensureAuthenticated, (req, res) => {
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

// お知らせ/通知
app.get('/api/notices', ensureAuthenticated, (req, res) => {
  const notices = [
    { id: 1, title: '7月月末テストについて', date: '2024-07-13', priority: 'high', content: '7月月末テストは7月25日(木)～7月26日(金)に実施されます。範囲表を確認してください。', icon: '📝' },
    { id: 2, title: '夏休みの宿題について', date: '2024-07-12', priority: 'normal', content: '夏休みの宿題リストを配布しました。提出期限は8月30日(金)です。', icon: '📚' },
    { id: 3, title: '学校祭の参加について', date: '2024-07-10', priority: 'normal', content: '今年の学校祭は9月15日(日)に開催予定です。クラスの出し物を決めてください。', icon: '🎉' },
    { id: 4, title: '健康診断実施日程', date: '2024-07-08', priority: 'normal', content: '定期健康診断を7月17日(水)に実施します。午前中に受診してください。', icon: '🏥' },
    { id: 5, title: '図書館の蔵書検索システムが新しくなりました', date: '2024-07-05', priority: 'low', content: 'より使いやすい検索システムに更新されました。ぜひご利用ください。', icon: '📖' },
  ];
  res.json(notices);
});

// リンクのまとめ
app.get('/api/links', ensureAuthenticated, (req, res) => {
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

// カレンダーイベント
app.get('/api/calendar', ensureAuthenticated, (req, res) => {
  const year = req.query.year || new Date().getFullYear();
  const month = req.query.month || new Date().getMonth() + 1;
  
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

app.use((req, res) => {
  res.status(404).send('404 Not Found');
});

const server = app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});

module.exports = { app, server };