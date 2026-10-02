/**
 * Config.gs - 原稿サイズチェッカー(GAS版)の設定値
 *
 * ここの値はすべてリテラルで持つ(他ファイルの変数をグローバル初期化で参照しない。
 * GASのファイル評価順によっては undefined になるため)。
 * スプレッドシートID・メールは秘密情報ではないのでコードに置く。トークン類は置かない。
 */

var TOOL_TITLE = '原稿サイズチェッカー';
// people-hub「ツール利用状況」のツール名。ポータル(mangatari-portal)の DEFAULT_TOOLS の key と同じ。
var TOOL_NAME = 'genko-size-checker';

// break-glass の管理者(allowedEmails が読めない・壊れたときでも締め出されない)。
var ADMIN_EMAILS = ['mangatari.yuta.maeda@gmail.com'];
var ADMIN_ROLE_VALUE = '管理者';

// このツールのDB(allowedEmails タブを持つスプレッドシート)。共有フォルダ「41_便利ツール（前田開発）」に作成済み。
// スクリプトプロパティ DB_SPREADSHEET_ID があればそちらを優先する。
var DB_SPREADSHEET_ID_DEFAULT = '1XrbOQtgeitb5m9Vz5779F9Abvq7orfgDrBD2V2gN0jI'; // 原稿サイズチェッカー DB(2026-09-16作成)
var ALLOWED_EMAILS_SHEET = 'allowedEmails';
var ALLOWED_EMAILS_HEADER = ['メールアドレス', 'メモ', '権限', '担当者名'];
var TOOLS_FOLDER_ID = '1iEKNqT3snJou2MBYWzs4vo5dW3HCn0mU';
var TOOLS_FOLDER_NAME = '41_便利ツール（前田開発）';

var PEOPLE_HUB_SPREADSHEET_ID = '1073LfI4cVZ1FpqH7g88yXObwlD4cJLhzgMqT9Q1OQaQ';
var PEOPLE_HUB_TOOL_USAGE_SHEET = 'ツール利用状況';
var ACCESS_SYNC_HANDLER = 'syncAllowedEmails';
var ACCESS_SYNC_HOURS = [8, 13, 18];

var PORTAL_URL = 'https://script.google.com/macros/s/AKfycbyBX06IOv_z0W6qJSg1yTWDh7w1yO6boHg4yj5wBc_sA3D0O4-KzVdf4qaZkMMPHpwxoA/exec';
var SLACK_CHANNEL = '#dev_原稿サイズチェッカー';
// 右上⚙の「問い合わせ」はこのIDで開く(名前リンクより確実)。2026-09-23 にメインPCから受領。
var SLACK_CHANNEL_ID = 'C0BS10YPM6X';

// 取引先マスタ(GitHub Pages 版と同じシートを共有する。並行稼働中はどちらから保存しても同じ内容になる)。
// 列: A取引先名 B幅px C高さpx D DPI Eカラーモード F幅判定 G高さ判定 H拡張子(先頭のシート)
var MASTER_SHEET_ID = '1QnYqQA7NpSkhuC5dUL8klBaeTQc2EjYDcACROG3OBRU';
var MASTER_RANGE = 'A:H';
var MASTER_HEADER = ['取引先名', '幅px', '高さpx', 'DPI', 'カラーモード', '幅判定', '高さ判定', '拡張子'];

// フォルダ走査の上限(1回の実行時間6分に収めるため)。
var LIST_MAX_FILES = 3000;
var LIST_MAX_DEPTH = 8;

// ============================================================
// 写植データの自動チェック(AutoCheck.gs)
// ============================================================
// 毎晩2:00に、コミックシーモアの連載中作品の写植フォルダを見て、増えた話だけチェックして Slack に出す。
// 2:00 にしたのは**写植をやっている中国側の稼働が 7:00-21:00** だから(前田さん 2026-10-02)。
// アップロード中に走って「欠番だらけ」の誤報を出す心配が実質ない。

var AUTO_CHECK_HANDLER = 'runAutoCheck';
var AUTO_CHECK_HOUR = 2;

// 取引先・作品マスタ(mangatari-business-hub)。作品タブの「作品DriveフォルダID」から写植フォルダをたどる。
var BUSINESS_MASTER_SS_ID = '1STHr_fxXzF6fsWF07z2ABc9dodB_5LwKxr0zA0TLmqw';
var BUSINESS_MASTER_SHEET = '取引先';
// まんプロ コミックシーモア(NTTソルマーレ)の取引先コードと、取引先マスタ(MASTER_SHEET_ID)の行名。
var AUTO_CHECK_PARTNER_CODE = '0007';
var AUTO_CHECK_PARTNER_NAME = 'コミックシーモア（NTTソルマーレ）';
// 案件ステータス(=作家作品リストG列「連載状況」)の先頭番号がこれ以上なら対象外。90=制作中止 / 97〜99=完結。
var AUTO_CHECK_SKIP_STATUS_FROM = 90;

// 作品フォルダの中の定位置(テンプレ 9000_テンプレ（コミックシーモア） に合わせる)。gappon-checker と同じ規約。
var SHASHOKU_LAYOUT = {
  shashoku: { prefix: '430', keyword: '写植' },   // 430_写植
  source:   { prefix: '200', keyword: '完成' }    // 430_写植/200_写植依頼→完成ファイル
};
// 話フォルダ(1話/第1話/１話/044話…)の中は TIF / PDF / PSD の3つに分かれている(2026-10-02 実測)。
// 画像は TIF。無ければ話フォルダ直下を見る。
var SHASHOKU_IMAGE_SUBFOLDER = 'TIF';
// 🚩psd は TIF の中ではなく**隣**にある。ここを見ないと psd↔画像の突合(psdが無いページ)が効かない。
var SHASHOKU_PSD_SUBFOLDER = 'PSD';

// 1作品につき見に行く話フォルダは「新しい方から」この数だけ。写植は話の順に上がってくるので、
// 過去の話を毎晩listし直す必要がない(作品が増えても1晩のAPI呼び出しが増え続けない)。
var AUTO_CHECK_RECENT_CHAPTERS = 4;
// 1回の実行で新しくチェックする話フォルダの上限(GASの6分制限。超えた分は翌晩に回す)。
var AUTO_CHECK_MAX_CHAPTERS_PER_RUN = 12;
// 1話あたりの画像の上限(これを超える話は多すぎるので人に回す)。
var AUTO_CHECK_MAX_FILES_PER_CHAPTER = 200;
// 新しい作品の走査を打ち切る目安(GASの上限は6分。残りは翌晩に回す)。
var AUTO_CHECK_DEADLINE_MS = 4 * 60 * 1000;
// Slack に並べるNGの行数の上限(超えたら「ほか N件」で締める)。
var AUTO_CHECK_MAX_NG_LINES = 8;

// DB(DB_SPREADSHEET_ID)のタブ。titles=見ている作品 / state=話ごとの既読状態 / log=実行の記録。
// titles は「この作品を前に見たことがあるか」の記録。これが無いと、写植がまだ無い作品の
// はじめての1話を「初回登録」として黙って既読にしてしまう。写植フォルダIDの控えも兼ねる
// (作品フォルダと430_写植のlistを毎晩やらずに済む)。
var AUTO_CHECK_TITLES_SHEET = 'autoCheckTitles';
var AUTO_CHECK_TITLES_HEADER = ['作品No', '作品名', '写植完成フォルダID', '登録日時', '最終確認'];
var AUTO_CHECK_STATE_SHEET = 'autoCheckState';
var AUTO_CHECK_STATE_HEADER = ['作品No', '作品名', '話', '話フォルダID', '署名', 'ファイル数', '最終チェック', '結果', 'NG件数'];
var AUTO_CHECK_LOG_SHEET = 'autoCheckLog';
var AUTO_CHECK_LOG_HEADER = ['日時', '作品No', '作品名', '話', 'ファイル数', '結果', 'NG件数', '内容', '通知先'];
var AUTO_CHECK_LOG_MAX_ROWS = 5000;

// ============================================================
// Slack通知(Notify.gs)
// ============================================================
// 集約チャンネル(まんがたりWS。2026-10-02作成)。命名は既存の auto_tool_direction_top_… に合わせた。
var NOTIFY_CHANNEL_ID = 'C0C61H6UQ11';
var NOTIFY_CHANNEL_NAME = '#auto_tool_direction_top_cmoa_写植データ自動チェック';
// 集約チャンネルのワークスペース。メンションのメンバーIDはワークスペースごとに別物なので、
// 投稿先とメンション辞書(people-hub のツール名)は必ず揃える。
var NOTIFY_TOKEN_PROP = 'SLACK_BOT_TOKEN_MANGATARI';
var NOTIFY_SLACK_TOOL_NAME = 'Slack（まんがたり）';
// エラーのときだけ、作品ごとの「_002編集ディレクター用」(ネットマンガラボWS・社内だけ)にも出す。
// トークンが未設定ならこの送信だけ黙ってスキップする(集約チャンネルには出る)。
var NOTIFY_TITLE_CHANNEL_PURPOSE = '編集ディレクター';
var NOTIFY_TITLE_TOKEN_PROP = 'SLACK_BOT_TOKEN_NETMANGALABO';
var NOTIFY_TITLE_SLACK_TOOL_NAME = 'Slack（ネットマンガラボ）';

// メンションする人の列(作家作品リストの2行目ヘッダー)。前田さん2026-10-02: 社員は全員。
var NOTIFY_MENTION_COLUMNS = ['ディレクター', '編集者', 'アサイン責任者'];
var PEOPLE_HUB_EMPLOYEES_SHEET = '社員一覧';

// 画像の解析: 1回の呼び出しで扱うファイル数と、先頭から読むバイト数・追加で読むバイト数・読み足しの回数。
var INSPECT_BATCH_MAX = 25;
var INSPECT_HEAD_BYTES = 64 * 1024;
var INSPECT_MORE_BYTES = 16 * 1024;
var INSPECT_MAX_ROUNDS = 10;

function getConfig_() {
  var fromProps = '';
  try {
    fromProps = PropertiesService.getScriptProperties().getProperty('DB_SPREADSHEET_ID') || '';
  } catch (err) {
    console.error('getConfig_: スクリプトプロパティを読めません: ' + err);
  }
  return {
    dbSpreadsheetId: String(fromProps || DB_SPREADSHEET_ID_DEFAULT).trim(),
    adminEmails: ADMIN_EMAILS.map(normalizeEmail_)
  };
}
