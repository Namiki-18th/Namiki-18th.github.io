# 並木中等教育学校18回生
## Namiki Secondary School 18th

**Google OAuth 2.0 同意画面 検証用ドキュメント**
**Document for Google OAuth 2.0 Consent Screen Verification (App Verification)**

| 項目 / Item | 内容 / Detail |
|---|---|
| サービス名 / Service Name | 並木中等教育学校18回生 (Namiki-18th) |
| 運営主体 / Operator | Taichi Kimura（個人運営 / Individually operated） |
| 対象校 / Target School | 茨城県立並木中等教育学校（Ibaraki Prefectural Namiki Secondary School） |
| 所在地 / School Address | 〒305-0044 茨城県つくば市並木4丁目5-1 |
| 問い合わせ先 / Contact Email | contact@namiki-18th.net |
| Google Cloud プロジェクトID / Project ID | `namiki-18th-506602` |
| Google Cloud プロジェクト番号 / Project Number | `769124929239` |
| 公開ランディングページ / Public Landing Page (this document) | https://about.namiki-18th.net/ |
| アプリケーション本体 / Application URL | https://namiki-18th.net/ |
| プライバシーポリシー / Privacy Policy | https://namiki-18th.net/privacy-noauth |
| 利用規約 / Terms of Service | https://namiki-18th.net/terms-noauth |
| 要求スコープ / Requested OAuth Scopes | `openid`, `email`, `profile` |
| 最終更新日 / Last Updated | 2026年9月6日 |

---

## Google 審査チームの皆様へ（English Summary for the Google Review Team）

This document describes **Namiki-18th**, a private, invitation-style community portal built for the alumni of a single graduating class ("18th generation") of **Ibaraki Prefectural Namiki Secondary School** (茨城県立並木中等教育学校), a public secondary school located at 〒305-0044 Namiki 4-5-1, Tsukuba, Ibaraki, Japan. The service is independently organized and operated by an alumnus (Taichi Kimura) and is **not an official school system**.

The application uses **Google OAuth 2.0 / OpenID Connect** solely to authenticate members against their Google account and to restrict access to verified alumni of the target class (plus one administrator account). It requests only the basic **`openid`, `email`, `profile`** scopes to identify the signed-in user and does **not** request any sensitive or restricted scope.

All public traffic is delivered through **Cloudflare** (DNS, CDN, TLS termination, and edge/WAF protection) before reaching either the static landing page (GitHub Pages) or the application server. A full technical dossier — architecture diagrams, source-code structure, and screen-flow documentation — was submitted as a **supplementary ZIP attachment** together with the OAuth verification application; this public page is intentionally a summarized, non-sensitive overview for anonymous visitors and reviewers. Full details on data handling and Limited Use compliance are provided in the **Security & Data Protection** section below, in both Japanese and English.

---

## 目次 / Table of Contents

1. [サービス概要 (Overview)](#サービス概要-overview)
2. [学校との関係について (Affiliation Disclaimer)](#学校との関係について-affiliation-disclaimer)
3. [主な機能 (Key Features)](#主な機能-key-features)
4. [インフラ・システム構成 (Architecture & Cloudflare Integration)](#インフラシステム構成-architecture--cloudflare-integration)
5. [サイトマップ (Site Map)](#サイトマップ-site-map)
6. [セキュリティ & データ保護方針 (Security & Data Protection)](#セキュリティ--データ保護方針-security--data-protection)
7. [利用規約 & プライバシーポリシー (Terms & Privacy Policy)](#利用規約--プライバシーポリシー-terms--privacy-policy)
8. [お問い合わせ (Contact)](#お問い合わせ-contact)
9. [改訂履歴 (Revision History)](#改訂履歴-revision-history)

---

## サービス概要 (Overview)

**Namiki-18th** は、茨城県立並木中等教育学校のある学年（18回生）の卒業生・在校生コミュニティ専用に開発された、招待制のクローズドなWebポータルです。学年内の連絡事項・カレンダー・時間割・チャットなど、限定されたメンバー間の情報共有を目的としており、不特定多数への公開は行っていません。

対象ユーザーは、学校が発行するメールドメイン（`@namiki-cs.ibk.ed.jp`）を保有する当該学年の在校生・卒業生に限定されます。Googleアカウントでのログインを必須とすることで、なりすましや部外者のアクセスを防ぎ、学年内の情報共有という課題を安全に解決します。

*This is a closed, invitation-style portal for a single graduating class of Ibaraki Prefectural Namiki Secondary School. It centralizes announcements, a shared calendar, class schedules, and internal chat for verified members only, and is not intended for the general public. Access is restricted to holders of the school's official email domain, verified through Google Sign-In.*

---

## 学校との関係について (Affiliation Disclaimer)

| 項目 / Item | 内容 / Detail |
|---|---|
| 対象校 / Target School | 茨城県立並木中等教育学校 (Ibaraki Prefectural Namiki Secondary School) |
| 所在地 / Address | 〒305-0044 茨城県つくば市並木4丁目5-1 |

本サービスは、上記学校の特定の学年（18回生）の卒業生有志によって**独立して運営される非公式のコミュニティサービス**であり、学校当局・学校法人による公式な運営・監修・承認を受けたものではありません。ログイン制限に使用している学校発行のメールドメインは、あくまで対象学年の在籍・卒業確認の手段として利用しているものであり、学校が本サービスの提供主体であることを意味するものではありません。

*This service is an independent, unofficial community platform organized and operated by volunteer alumni of a specific graduating class ("18th generation") of the school named above. It is not officially operated, endorsed, or supervised by the school or any school authority. The school-issued email domain is used solely as a means of verifying membership in the target graduating class, and its use does not imply that the school is the provider of this service.*

---

## 主な機能 (Key Features)

- **Google OAuth 2.0 統合認証**：学校ドメイン限定 + 管理者アカウント例外による安全なログイン
- **ダッシュボード & 情報共有**：お知らせ・時間割・Google Classroom連携情報など、ユーザー専用ページの閲覧
- **カレンダー共有**：学年行事・イベントの一覧表示
- **通知・リマインド機能**：更新情報のお知らせ配信
- **リアルタイムチャット**：学年全体 / クラス単位 / 個人間のメッセージ共有（暗号化保存）
- **管理者パネル**：権限管理・メンテナンスモード切り替えなど、限定された管理機能
- **交通運行情報**：通学に関わる公共交通機関のリアルタイム情報表示

---

## インフラ・システム構成 (Architecture & Cloudflare Integration)

本サービスは、すべての通信を **Cloudflare（DNS / CDN / WAF / Edge Security / SSL・TLS終端）** を経由して配信しており、エンドユーザーとオリジンサーバーの間に多層的な防御層を設けています。公開ランディングページは **GitHub Pages** 上で静的ホスティングされ、アプリケーション本体は独立したアプリケーションサーバー上で稼働します。

*All traffic to this service passes through Cloudflare (DNS / CDN / WAF / Edge Security / TLS termination) before reaching either the static landing page (hosted on GitHub Pages) or the application origin server.*

```
+-----------+        HTTPS         +--------------------------------+
|  Browser  |---------------------->|           Cloudflare            |
| (Client)  |                       |  DNS / CDN / WAF / TLS Term.     |
+-----------+                       |  Edge Security & DDoS Mitigation |
                                     +----------------+-----------------+
                                                       |
                          +----------------------------+----------------------------+
                          |                                                         |
                          v                                                         v
           +---------------------------------+                     +---------------------------------+
           |     公開LP / Landing Page         |                     |    アプリ本体 / Main Application  |
           |     about.namiki-18th.net         |                     |    namiki-18th.net                |
           |     (GitHub Pages / 静的配信)       |                     |    (Node.js / Express / Socket.IO)|
           +---------------------------------+                     +----------------+------------------+
                                                                                      |
                                                                                      | OAuth 2.0 / OpenID Connect
                                                                                      v
                                                                       +---------------------------------+
                                                                       |     Google Identity Platform      |
                                                                       |     (Google OAuth 2.0 / OIDC)      |
                                                                       +---------------------------------+
```

> **添付資料について / Note on Supplementary Materials**
> より詳細な構成、画面遷移図、ソース資料につきましては、OAuth審査用に別途提出した添付のZIPファイル（添付資料）をご参照ください。
> *For a more detailed architecture, screen-flow diagrams, and source materials, please refer to the supplementary ZIP file submitted separately with this OAuth verification application.*

---

## サイトマップ (Site Map)

### 公開LP / Public Landing Page — `about.namiki-18th.net`

```
about.namiki-18th.net/
├── index.html          # トップページ（サービス概要・審査用README案内）
└── README.md            # 本ドキュメント（このページ）
```

### アプリ本体 / Main Application — `namiki-18th.net`

```
namiki-18th.net/
├── /                    # トップ（未ログイン時はログイン画面へ誘導）
├── /login               # Googleログイン開始
├── /login-deny          # アクセス拒否画面（対象外ドメイン等）
├── /logout              # ログアウト
├── /index               # ダッシュボード（要ログイン）
├── /notice              # お知らせ（要ログイン）
├── /calendar            # カレンダー（要ログイン）
├── /schedule            # 時間割（要ログイン）
├── /classroom           # Google Classroom 連携情報（要ログイン）
├── /chat                # リアルタイムチャット（要ログイン）
├── /link                # リンク集（要ログイン）
├── /report              # 報告・お問い合わせフォーム（要ログイン）
├── /admin               # 管理者パネル（管理者権限のみ）
├── /privacy-noauth      # プライバシーポリシー（未ログイン閲覧可）
├── /terms-noauth        # 利用規約（未ログイン閲覧可）
└── /offline             # メンテナンス表示画面
```

---

## セキュリティ & データ保護方針 (Security & Data Protection)

### Google API サービスデータポリシーへの準拠 (Compliance with Google API Services User Data Policy)

本アプリケーションおよびその開発者は、**Google API サービスデータポリシー（Google API Services User Data Policy）**、および該当する場合の**限定使用要件（Limited Use Requirements）**を遵守します。Google APIから取得したユーザーデータの利用は、本アプリがユーザーに提供する機能の実現に必要な範囲に厳格に限定されます。

*This application and its developer comply with the **Google API Services User Data Policy**, including the **Limited Use requirements** where applicable. Data obtained through Google APIs is used strictly to provide and improve the user-facing features of this application, and for no other purpose.*

### 取得データと利用目的 (Data Collected & Purpose)

| 取得データ / Data | スコープ / Scope | 利用目的 / Purpose |
|---|---|---|
| Googleアカウント一意識別子 / Google Account ID | `openid` | 本人確認・ログインセッションの管理 / Authenticate the user and manage the login session |
| メールアドレス / Email Address | `email` | 学校ドメインによるアクセス可否判定、本人特定 / Verify eligibility via school domain and identify the account |
| 氏名・プロフィール画像 / Name & Profile Picture | `profile` | ダッシュボード・チャット等での表示名・アイコン表示 / Display name and avatar within the dashboard and chat |

上記以外の個人データは取得しません。

*No personal data beyond the items listed above is collected via Google OAuth.*

### 第三者提供・目的外利用の禁止 (No Third-Party Sharing or Secondary Use)

- 取得したユーザーデータを**第三者へ販売・提供することはありません**。
- 取得したユーザーデータを**広告目的で利用・共有することはありません**。
- 取得したユーザーデータを**AI／機械学習モデルの学習・トレーニングに使用することはありません**。
- データは本アプリが提供する機能（認証・表示・アクセス制御）以外の目的には使用しません。

*User data obtained via Google OAuth is never sold or shared with third parties, never used or shared for advertising purposes, and never used to train AI or machine learning models. Data is used exclusively to operate the authentication, display, and access-control features described in this document.*

### 通信の暗号化とデータ安全管理 (Encryption & Data Security)

- クライアント・サーバー間のすべての通信は、Cloudflareが提供する **HTTPS / TLS** により暗号化されています。
- サーバー内で保持する機密性の高い情報は、業界標準の暗号化方式により保護された状態で保存されます。
- Cloudflareのエッジセキュリティ機能（WAF・DDoS防御等）により、不正アクセス・攻撃からサービス基盤を保護しています。

*All communication between clients and the server is encrypted in transit via HTTPS/TLS through Cloudflare. Sensitive data held on the server side is protected using industry-standard encryption at rest. Cloudflare's edge security features (WAF, DDoS mitigation) protect the service infrastructure from unauthorized access and attacks.*

### データの保持・削除 (Data Retention & Deletion)

ユーザーは、お問い合わせ窓口（contact@namiki-18th.net）よりアカウント削除・データ消去を申請できます。申請を受理した開発者は、本人確認の上、対象アカウントに紐づくデータをシステムから速やかに削除します。

*Users may request account and data deletion by contacting **contact@namiki-18th.net**. Upon receiving and verifying such a request, the developer will promptly delete the data associated with that account from the system.*

---

## 利用規約 & プライバシーポリシー (Terms & Privacy Policy)

- プライバシーポリシー / Privacy Policy: [https://namiki-18th.net/privacy-noauth](https://namiki-18th.net/privacy-noauth)
- 利用規約 / Terms of Service: [https://namiki-18th.net/terms-noauth](https://namiki-18th.net/terms-noauth)

---

## お問い合わせ (Contact)

| 項目 / Item | 内容 / Detail |
|---|---|
| 運営者 / Operator | Taichi Kimura |
| メールアドレス / Email | contact@namiki-18th.net |
| Google Cloud プロジェクトID / Project ID | `namiki-18th-506602` |
| Google Cloud プロジェクト番号 / Project Number | `769124929239` |

---

## 改訂履歴 (Revision History)

- **3.4.2** ログシステムを改良しました
- **3.4.1** セキュリティを強化しました
- **3.4.0** noticeを中心に大幅な変更を加えました
- **3.3.4** ロガー機能を改善しました
- **3.3.3** セッション設定を変更しました
- **3.3.2** Cookie設定を見直しました
- **3.3.1** Firebaseを利用するように変更しました
- **3.3.0** Firebaseに移行しています
- **3.2.0** MongoDBを試験的に運用します
- **3.1.3** 認証しています
- **3.1.2** OAuthの不具合を修正しています
- **3.1.1** 不具合を修正しました
- **3.1.0** Firebaseにも対応させました
- **3.0.0** GitHubにストレージを移行しました。
- **2.12.6** ロールバックしました
- **2.12.5** ロールバックしています
- **2.12.4** reportを改善しています
- **2.12.3** セキュリティを堅牢にしました
- **2.12.2** プライバシーポリシーを改訂しました
- **2.12.1** Readmeを書きました。
- **2.12.0** CSPに完全対応させました。
- **2.11.8** CSPに対応させています…。
- **2.11.7** Update .gitignore
- **2.11.6** package-lock.jsonとpackage.jsonを変更しました
- **2.11.5** 知らんけどセキュリティ爆上げしてもらった
- **2.11.4** リポートを改善しました。
- **2.11.3** 重大なセキュリティ問題を修正しました
- **2.11.2** いくつかは知らんけどえぐい量のバグを修正した希ガス
- **2.11.1** いくつかの微調整をしています…
- **2.11.0** カレンダーを完成させました。
- **2.10.1** カレンダーを完成させています…。
- **2.10.0** 時間割を完成させました。
- **2.9.3** 時間割表のデータを整理しました。
- **2.9.2** リダイレクト問題を修正しています
- **2.9.1** バックエンドの致命的なエラーを修正しました。
- **2.9.0** HTMLを分離しています…
- **2.8.2** 挙動を修正しています…
- **2.8.1** バックエンドの不具合を修正しました。
- **2.8.0** APIキーを追加しました。
- **2.7.4** サーバーの軽量化をしました
- **2.7.3** エラー処理をアップデートしました。
- **2.7.2** エラー処理を追加しました。
- **2.7.1** UIをさらに修正しました。
- **2.7.0** Classroomの機能追加をしています。
- **2.6.3** UIを修正しています…
- **2.6.2** 書式設定の維持ができるように変更しています。
- **2.6.1** ClassroomのUIを修正しています。
- **2.6.0** Classroomのシステムを再構築しています。
- **2.5.4** 致命的なエラーを修正しました。
- **2.5.3** 【仮】修正のテストをしています。
- **2.5.2** 致命的なバグが見つかったため、バージョンダウンしました。
- **2.5.1** ダミーデーター処理を削除し、絵文字をSVGへ移行しました。 ClassroomのページのUIを修正しました。
- **2.5.0** URL処理を加えました。
- **2.4.3** ClassroomのUIを改善しました。
- **2.4.2** Classroomを最新のGASスクリプトに適合させました。
- **2.4.1** Classroomのページや管理者設定を見直しました。
- **2.4.0** バックエンド及びフロントエンドに大幅な変更を加えました。
- **2.3.5** フロントエンドの修正を加えました。
- **2.3.4** バックエンドの修正をかけました。
- **2.3.3** privacy.htmlのJavaScriptのバグを改善しました。
- **2.3.2** privacy.htmlを独立させました。
- **2.3.1** プライバシーポリシーを分離しました。
- **2.3.0** ページの分離を開始しました。
- **2.2.9** ログイン画面のフッターを修正しました。
- **2.2.6** サイト名とファビコンの設定を変更しました。
- **2.2.5** バグを修正しました。
- **2.2.4** ロゴの修正を行いました。
- **2.2.3** Classroomのフロントエンドの修正。
- **2.2.2** UIの調整
- **2.2.1** 容量制限のリミッターを1000倍に増やしました。
- **2.2.0** Classroomのスクレイピングをテストしています。
- **2.1.5** UIの修正
- **2.1.4** UIの修正
- **2.1.3** 一部バグの修正
- **2.1.2** 一部のバグを修正しました。
- **2.1.1** フッターの一部修正
- **2.1.0** メニューのUIに大幅な変更を加えました。
- **2.0.2** 開発のために一時的にCSSをHTMLに統合しました。
- **2.0.1** 一部スタイルの修正。
- **2.0.0** CSSを分離しました。
- **1.6.1** ロゴ付近のデザインを変更しました。
- **1.6.0** フロントエンドをバックエンドに対応させました。
- **1.5.1** 学籍番号判定ロジックの実装。
- **1.5.0** 機能を追加しました。
- **1.4.5** 問題が見つかったため、元に戻しました。
- **1.4.4** 問題が見つかったため、元に戻しました。
- **1.4.3** Update index.html
- **1.4.2** 暗号化方式を強化しました。
- **1.4.1** セキュリティの問題を修正しました。
- **1.4.0** UIに大幅な変更を加えました。
- **1.3.0** アカウントを停止できるようになりました。
- **1.2.0** 管理者権限を追加しました。
- **1.1.2** Server.jsに修正を加えました。
- **1.1.1** モジュールを追加しました。
- **1.1.0** Node.jsからServer.jsにファイル名を変更し、package.jsonのmainエントリとscriptsを更新しました。
- **1.0.7** Delete privacy.html
- **1.0.6** Delete index.html
- **1.0.5** Delete dashboard.html
- **1.0.4** Delete login.html
- **1.0.3** Add files via upload
- **1.0.2** Add files via upload
- **1.0.1** Add files via upload
- **1.0.0** Initial commit

---

©2026 Taichi Kimura. All rights reserved.