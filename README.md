# Namiki-18th.github.io

Google OAuth 認証を用いた、学年内向けの連絡・チャット・カレンダー共有 Web アプリケーションです。Node.js (Express) + Socket.IO で構築されています。

## 目次

- [主な機能](#主な機能)
- [技術スタック](#技術スタック)
- [セットアップ](#セットアップ)
- [環境変数](#環境変数)
- [ディレクトリ構成](#ディレクトリ構成)
- [ルーティング一覧](#ルーティング一覧)
- [セキュリティ設計](#セキュリティ設計)
  - [Content Security Policy (CSP) と Nonce](#content-security-policy-csp-と-nonce)
  - [認証・認可](#認証認可)
  - [チャットのアクセス制御](#チャットのアクセス制御)
  - [その他のセキュリティ対策](#その他のセキュリティ対策)
- [開発時の注意点](#開発時の注意点)

## 主な機能

- Google アカウントによるログイン（学校ドメイン限定 + 管理者アカウント例外）
- お知らせ配信・カレンダー・時間割・Google Classroom 連携情報の閲覧
- リアルタイムチャット（学年全体 / クラス単位 / 個人間DM、Socket.IO）
- 管理者パネル（ユーザー権限管理、メンテナンスモード切り替え、アクセスログ閲覧）
- リアルタイム交通運行情報（JR常磐線・つくばエクスプレス・関鉄）
- メンテナンス（オフライン）モードとカスタムオフライン画面

## 技術スタック

| 分類 | 使用技術 |
|---|---|
| サーバー | Node.js, Express |
| リアルタイム通信 | Socket.IO |
| 認証 | Passport.js (Google OAuth 2.0), express-session |
| セキュリティ | Helmet (CSP nonce方式), express-rate-limit |
| 暗号化 | Node.js crypto (AES-256-GCM でチャット本文を暗号化保存) |
| データ永続化 | ローカル JSON ファイル（DB非使用） |
| フロントエンド | 素の HTML / CSS / JavaScript（フレームワーク不使用） |

## セットアップ

```bash
# 依存パッケージのインストール
npm install

# .env ファイルを作成し、下記「環境変数」を設定

# 開発・本番共通で起動
node server.js
```

デフォルトでは `http://localhost:3000` で起動します（`PORT` 環境変数で変更可）。

## 環境変数

`.env` ファイル（`dotenv` で読み込み）に以下を設定してください。

| 変数名 | 必須 | 説明 |
|---|---|---|
| `GOOGLE_CLIENT_ID` | ◯ | Google OAuth クライアントID |
| `GOOGLE_CLIENT_SECRET` | ◯ | Google OAuth クライアントシークレット |
| `GOOGLE_CALLBACK_URL` | 推奨 | OAuth コールバックURL（未設定時は `RENDER_EXTERNAL_URL` から自動生成、それも無ければ `http://localhost:3000/auth/google/callback`） |
| `SESSION_SECRET` | ◯（本番必須） | express-session の署名鍵。**未設定の場合、起動のたびにランダムな一時鍵が生成され、再起動でセッションが無効になります。** 公開リポジトリに固定値をコミットしないこと。 |
| `CHAT_ENCRYPTION_KEY` | ◯（本番必須） | チャット本文の AES-256-GCM 暗号化鍵（32byte を hex 文字列で指定）。**未設定の場合、起動のたびにランダムな一時鍵が生成され、再起動で過去のチャットが復号不能になります。** |
| `API_SECRET_KEY` | 任意 | `/api/classroom` への Webhook 投稿など、管理者ログイン無しで書き込みを許可するための API キー |
| `CORS_ORIGIN` | 任意 | 許可するオリジン（カンマ区切りで複数指定可）。未設定時はクロスオリジンリクエストを許可しません（同一オリジンの通常利用には影響なし） |
| `PORT` | 任意 | リッスンポート（デフォルト `3000`） |
| `NODE_ENV` | 任意 | `production` にすると Cookie の `secure` 属性等が有効化されます |
| `RENDER` / `RENDER_EXTERNAL_URL` | 任意 | Render.com へのデプロイ時に自動設定される変数。CORS・コールバックURLのデフォルト算出に使用 |

`CHAT_ENCRYPTION_KEY` の生成例:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## ディレクトリ構成

```
.
├── server.js              # Express アプリ本体（ルーティング・認証・Socket.IO・CSP設定）
├── public/                 # 静的ファイル配信ディレクトリ
│   ├── index.html           # ダッシュボード
│   ├── admin.html           # 管理者パネル
│   ├── calendar.html        # カレンダー
│   ├── chat.html            # チャット
│   ├── classroom.html       # Classroom連携情報
│   ├── link.html            # リンク集
│   ├── notice.html          # お知らせ
│   ├── report.html          # 報告フォーム
│   ├── privacy.html         # プライバシーポリシー
│   ├── terms.html           # 利用規約
│   ├── login.html           # ログイン画面
│   ├── offline.html         # メンテナンス表示画面
│   └── style.css            # 共通スタイルシート
├── users.json               # ユーザーDB（自動生成・自動保存）
├── notices.json              # お知らせデータ
├── classroom.json            # Classroom連携データ
├── settings.json              # システム設定（メンテナンスモード等）
├── logs.json                  # 管理者向けアクセスログ
├── chat/                       # チャンネルごとのチャットログ（暗号化して保存）
├── chat.log                    # （予約領域）
└── .env                          # 環境変数（Git管理対象外）
```

## ルーティング一覧

### 画面ルート（認証必須・`ensureAuth`）

`/index` `/terms` `/privacy` `/report` `/link` `/calendar` `/schedule` `/chat` `/notice` `/classroom`

### 画面ルート（管理者専用・`ensureAdmin`）

`/admin`

### 画面ルート（認証不要）

`/` `/login` `/login-deny` `/logout` `/offline` `/privacy-noauth` `/terms-noauth`

### 主な API

| メソッド | パス | 権限 | 概要 |
|---|---|---|---|
| GET | `/api/profile` | ログイン必須 | 自分のプロフィール取得 |
| GET | `/api/notices` | ログイン必須 | お知らせ一覧取得 |
| GET / POST | `/api/classroom` | 取得はログイン必須 / 投稿は管理者 or APIキー | Classroom連携データ |
| GET | `/api/offline/config` | 不要 | メンテナンス画面の表示設定取得 |
| GET | `/api/transit` | ログイン必須 | リアルタイム運行情報取得 |
| GET / POST | `/api/chat/channels`, `/api/chat/messages` | ログイン必須 | チャット機能（詳細は下記） |
| GET | `/api/admin/users`, `/api/admin/logs` | 管理者 | ユーザー一覧・アクセスログ取得 |
| POST | `/api/admin/settings/maintenance`, `/api/admin/settings/offline` | 管理者 | メンテナンスモード・オフライン画面設定変更 |
| POST | `/api/admin/user/:email` | 管理者 | ユーザーのクラス・権限・ステータス変更 |

## セキュリティ設計

### Content Security Policy (CSP) と Nonce

本アプリは **`'unsafe-inline'` を一切使用しない厳格な CSP** を採用しています。

- `server.js` はリクエストごとに `crypto.randomBytes(16)` で暗号学的に安全なランダム値を生成し、`res.locals.cspNonce` に格納します。
- Helmet の CSP ディレクティブ（`scriptSrc` / `styleSrc`）はこの nonce を関数形式で参照し、レスポンスヘッダーの `Content-Security-Policy` に都度異なる nonce を埋め込みます。
- `public/` 配下の HTML はビルド時の静的ファイルではなく、**`sendHtmlWithNonce()` ヘルパー経由で毎回読み込まれ**、ファイル内の `%%CSP_NONCE%%` プレースホルダーを実際の nonce に置換してから返されます。そのため `express.static` では `.html` を配信しないよう除外しています。
- 各 HTML ファイルの `<script>` / `<style>` タグには全て `nonce="%%CSP_NONCE%%"` が付与されています。
- インラインの `style="..."` 属性、および `onclick` / `onerror` / `onchange` / `oninput` などのインラインイベント属性は**全て排除**し、以下の方式に置き換えています。
  - `style="..."` → 一意な CSS クラス（例: `.gen-24b531`）として nonce 付き `<style>` ブロックに集約
  - `onclick="location.href='/xxx'"` → `data-href="/xxx"` 属性 + `document.querySelectorAll('[data-href]')` への `addEventListener` 一括登録
  - `onclick="switchTab('xxx')"` → `data-tab="xxx"` 属性 + 同様の一括登録
  - `onerror="..."`（画像読み込み失敗時のフォールバック）→ `js-logo-fallback` 等のクラスマーカー + `addEventListener('error', ...)`
  - 個別の関数呼び出し（`toggleTheme()` など）→ 要素に `id` を付与し、`initInlineEventReplacements()` 内で個別に `addEventListener`

新しい画面を追加する場合は、上記のパターンに従い **`style` 属性・インラインイベント属性を使用しない**でください。CSPが `'unsafe-inline'` を許可していないため、そのまま実装すると該当のスタイル・スクリプトはブラウザにブロックされます。

### 認証・認可

- Google OAuth 2.0（Passport.js）でログインし、学校ドメイン（`@namiki-cs.ibk.ed.jp`）に加えて特権管理者アカウント1件のみ許可
- セッションは `express-session` で管理し、`httpOnly` / `sameSite=lax` / 本番では `secure` Cookie
- `ensureAuth`（ログイン必須）・`ensureAdmin`（管理者専用）ミドルウェアで画面・APIともに保護
- 停止（`suspended`）ステータスのユーザーは自動的にアクセス拒否（特権管理者アカウントを除く）
- ロール（`admin` / `student`）・アカウントステータス（`active` / `suspended`）は許可された値のみ受け付けるバリデーションを実装

### チャットのアクセス制御

- チャンネルは `grade`（学年全体）・`class_<クラス名>`（クラス単位）・`dm_<ID1>_<ID2>`（個人間DM）の3種類
- クライアントが指定した `channel` パラメータをそのままファイル名に使わず、必ずサーバー側でログインユーザーの所属・IDと突き合わせて実チャンネルキーを算出（`resolveChannelKey`）。これにより他クラス・他人宛DMの閲覧・投稿を防止
- チャットメッセージ本文は AES-256-GCM で暗号化してファイルに保存
- Socket.IO の接続時も express-session を共有して認証状態を検証し、認可されたチャンネルにのみ `join` を許可

### その他のセキュリティ対策

- **レートリミット**: 全体（15分あたり600リクエスト/IP）、認証系（15分あたり20回）、書き込み系API（1分あたり30回）
- **入力バリデーション**: チャット投稿の文字数上限（4000文字）、Classroom連携データの件数上限（1000件）、ユーザー権限変更時の許可値チェック
- **タイミング攻撃対策**: APIキー比較に `crypto.timingSafeEqual` を使用した定数時間比較
- **秘密情報のハードコード禁止**: `SESSION_SECRET` / `CHAT_ENCRYPTION_KEY` が未設定の場合、固定値へのフォールバックは行わずランダムな一時鍵を生成し警告ログを出力（本番運用では必ず `.env` に設定すること）
- **safeWriteJSON**: JSON永続化は一時ファイル書き込み後にリネームすることで、書き込み中のクラッシュによるデータ破損を防止

## 開発時の注意点

- 静的アセット（CSS・画像・フォント）は `express.static` でそのまま配信されますが、**HTMLファイルは必ず `sendHtmlWithNonce()` を経由**させてください（nonce注入のため）。
- 新規画面追加時は `%%CSP_NONCE%%` プレースホルダーを `<script>` / `<style>` タグに付与することを忘れないでください。
- ローカル開発時、Google OAuth のコールバックURLは Google Cloud Console 側の設定と一致させる必要があります（`http://localhost:3000/auth/google/callback` 等）。
- `usersDB` はメモリ上にキャッシュされ `users.json` に随時保存されるため、複数プロセス・複数インスタンスでの水平スケールは非対応です（単一プロセス運用を前提とした設計）。

## リリースノート
コミット内容は機密情報保持及びセキュリティ対策として定期的にリセットされています。

3.4.2 ログシステムを改良しました
3.4.1 セキュリティを強化しました
3.4.0 noticeを中心に大幅な変更を加えました
3.3.4 ロガー機能を改善しました
3.3.3 セッション設定を変更しました
3.3.2 Cookie設定を見直しました
3.3.1 Firebaseを利用するように変更しました
3.3.0 Firebaseに移行しています
3.2.0 MongoDBを試験的に運用します
3.1.3 認証しています
3.1.2 OAuthの不具合を修正しています
3.1.1 不具合を修正しました
3.1.0 Firebaseにも対応させました
3.0.0 GitHubにストレージを移行しました。
2.12.6 ロールバックしました
2.12.5 ロールバックしています
2.12.4 reportを改善しています
2.12.3 セキュリティを堅牢にしました
2.12.2 プライバシーポリシーを改訂しました
2.12.1 Readmeを書きました。
2.12.0 CSPに完全対応させました。
2.11.8 CSPに対応させています…。
2.11.7 Update .gitignore
2.11.6 package-lock.jsonとpackage.jsonを変更しました
2.11.5 知らんけどセキュリティ爆上げしてもらった
2.11.4 リポートを改善しました。
2.11.3 重大なセキュリティ問題を修正しました
2.11.2 いくつかは知らんけどえぐい量のバグを修正した希ガス
2.11.1 いくつかの微調整をしています…
2.11.0 カレンダーを完成させました。
2.10.1 カレンダーを完成させています…。
2.10.0 時間割を完成させました。
2.9.3 時間割表のデータを整理しました。
2.9.2 リダイレクト問題を修正しています
2.9.1 バックエンドの致命的なエラーを修正しました。
2.9.0 HTMLを分離しています…
2.8.2 挙動を修正しています…
2.8.1 バックエンドの不具合を修正しました。
2.8.0 APIキーを追加しました。
2.7.4 サーバーの軽量化をしました
2.7.3 エラー処理をアップデートしました。
2.7.2 エラー処理を追加しました。
2.7.1 UIをさらに修正しました。
2.7.0 Classroomの機能追加をしています。
2.6.3 UIを修正しています…
2.6.2 書式設定の維持ができるように変更しています。
2.6.1 ClassroomのUIを修正しています。
2.6.0 Classroomのシステムを再構築しています。
2.5.4 致命的なエラーを修正しました。
2.5.3 【仮】修正のテストをしています。
2.5.2 致命的なバグが見つかったため、バージョンダウンしました。
2.5.1 ダミーデーター処理を削除し、絵文字をSVGへ移行しました。 ClassroomのページのUIを修正しました。
2.5.0 URL処理を加えました。
2.4.3 ClassroomのUIを改善しました。
2.4.2 Classroomを最新のGASスクリプトに適合させました。
2.4.1 Classroomのページや管理者設定を見直しました。
2.4.0 バックエンド及びフロントエンドに大幅な変更を加えました。
2.3.5 フロントエンドの修正を加えました。
2.3.4 バックエンドの修正をかけました。
2.3.3 privacy.htmlのJavaScriptのバグを改善しました。
2.3.2 privacy.htmlを独立させました。
2.3.1 プライバシーポリシーを分離しました。
2.3.0 ページの分離を開始しました。
2.2.9 ログイン画面のフッターを修正しました。
2.2.6 サイト名とファビコンの設定を変更しました。
2.2.5 バグを修正しました。
2.2.4 ロゴの修正を行いました。
2.2.3 Classroomのフロントエンドの修正。
2.2.2 UIの調整
2.2.1 容量制限のリミッターを1000倍に増やしました。
2.2.0 Classroomのスクレイピングをテストしています。
2.1.5 UIの修正
2.1.4 UIの修正
2.1.3 一部バグの修正
2.1.2 一部のバグを修正しました。
2.1.1 フッターの一部修正
2.1.0 メニューのUIに大幅な変更を加えました。
2.0.2 開発のために一時的にCSSをHTMLに統合しました。
2.0.1 一部スタイルの修正。
2.0.0 CSSを分離しました。
1.6.1 ロゴ付近のデザインを変更しました。
1.6.0 フロントエンドをバックエンドに対応させました。
1.5.1 学籍番号判定ロジックの実装。
1.5.0 機能を追加しました。
1.4.5 問題が見つかったため、元に戻しました。
1.4.4 問題が見つかったため、元に戻しました。
1.4.3 Update index.html
1.4.2 暗号化方式を強化しました。
1.4.1 セキュリティの問題を修正しました。
1.4.0 UIに大幅な変更を加えました。
1.3.0 アカウントを停止できるようになりました。
1.2.0 管理者権限を追加しました。
1.1.2 Server.jsに修正を加えました。
1.1.1 モジュールを追加しました。
1.1.0 Node.jsからServer.jsにファイル名を変更し、package.jsonのmainエントリとscriptsを更新しました。
1.0.7 Delete privacy.html
1.0.6 Delete index.html
1.0.5 Delete dashboard.html
1.0.4 Delete login.html
1.0.3 Add files via upload
1.0.2 Add files via upload
1.0.1 Add files via upload
1.0.0 Initial commit

©2026 Taichi Kimura. All rights reserved.
