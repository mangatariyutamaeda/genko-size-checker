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
gas/src/appsscript.json  USER_ACCESSING + ANYONE / AccessControl @13 + BusinessMaster @11 / oauthScopes 明示(Driveは drive.readonly)
gas/src/Config.gs     ツール名・ADMIN_EMAILS・DB(原稿サイズチェッカー DB 1XrbOQtg…)・マスタID・解析の上限値・自動チェックと通知の設定
gas/src/Judge.gs      🚩**判定ロジックの正本**。拡張子/寸法/DPI/カラー/ファイルセット整合性・取引先マスタ行→条件
gas/src/Code.gs       doGet(入口ゲート) / api_listFolders / api_inspectImages / api_setChecks / api_loadMaster・api_saveMasterRow・api_deleteMasterRow
gas/src/AutoCheck.gs  写植データの自動チェック(毎晩2:00の runAutoCheck)。対象作品の割り出し→差分→判定→記録
gas/src/Notify.gs     Slack通知(Botトークン)。投稿とメンション解決(people-hub)、作品chの解決(business-hub)
gas/src/PeopleHubSync.gs  people-hub → allowedEmails 同期、初回セットアップ(ensureInitialSetup_)、トリガー
gas/src/index.html    画面。表示・CSV/PDF。判定はサーバ(api_inspectImages / api_setChecks)に頼む
gas/tests/            judge.test.mjs(判定の正本) / checker.test.mjs(画面側・index.html から関数抽出)
                      server.test.mjs(サーバ側・vm+モック) / autocheck.test.mjs(自動チェック・通しの結合テストあり)
```
- デプロイ: `npm test` → `cd gas && npx @google/clasp@3 push -f && npx @google/clasp@3 deploy -i AKfycbyriLDw7s9N2ND-xkuWMealmPQu-K-8SnXD3wNIYXqpeaNdpNTTrCvEhPJLPmNHQbM-9A -d "..."`（引数なしの deploy はURLが変わるので使わない）
- `mangatari-access-control-lib/release.sh` と `mangatari-business-master-lib/release.sh` の CONSUMERS に `genko-size-checker/gas` を追加済み（ライブラリ更新がここにも配られる）
- DBスプレッドシートは `clasp create --type sheets --parentId` で作ったので、中に空のコンテナバインドスクリプトが付いている（害は無い）

## 写植データの自動チェック（2026-10-02〜）
コミックシーモアの連載中作品の写植フォルダを毎晩見て、**新しく上がった話だけ**をチェックして Slack に出す。

| | |
|---|---|
| 動く時間 | 毎晩 **2:00**（`AUTO_CHECK_HOUR`）。**写植をやっている中国側の稼働が 7:00-21:00** なので、アップロード中に走って「欠番だらけ」の誤報を出す心配が実質ない（前田さん 2026-10-02） |
| 対象作品 | business-hub 作品タブの 取引先コード `0007` ＋ 案件ステータス（=作家作品リストG列「連載状況」）の先頭番号が **90未満**（90=制作中止 / 97〜99=完結を外す）＋ 作品DriveフォルダIDがある行 |
| たどる道 | `{作品フォルダ}/430_写植/200_写植依頼→完成ファイル/{N話}/TIF/画像`。話フォルダの中は **TIF / PDF / PSD** の3つ（2026-10-02 実測）。話フォルダ名は `1話`/`第2話`/`１２話`/`044話`（ゼロ埋めあり）、ファイルは `008_038.tif`（前が話番号・後ろがページ） |
| 判定条件 | 取引先マスタの「コミックシーモア（NTTソルマーレ）」行（5186×7323 / 600dpi / グレースケール / tiff） |
| 通知先 | 集約: `#auto_tool_direction_top_cmoa_写植データ自動チェック`（**まんがたりWS** `C0C61H6UQ11`）に1晩1投稿。<br>エラーのみ: その作品の用途『編集ディレクター』ch（`_002編集ディレクター用`・**ネットマンガラボWS**・社内だけ）にも1投稿 |
| メンション | 作家作品リストの **ディレクター / 編集者 / アサイン責任者**（前田さん2026-10-02「社員は全員」）。氏名→メンバーIDは `AccessControl.buildPeopleHubSlackDirectory` |
| 画面で見る | 「🤖 自動チェック」タブ（`view-auto`）。直っていない話 → 最近のチェック結果 → 見ている作品。**一覧はNG件数だけ**で、中身は「詳細」ボタンのモーダル（`openAutoDetail`）。そこから **CSV / PDF** を出せる（チェック実行タブと同じ流儀）。サーバの `api_autoCheckSummary` が DB の3タブから組み立てる（集計も画面に書かない） |
| 直したら | 「直っていない話」の**再チェック**ボタン（`api_recheckChapter`）。毎晩2:00を待たずその場で見直し、OKなら表から消える |
| 手で動かす | GASエディタで `testAutoCheckNotify`（Slackへ1行投げて疎通確認）/ `dryRunAutoCheck`（**下見だけ。通知もDBへの記録もしない**）/ `runAutoCheckNow`（通知あり・記録あり）/ `installAutoCheckTrigger`（トリガー設置）。いずれも管理者のみ |

- 🚩**増えた話は「中身の署名」で見つける。フォルダの `modifiedTime` は使えない**。Drive は子の追加で親フォルダの更新日時を変えない（`10_お客様とのやり取り用` は毎日動いているのに 2020年のまま。2026-10-02 実測）。話フォルダの中身を list して「件数＋ファイルID/名前/サイズのハッシュ」を DB と比べる
- 🚩**psd は TIF の中ではなく隣の `PSD` フォルダにある。** ここを読まないと「psdが無いページ」の突合が静かに効かなくなる（2026-10-02 に実物で気づいて修正）。毎晩の list を増やさないため、PSD を読むのは**実際にチェックする話だけ**
- 🚩**回る順は「最後に見た時刻が古い順」**（`orderTargetsByStaleness_`）。作品No順のままだと、時間切れのたびに毎回同じ作品が後回しになって永久に見てもらえない。投稿だけ作品No順に並べ直す
- 見に行くのは**新しい方から4話だけ**（`AUTO_CHECK_RECENT_CHAPTERS`）＋前回NGのままの話。写植は話の順に上がるので、作品が増えても1晩のAPI呼び出しが増え続けない。直すと次の晩に ✅ が出る
- 🚩**`dryRunAutoCheck` はDBを書き換えない。** 記録してしまうと「チェック済みなのに誰にも通知されていない話」ができる。初回登録（いまある話を既読にする）は `runAutoCheckNow` でやる（初回は通知が出ないので同じこと）
- 🚩**初回かどうかは「作品の登録」(`autoCheckTitles` タブ)で見る。話の行の有無で見てはいけない**。写植フォルダがまだ無い作品の「はじめての1話」まで既読にしてしまい、連載開始を取りこぼす（`autocheck.test.mjs` の通しテストが見張っている）
- 🚩**Slackはアラート・画面が詳細**（前田さん2026-10-03）。一覧に長い説明を出すと表が横に伸びて操作ボタンが画面外に出るので、**一覧は件数だけ・中身はモーダル**。NGの説明は `checkChapter_` で**切らずに**全部DBへ入れ、画面はそれを全部出す。Slackに出すときだけ `capLines_` で8行に切る（切った行は「詳細は画面の…」と案内する）
- 🚩**再チェックは DB に登録済みの話しか指せない**（`recheckChapter_` が `state.byFolderId` で確かめる）。任意のDriveフォルダを画面から指させないため。実行は利用者本人の権限で、Slackには出さない（押した人が画面を見ているので鳴らす意味がない）
- 担当者の氏名（作家作品リスト）を引くのは**通知のときだけ**。1話チェックするたびに引くと、作家作品リストを読めない利用者の再チェックが重くなる
- **動きが無い晩は投稿しない。** 動いた事実はハートビート（CI状態シート）と `autoCheckLog` に残る。直っていないNGは「動きがあった晩」の投稿の末尾に添えるだけで、毎晩は鳴らさない
- 🚩**メンションのメンバーIDはワークスペースごとに別物。** 集約ch（まんがたり）は `Slack（まんがたり）`、作品ch（ネットマンガラボ）は `Slack（ネットマンガラボ）` の アカウント識別子を引く。投稿先と辞書が食い違うと「@unknown」になって誰にも届かない
- 辞書に無い人（社外のディレクター等）は `名前(Slack未解決)` と出す。**メンションが引けなくても通知自体は止めない**
- 🚩**DBの日時列は書式を文字列(@)にする**（`isTimestampHeader_`）。そうしないとシートが `2026-10-03 11:24` を日付として解釈し、読み直すたびにスプレッドシートのTZ差ぶん（9時間）ずれていく（2026-10-03 に登録日時が 11:24→20:24 になって発覚）。ずれた分は `upsertAutoCheckTitle_` が「登録日時がいまより後なら直す」で自己修復する
- **通知の失敗は握りつぶすが、画面には出す。** `saveLastRun_` が `notifyError` を残し、自動チェックタブの先頭に「⚠️ Slackに投稿できませんでした」と出る（ログに消えると誰も気づけないため）
- 「最後に動いたのは…」はスクリプトプロパティ `AUTO_CHECK_LAST_RUN`（`saveLastRun_`）。**静かな晩でも動いていることを画面で見せる**ための記録で、Slackが無音なことと区別がつくようにしている
- DBのタブ: `autoCheckTitles`（見ている作品・写植フォルダIDの控え）/ `autoCheckState`（話ごとの既読状態と結果）/ `autoCheckLog`（実行の記録・5000行で古い方を切る）
- 🚩 **投稿には表示名とアイコンを付ける**（`NOTIFY_SLACK_USERNAME` = 原稿サイズチェッカー / `:straight_ruler:`。`chat:write.customize`）。全社Bot1本に寄せると投稿者が全部 `all_tools_access` になり、どのツールの通知か見分けられないため。決め方の正本は `mangatari-portal/src/SlackNotify.gs`（ツールポータルの `?page=slack`）
- 🚩 **送り先は固定されている**＝集約は `NOTIFY_CHANNEL_ID` 定数（`C0C61H6UQ11`）、作品chは business-hub「Slackチャンネル」タブに用途『編集ディレクター』で登録されたものだけ（タブが allowlist）。**画面から任意のチャンネルを指せない**ので、他ツールで入れた接頭辞ガード（`auto_`/`dev_` 限定）は要らない
- トークンは Script Properties: `SLACK_BOT_TOKEN_MANGATARI`（必須。Bot は `all_tools_access`）/ `SLACK_BOT_TOKEN_NETMANGALABO`（無ければ作品chへの投稿だけ黙ってスキップ）
- **OAuthスコープは増やしていない**（Drive読み取り・スプレッドシート・外部通信・トリガー・メールで足りる）。増やすと利用者全員に再認可が発生する

## ルール
- 🚩**判定ロジックの正本は `gas/src/Judge.gs` の1か所だけ。** 画面にもサーバにも写しを置かない（2026-10-02 に index.html から移設。画面は `api_inspectImages(files, spec)` と `api_setChecks(files)` を呼ぶ）。`checker.test.mjs` が「画面に写しが無いこと」を見張っている。※ GitHub Pages 版（旧）の `index.html` は別物として残っている
- 画面側ロジックは `function 名前(...)` で書く（テストが関数名で抽出する）。メインの `<script>` は `<script>\n'use strict';` で始める
- **末尾「_」の無いサーバ関数は google.script.run から誰でも呼べる。** 画面用APIは冒頭で `requireAllowed_()`、管理用は `requireAdmin_()`
- Drive/スプレッドシートに触るのはサーバ側だけ。ユーザー入力のIDは正規表現で検証してからURLに入れる（Driveの検索クエリに混ぜない）
- GAS の `getContent()` は -128〜127 のバイト配列。`new Uint8Array(...)` に入れて 0〜255 にしてから読む
- GASの画面は iframe の中: リンクは `<base target="_blank">`、コピーは `copyText()`、自分のURLは `BOOT.toolUrl`
- UI・コメント・コミットメッセージは日本語。利用者はエンジニアではない
- テスト: `npm test`（旧版134件＋GAS版 判定88件・画面側45件＋サーバ/自動チェック53件）。push・デプロイ前に必ず通す

## 右上（GAS版）
- 共通部品 `AccessControl.headerKit`（共通ルール 11章。2026-09-18 本番@6・ライブラリ @9）: `headerKitHtml_` が氏名+⚙（ポータルへ・問い合わせ=`SLACK_CHANNEL`・使い方=画面内の使い方ガイドを開く `MgtHeader.onHelp`・再読み込み）を出す。部品が出なかったときだけ「ログイン中: メール」（`#accountFallback`）
- 問い合わせは `#dev_原稿サイズチェッカー`（ID `C0BS10YPM6X`）。**2026-09-23 にメインPCからIDを受け取り、名前リンク（`app_redirect`。開けないことがある）からIDリンクへ切り替えた**: `gas/src/Config.gs` の `SLACK_CHANNEL_ID` を `headerKit` に `slackChannelId` として渡す（合本版チェッカーと同じ形。名前は表示ラベルとして併せて渡す）
- ⚙の「再読み込み」は部品の既定（`toolUrl` を開き直す）のまま。この画面はURLに指定（`?…`）を取らないので、いまのURLと同じになる
