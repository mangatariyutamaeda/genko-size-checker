# CLAUDE.md — 原稿サイズチェッカー（genko-size-checker）

> **共通ルールの正本**: `mangatari-business-master-lib/docs/mangatari-gas-common-rules.md`（アクセス制御標準・テスト慣習・clasp/デプロイの地雷・依頼にはURLを付ける など）。共通の話はそちらだけを直す。

## これは何か
Google Drive 上の画像(TIFF/JPEG)の寸法・DPI・カラーモード・拡張子を、取引先マスタの条件と照合する社内ツール。フォルダ単位のファイルセット整合性チェック（重複・欠番・psd突合）と CSV/PDF 出力もある。
姉妹ツール: 合本版チェッカー（`gappon-checker`、2026-09-16 に先に GAS へ移行済み）。

## いまの状態: GitHub Pages 版と GAS 版の並行稼働（2026-09-16〜）
| | GitHub Pages 版（旧） | GAS 版（新） |
|---|---|---|
| 場所 | リポジトリ直下 `index.html` | `gas/`（`gas/src/*`） |
| URL | https://mangatariyutamaeda.github.io/genko-size-checker/ | https://script.google.com/macros/s/AKfycbyriLDw7s9N2ND-xkuWMealmPQu-K-8SnXD3wNIYXqpeaNdpNTTrCvEhPJLPmNHQbM-9A/exec |
| 入れる人 | URLを知っている人なら画面は誰でも開ける。データは OAuth テストユーザー＋マスタの共有で制限 | people-hub「ツール利用状況」の `genko-size-checker` 行 → allowedEmails（登録された人だけ） |
| ログイン | 画面の「Googleでログイン」(GIS)。トークンは localStorage | 開いた時点で Google アカウントを確認（ボタンなし） |
| 画像の読み方 | ブラウザから Drive API で先頭部分を部分取得 | サーバ(Code.gs)が本人の権限で先頭64KBを並列に部分取得し、足りない位置だけ読み足す |
| 取引先マスタ | `1QnYqQA7NpSkhuC5dUL8klBaeTQc2EjYDcACROG3OBRU`（**両方の版で同じシート**） | 同じ |
| ログイン履歴・アクセス申請・Slack通知 | あり（Webhook URL を base64 で埋め込み） | なし（申請はポータルの「利用を申請」、マスタ読み込みエラーは連絡文をコピーして Slack に貼る） |

- **旧版は触らない**（直すなら両方）。判定ロジック（`checkDimension` / `judgeDpi` / `computeSetChecks` など）は `index.html` と `gas/src/index.html` に同じものがある。画像の解析（`parseTiffSpec` / `parseJpegSpec`）は GAS 版ではサーバ側 `gas/src/Code.gs` の `parseTiffSpec_` / `parseJpegSpec_` に移した
- ポータルのカードはまだ旧版URL。切り替えるときにポータルの `DEFAULT_TOOLS` を差し替える

### 切り替え手順（GAS版で問題なければ）
1. 前田さんが GAS 版URLを一度開く（初回だけ「アクセスを許可」→ allowedEmails 作成・同期・定期同期トリガーまで自動）
2. people-hub「ツール利用状況」に利用者の `genko-size-checker` 行があるか確認し、実際の納品フォルダで旧版と結果が同じか見る
3. ポータル（`mangatari-portal/src/Config.gs`）のカードURLを GAS 版に差し替えて本番デプロイ
4. 旧版を止める: GitHub Pages を無効化 → `gas/` の中身をリポジトリ直下へ移す → リポジトリを private に（旧版の Webhook URL が履歴に残っているため）

## GAS 版の構成（gas/）
```
gas/.clasp.json       scriptId 1iOuhTTw24NDP3x8P4KfBfZ-QSwNNoH7oTfJ11LHzWwReZYmZI8gsKCKr / rootDir src
gas/src/appsscript.json  USER_ACCESSING + ANYONE / AccessControl @9 / oauthScopes 明示(Driveは drive.readonly)
gas/src/Config.gs     ツール名・ADMIN_EMAILS・DB(原稿サイズチェッカー DB 1XrbOQtg…)・マスタID・解析の上限値
gas/src/Code.gs       doGet(入口ゲート) / api_listFolders / api_inspectImages / api_loadMaster・api_saveMasterRow・api_deleteMasterRow
gas/src/PeopleHubSync.gs  people-hub → allowedEmails 同期、初回セットアップ(ensureInitialSetup_)、トリガー
gas/src/index.html    画面。判定・整合性チェック・CSV/PDF はブラウザ側
gas/tests/            checker.test.mjs(画面側・index.html から関数抽出) / server.test.mjs(サーバ側・vm+モック)
```
- デプロイ: `npm test` → `cd gas && npx @google/clasp@3 push -f && npx @google/clasp@3 deploy -i AKfycbyriLDw7s9N2ND-xkuWMealmPQu-K-8SnXD3wNIYXqpeaNdpNTTrCvEhPJLPmNHQbM-9A -d "..."`（引数なしの deploy はURLが変わるので使わない）
- `mangatari-access-control-lib/release.sh` の CONSUMERS に `genko-size-checker/gas` を追加済み
- DBスプレッドシートは `clasp create --type sheets --parentId` で作ったので、中に空のコンテナバインドスクリプトが付いている（害は無い）

## ルール
- 画面側ロジックは `function 名前(...)` で書く（テストが関数名で抽出する）。メインの `<script>` は `<script>\n'use strict';` で始める
- **末尾「_」の無いサーバ関数は google.script.run から誰でも呼べる。** 画面用APIは冒頭で `requireAllowed_()`、管理用は `requireAdmin_()`
- Drive/スプレッドシートに触るのはサーバ側だけ。ユーザー入力のIDは正規表現で検証してからURLに入れる（Driveの検索クエリに混ぜない）
- GAS の `getContent()` は -128〜127 のバイト配列。`new Uint8Array(...)` に入れて 0〜255 にしてから読む
- GASの画面は iframe の中: リンクは `<base target="_blank">`、コピーは `copyText()`、自分のURLは `BOOT.toolUrl`
- UI・コメント・コミットメッセージは日本語。利用者はエンジニアではない
- テスト: `npm test`（旧版134件＋GAS版 画面側・サーバ側）。push・デプロイ前に必ず通す

## 右上（GAS版）
- 共通部品 `AccessControl.headerKit`（共通ルール 11章。2026-09-18 本番@6・ライブラリ @9）: `headerKitHtml_` が氏名+⚙（ポータルへ・問い合わせ=`SLACK_CHANNEL`・使い方=画面内の使い方ガイドを開く `MgtHeader.onHelp`・再読み込み）を出す。部品が出なかったときだけ「ログイン中: メール」（`#accountFallback`）
- 問い合わせは `#dev_原稿サイズチェッカー`（ID `C0BS10YPM6X`）。**2026-09-23 にメインPCからIDを受け取り、名前リンク（`app_redirect`。開けないことがある）からIDリンクへ切り替えた**: `gas/src/Config.gs` の `SLACK_CHANNEL_ID` を `headerKit` に `slackChannelId` として渡す（合本版チェッカーと同じ形。名前は表示ラベルとして併せて渡す）
- ⚙の「再読み込み」は部品の既定（`toolUrl` を開き直す）のまま。この画面はURLに指定（`?…`）を取らないので、いまのURLと同じになる
