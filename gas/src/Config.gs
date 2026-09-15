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

// 取引先マスタ(GitHub Pages 版と同じシートを共有する。並行稼働中はどちらから保存しても同じ内容になる)。
// 列: A取引先名 B幅px C高さpx D DPI Eカラーモード F幅判定 G高さ判定 H拡張子(先頭のシート)
var MASTER_SHEET_ID = '1QnYqQA7NpSkhuC5dUL8klBaeTQc2EjYDcACROG3OBRU';
var MASTER_RANGE = 'A:H';
var MASTER_HEADER = ['取引先名', '幅px', '高さpx', 'DPI', 'カラーモード', '幅判定', '高さ判定', '拡張子'];

// フォルダ走査の上限(1回の実行時間6分に収めるため)。
var LIST_MAX_FILES = 3000;
var LIST_MAX_DEPTH = 8;

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
