/**
 * PeopleHubSync.gs - 入場権限(allowedEmails)を people-hub から同期する
 * ============================================================
 * people-hub「ツール利用状況」の ツール名 = TOOL_NAME('gappon-checker') の行を正本として、
 * このツールのDBの allowedEmails タブへ同期する。仕組み(マスタ読み取り・差分計画・シート適用)は
 * mangatari-access-control-lib の PeopleHubSync コアにあり、ここはこのツールの方針だけ持つ
 * (雛形: mangatari-portal/src/PeopleHubSync.gs)。
 *
 * 【手順(この順番でないと締め出しになる)】
 *   1) 共有フォルダ「41_便利ツール（前田開発）」の中にスプレッドシートを1つ作り、
 *      IDを Config.gs の DB_SPREADSHEET_ID_DEFAULT(またはスクリプトプロパティ DB_SPREADSHEET_ID)に入れる
 *   2) people-hub「ツール利用状況」に gappon-checker の利用者行があることを確認する
 *   3) GASエディタで setupAccessSheet() を1回実行する(allowedEmails タブを作り、同期を1回走らせる)
 *   4) installAccessSyncTrigger() で定期同期を入れる
 */

/**
 * people-hub 側の「権限・利用可否」を allowedEmails の「権限」列の値に変換する。
 * ライブラリは role === '管理者' だけを管理者とみなすので、それ以外は空にする。
 */
function roleForPermission_(permission) {
  return String(permission == null ? '' : permission).indexOf('管理者') !== -1 ? ADMIN_ROLE_VALUE : '';
}

/** allowedEmails タブを用意する(冪等)。データ行が無ければ ADMIN_EMAILS を初期管理者として入れる。 */
function ensureAllowedEmailsSheet_(spreadsheetId) {
  var ss = SpreadsheetApp.openById(spreadsheetId);
  var sheet = ss.getSheetByName(ALLOWED_EMAILS_SHEET) || ss.insertSheet(ALLOWED_EMAILS_SHEET);
  var width = ALLOWED_EMAILS_HEADER.length;
  if (sheet.getLastRow() < 1) {
    sheet.getRange(1, 1, 1, width).setValues([ALLOWED_EMAILS_HEADER]);
    sheet.setFrozenRows(1);
  }
  if (sheet.getLastRow() < 2) {
    var seed = ADMIN_EMAILS.map(function (email) {
      var row = [email, '初期管理者(ADMIN_EMAILSより)', ADMIN_ROLE_VALUE];
      while (row.length < width) row.push('');
      return row;
    });
    sheet.getRange(2, 1, seed.length, width).setValues(seed);
  }
  return sheet;
}

function loadAllowedRows_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, ALLOWED_EMAILS_HEADER.length).getValues()
    .map(function (row) {
      return {
        email: String(row[0] || '').trim(),
        memo: String(row[1] || '').trim(),
        role: String(row[2] || '').trim(),
        name: String(row[3] || '').trim()
      };
    })
    .filter(function (r) { return r.email; });
}

function loadDesiredAllowedRows_() {
  var users = AccessControl.loadPeopleHubToolUsers({
    peopleHubSpreadsheetId: PEOPLE_HUB_SPREADSHEET_ID,
    toolUsageSheetName: PEOPLE_HUB_TOOL_USAGE_SHEET,
    toolName: TOOL_NAME,
    enabledFlagMode: 'requireTruthy'
  });

  var names = {};
  try {
    names = AccessControl.loadPeopleHubDisplayNames({ peopleHubSpreadsheetId: PEOPLE_HUB_SPREADSHEET_ID });
  } catch (err) {
    console.log('氏名の取得に失敗(担当者名は既存を維持): ' + err);
  }

  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  return users.map(function (u) {
    return {
      email: u.email,
      memo: u.memo || ('社員マスタから同期 (' + today + ')'),
      role: roleForPermission_(u.permission),
      name: names[u.email] || ''
    };
  });
}

/**
 * people-hub → allowedEmails へ同期する(定期トリガーの本体)。管理者のみ。
 * 対象0件のときは既存を消さない(マスタ側が未登録なだけで全員締め出しになるのを防ぐ)。
 */
function syncAllowedEmails() {
  requireAdmin_();
  var config = getConfig_();
  if (!config.dbSpreadsheetId) throw new Error(dbMissingMessage_());

  var desired = loadDesiredAllowedRows_();
  if (!desired.length) {
    console.log('people-hub に ツール名=' + TOOL_NAME + ' の有効な行がありません。同期をスキップしました。');
    return { added: 0, updated: 0, removed: 0, unchanged: 0, desired: 0, skipped: true };
  }

  var sheet = ensureAllowedEmailsSheet_(config.dbSpreadsheetId);
  var plan = AccessControl.computeAllowedEmailsSyncPlan(
    loadAllowedRows_(sheet), desired, config.adminEmails,
    { adminRole: ADMIN_ROLE_VALUE, preserveManualRoles: false, updateOnMemoChange: true }
  );
  var counts = AccessControl.applyAllowedEmailsSyncPlan(sheet, plan, { writeNameColumn: true });
  AccessControl.invalidateAllowedEmailsCache(accessConfig_());

  var stat = {
    added: counts.added, updated: counts.updated, removed: counts.removed,
    unchanged: counts.unchanged, desired: desired.length, skipped: false
  };
  console.log('allowedEmails 同期: ' + JSON.stringify(stat));
  return stat;
}

/** 初回セットアップ(GASエディタから1回実行)。allowedEmails タブを作り、同期して1人以上入れることを確かめる。 */
function setupAccessSheet() {
  requireAdmin_();
  var config = getConfig_();
  if (!config.dbSpreadsheetId) throw new Error(dbMissingMessage_());

  ensureAllowedEmailsSheet_(config.dbSpreadsheetId);
  var stat = syncAllowedEmails();
  if (stat.skipped) {
    throw new Error(
      'people-hub「' + PEOPLE_HUB_TOOL_USAGE_SHEET + '」に ツール名=' + TOOL_NAME + ' の有効な行がありません。' +
      '社員情報ハブで利用者を登録してから、もう一度実行してください(いまは管理者だけが入れる状態です)。'
    );
  }
  var url = 'https://docs.google.com/spreadsheets/d/' + config.dbSpreadsheetId + '/edit';
  console.log('allowedEmails を用意しました: ' + url + '\n同期結果: ' + JSON.stringify(stat));
  return { url: url, sync: stat };
}

function dbMissingMessage_() {
  return 'このツールのDBスプレッドシートがまだ設定されていません。\n' +
    '1) Driveの共有フォルダ「' + TOOLS_FOLDER_NAME + '」(' + TOOLS_FOLDER_ID + ') の中にスプレッドシートを1つ作る\n' +
    '   (名前は「合本版チェッカー DB」など)\n' +
    '2) そのIDを スクリプトプロパティ DB_SPREADSHEET_ID に設定する\n' +
    '3) もう一度この関数を実行する\n' +
    '※ マイドライブ直下に作ると前田さん以外が読めず、全員が入れなくなります。';
}

/**
 * 初回セットアップを、ADMIN_EMAILS(前田さん)が画面を開いたときに済ませる(doGet から呼ぶ)。
 * 自分の同期トリガーがまだ無いときだけ、allowedEmails タブを用意 → 同期 → トリガー設置 を行う。
 * ADMIN_EMAILS に限るのは、トリガーが「開いた人」のアカウントに作られるため(複数人に作らせない)。
 * 失敗しても画面は出す。返り値は画面に出す結果(何もしなければ null)。
 */
function ensureInitialSetup_(email) {
  var config = getConfig_();
  if (!config.dbSpreadsheetId || config.adminEmails.indexOf(normalizeEmail_(email)) === -1) return null;
  try {
    var hasTrigger = ScriptApp.getProjectTriggers().some(function (t) {
      return t.getHandlerFunction() === ACCESS_SYNC_HANDLER;
    });
    if (hasTrigger) return null;
    ensureAllowedEmailsSheet_(config.dbSpreadsheetId);
    var stat = syncAllowedEmails();
    installAccessSyncTrigger();
    return { ok: true, sync: stat, hours: ACCESS_SYNC_HOURS };
  } catch (err) {
    console.error('ensureInitialSetup_ failed: ' + err);
    return { ok: false, message: String(err && err.message ? err.message : err) };
  }
}

/** 定期同期トリガーを設置(重複設置しない)。管理者のみ。 */
function installAccessSyncTrigger() {
  requireAdmin_();
  removeAccessSyncTriggers_();
  ACCESS_SYNC_HOURS.forEach(function (hour) {
    ScriptApp.newTrigger(ACCESS_SYNC_HANDLER).timeBased().atHour(hour).everyDays(1).create();
  });
  console.log('入場権限の定期同期を設置しました: ' + ACCESS_SYNC_HOURS.join('時, ') + '時');
  return { hours: ACCESS_SYNC_HOURS };
}

function uninstallAccessSyncTrigger() {
  requireAdmin_();
  removeAccessSyncTriggers_();
}

function removeAccessSyncTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === ACCESS_SYNC_HANDLER; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
}
