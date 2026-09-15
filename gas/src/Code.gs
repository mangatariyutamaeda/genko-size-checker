/**
 * Code.gs - 原稿サイズチェッカー(GAS版) 本体
 *
 * 構成:
 *   doGet()               : 入口ゲート。allowedEmails(+ADMIN_EMAILS)に載っている人だけ画面を返す。
 *   api_listFolders()     : Driveフォルダの中のファイル一覧(サブフォルダも可)。
 *   api_inspectImages()   : TIFF/JPEG の先頭部分だけを部分取得して、寸法・DPI・カラーモードを読む。
 *   api_loadMaster() ほか : 取引先マスタ(スプレッドシート)の読み書き。
 *   OK/NG の判定・ファイルセット整合性チェック・CSV/PDF出力はブラウザ側(index.html)。
 *
 * アクセス制御(まんがたり共通標準):
 *   - executeAs=USER_ACCESSING / access=ANYONE。Drive・スプレッドシートは利用者本人の権限で読む。
 *   - 入場可否は mangatari-access-control-lib に委譲。判定できなければ拒否(fail-closed)。
 *   - identity は Session.getEffectiveUser()(個人Gmail・社外アカウントでも空にならない)。
 *   - 末尾「_」の無い関数は google.script.run から誰でも呼べるので、必ず冒頭で requireAllowed_ / requireAdmin_ を通す。
 */

// ============================================================
// 入口
// ============================================================

function doGet(e) {
  var email = currentEmail_();
  if (!email) {
    return renderDenied_('', 'Googleアカウントを確認できませんでした',
      'Googleアカウントにログインした状態で開き直してください。初めて開いたときに出る「アクセスを許可」の画面で許可していない場合も、この表示になります。');
  }
  if (!isAllowed_(email)) {
    return renderDenied_(email, 'このツールを使う権限がありません',
      '原稿サイズチェッカーは、登録された人だけが使えます。社内の方はツールポータルの「利用を申請」から、社外の方は担当者に、下のメールアドレスを伝えて登録を依頼してください。');
  }

  var template = HtmlService.createTemplateFromFile('index');
  template.bootJson = bootJsonForHtml_({
    email: email,
    isAdmin: isAdmin_(email),
    toolUrl: toolUrl_(),
    masterSheetUrl: 'https://docs.google.com/spreadsheets/d/' + MASTER_SHEET_ID + '/edit',
    slackChannel: SLACK_CHANNEL,
    portalUrl: PORTAL_URL,
    setup: ensureInitialSetup_(email)
  });
  return template.evaluate()
    .setTitle(TOOL_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function renderDenied_(email, title, message) {
  var template = HtmlService.createTemplateFromFile('denied');
  template.deniedTitle = title;
  template.deniedMessage = message;
  template.email = email;
  template.portalUrl = PORTAL_URL;
  template.slackChannel = SLACK_CHANNEL;
  return template.evaluate()
    .setTitle(TOOL_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function toolUrl_() {
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (err) {
    return '';
  }
}

// ============================================================
// アクセス制御(入場可否) - fail-closed
// ============================================================

function currentEmail_() {
  try {
    return normalizeEmail_(Session.getEffectiveUser().getEmail());
  } catch (err) {
    console.error('currentEmail_ failed: ' + err);
    return '';
  }
}

function accessConfig_() {
  var config = getConfig_();
  return {
    spreadsheetId: config.dbSpreadsheetId,
    sheetName: ALLOWED_EMAILS_SHEET,
    adminEmails: config.adminEmails,
    adminRoleValue: ADMIN_ROLE_VALUE
  };
}

/** このツールに入れるか。ADMIN_EMAILS は常に許可(break-glass)。DB未設定・ライブラリの失敗は拒否。 */
function isAllowed_(email) {
  var e = normalizeEmail_(email);
  if (!e) return false;
  var config = getConfig_();
  if (config.adminEmails.indexOf(e) !== -1) return true;
  if (!config.dbSpreadsheetId) return false;
  try {
    return AccessControl.isAllowedEmail(e, accessConfig_());
  } catch (err) {
    console.error('AccessControl.isAllowedEmail failed: ' + err);
    return false;
  }
}

function isAdmin_(email) {
  var e = normalizeEmail_(email);
  if (!e) return false;
  var config = getConfig_();
  if (config.adminEmails.indexOf(e) !== -1) return true;
  if (!config.dbSpreadsheetId) return false;
  try {
    return AccessControl.isAdminEmail(e, accessConfig_());
  } catch (err) {
    console.error('AccessControl.isAdminEmail failed: ' + err);
    return false;
  }
}

/** 利用者でなければ例外。画面から呼ぶAPIの冒頭で必ず呼ぶ。 */
function requireAllowed_() {
  var email = currentEmail_();
  if (!isAllowed_(email)) throw new Error('このツールを使う権限がありません。');
  return email;
}

/** 管理者でなければ例外。GASエディタから前田さんが実行する分には通る(トリガー実行も同じ)。 */
function requireAdmin_() {
  var email = currentEmail_();
  if (!isAdmin_(email)) throw new Error('管理者のみ実行できます。');
  return email;
}

// ============================================================
// Google API 呼び出し(利用者本人のトークン)
// ============================================================

function googleApiGet_(url) {
  return googleApiSend_('get', url, null);
}

/** 例外は投げず status で返す。 */
function googleApiSend_(method, url, body) {
  var options = {
    method: method,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  };
  if (body != null) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(body);
  }
  var res = UrlFetchApp.fetch(url, options);
  var status = res.getResponseCode();
  if (status < 200 || status >= 300) console.warn('googleApi ' + method + ' -> HTTP ' + status);
  return {
    status: status,
    get text() { return res.getContentText(); }
  };
}

// ============================================================
// Driveフォルダの一覧
// ============================================================

/**
 * フォルダ(URLまたはIDを1行ずつ)の中のファイルを返す。フォルダ自体は返さない。
 * 返り値: { ok: true, files: [{ id, name, mimeType, size, webViewLink, folder, root }] }
 *   folder = 表示用のフォルダ名(入力フォルダのID / サブフォルダ名…)、root = 入力フォルダのID(集計キー)
 * 画像かpsdかの振り分けは画面側(isSupportedImage / isPsdFile)で行う。
 */
function api_listFolders(lines, recursive) {
  requireAllowed_();
  var inputs = (lines || []).map(function (l) { return String(l || '').trim(); }).filter(Boolean);
  if (!inputs.length) throw new Error('対象フォルダを1つ以上入力してください');
  var files = [];
  inputs.forEach(function (line) {
    var folderId = extractFolderId_(line);
    if (!folderId) throw new Error('フォルダのURL(またはID)として読めません: ' + line);
    listFolder_(folderId, folderId, !!recursive, files, folderId, 0);
  });
  return { ok: true, files: files };
}

function listFolder_(folderId, label, recursive, out, rootKey, depth) {
  var pageToken = '';
  do {
    var res = googleApiGet_(buildDriveListUrl_(folderId, pageToken));
    if (res.status !== 200) throw new Error('フォルダ一覧取得に失敗しました (HTTP ' + res.status + '): ' + label);
    var data = JSON.parse(res.text);
    (data.files || []).forEach(function (f) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        if (recursive && depth < LIST_MAX_DEPTH) listFolder_(f.id, label + ' / ' + f.name, true, out, rootKey, depth + 1);
        return;
      }
      if (out.length >= LIST_MAX_FILES) {
        throw new Error('ファイルが多すぎます(' + LIST_MAX_FILES + '件まで)。フォルダを分けてチェックしてください。');
      }
      out.push({
        id: f.id, name: f.name, mimeType: f.mimeType,
        size: f.size != null ? Number(f.size) : null,
        webViewLink: f.webViewLink || '', folder: label, root: rootKey
      });
    });
    pageToken = data.nextPageToken || '';
  } while (pageToken);
}

// ============================================================
// 画像の解析(先頭部分だけを部分取得。ファイル全体はダウンロードしない)
// ============================================================

/**
 * files: [{ id, name, size? }](最大 INSPECT_BATCH_MAX 件)
 * 返り値: 同じ順で [{ spec: { width, height, dpiX, dpiY, colorMode } } または { error }]
 *
 * 全ファイルの先頭 INSPECT_HEAD_BYTES を並列に取り(fetchAll)、解析してみる。
 * 解析に足りない位置(TIFFのIFDがファイル末尾にある、JPEGの前置きが長い等)があれば、
 * その位置だけを並列に読み足して解析し直す(最大 INSPECT_MAX_ROUNDS 回)。
 */
function api_inspectImages(files) {
  requireAllowed_();
  var token = ScriptApp.getOAuthToken();
  var states = (files || []).slice(0, INSPECT_BATCH_MAX).map(function (f) {
    var id = String((f && f.id) || '');
    var size = f && f.size != null && f.size !== '' ? Number(f.size) : null;
    return {
      id: id, name: String((f && f.name) || ''), chunks: [], eof: isFinite(size) ? size : null,
      result: /^[-\w]{10,}$/.test(id) ? null : { error: '不正なファイルIDです' }
    };
  });

  var pending = states.filter(function (s) { return !s.result; })
    .map(function (s) { return { state: s, start: 0, length: INSPECT_HEAD_BYTES }; });

  for (var round = 0; round < INSPECT_MAX_ROUNDS && pending.length; round++) {
    var responses = UrlFetchApp.fetchAll(pending.map(function (p) {
      return buildRangeRequest_(p.state.id, p.start, p.length, token);
    }));
    responses.forEach(function (res, i) {
      applyRangeResponse_(pending[i].state, pending[i].start, pending[i].length, res.getResponseCode(), res.getContent());
    });
    pending = [];
    states.forEach(function (s) {
      if (s.result) return;
      var outcome = inspectFromChunks_(s.name, s.chunks);
      if (!outcome.need) { s.result = outcome; return; }
      if (s.eof != null && outcome.need.offset + outcome.need.length > s.eof) {
        s.result = { error: 'ファイルが途中で切れているか、形式が壊れています' };
        return;
      }
      pending.push({ state: s, start: outcome.need.offset, length: Math.max(outcome.need.length, INSPECT_MORE_BYTES) });
    });
  }
  return states.map(function (s) { return s.result || { error: '解析に必要な情報を読み切れませんでした' }; });
}

function buildRangeRequest_(fileId, start, length, token) {
  return {
    url: buildDriveMediaUrl_(fileId),
    headers: { Authorization: 'Bearer ' + token, Range: 'bytes=' + start + '-' + (start + length - 1) },
    muteHttpExceptions: true
  };
}

/** 部分取得の結果を state に反映する(純粋ロジック)。 */
function applyRangeResponse_(state, start, length, code, content) {
  if (code === 206 || code === 200) {
    var bytes = new Uint8Array(content || []); // GASのバイト配列は -128〜127。Uint8Array に入れると 0〜255 になる
    if (code === 200) { // Range を無視して全体が返ってきた
      state.chunks = [{ start: 0, bytes: bytes }];
      state.eof = bytes.length;
    } else {
      state.chunks.push({ start: start, bytes: bytes });
      if (bytes.length < length) state.eof = start + bytes.length;
    }
  } else if (code === 416) { // 開始位置がファイルの外
    state.eof = Math.min(state.eof == null ? start : state.eof, start);
  } else {
    state.result = { error: 'ファイル取得に失敗 (HTTP ' + code + ')' };
  }
}

/** 手元にあるバイト列で解析する。足りなければ { need: { offset, length } }。 */
function inspectFromChunks_(name, chunks) {
  var reader = chunkReader_(chunks);
  try {
    var e = imageExt_(name);
    return { spec: (e === 'jpg' || e === 'jpeg') ? parseJpegSpec_(reader) : parseTiffSpec_(reader) };
  } catch (err) {
    if (err instanceof NeedBytes_) return { need: { offset: err.offset, length: err.length } };
    return { error: String(err && err.message ? err.message : err) };
  }
}

function NeedBytes_(offset, length) {
  this.offset = offset;
  this.length = length;
}

function chunkReader_(chunks) {
  return {
    getBytes: function (offset, length) {
      for (var i = 0; i < chunks.length; i++) {
        var c = chunks[i];
        if (offset >= c.start && offset + length <= c.start + c.bytes.length) {
          return c.bytes.subarray(offset - c.start, offset - c.start + length);
        }
      }
      throw new NeedBytes_(offset, length);
    }
  };
}

function imageExt_(name) {
  var m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function readUint16_(bytes, offset, little) {
  return little ? (bytes[offset] | (bytes[offset + 1] << 8))
                : ((bytes[offset] << 8) | bytes[offset + 1]);
}

function readUint32_(bytes, offset, little) {
  return little
    ? (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
    : ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

var TIFF_TYPE_SIZE_ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/** TIFF: ヘッダー → 最初のIFD → 寸法(256/257)・解像度(282/283/296)・カラー(262/277)。GitHub Pages 版 parseTiffSpec と同じ判定。 */
function parseTiffSpec_(reader) {
  var header = reader.getBytes(0, 8);
  var little;
  if (header[0] === 0x49 && header[1] === 0x49) little = true;
  else if (header[0] === 0x4D && header[1] === 0x4D) little = false;
  else throw new Error('TIFF形式ではありません');
  if (readUint16_(header, 2, little) !== 42) throw new Error('不正なTIFFヘッダーです');
  var ifdOffset = readUint32_(header, 4, little);

  var entryCount = readUint16_(reader.getBytes(ifdOffset, 2), 0, little);
  var entries = reader.getBytes(ifdOffset + 2, entryCount * 12);

  var tags = {};
  for (var i = 0; i < entryCount; i++) {
    var eOff = i * 12;
    var tag = readUint16_(entries, eOff, little);
    var type = readUint16_(entries, eOff + 2, little);
    var count = readUint32_(entries, eOff + 4, little);
    var totalSize = (TIFF_TYPE_SIZE_[type] || 1) * count;
    // 使うタグの値だけ読む(使わない大きな値の読み足しを避ける)
    if ([256, 257, 262, 277, 282, 283, 296].indexOf(tag) === -1) continue;
    var valueBytes = totalSize <= 4
      ? entries.subarray(eOff + 8, eOff + 8 + totalSize)
      : reader.getBytes(readUint32_(entries, eOff + 8, little), totalSize);
    tags[tag] = { type: type, count: count, bytes: valueBytes };
  }

  function readIntTag(tagId) {
    var t = tags[tagId];
    if (!t) return null;
    if (t.type === 3) return readUint16_(t.bytes, 0, little);
    if (t.type === 4) return readUint32_(t.bytes, 0, little);
    return null;
  }
  function readRationalTag(tagId) {
    var t = tags[tagId];
    if (!t) return null;
    var num = readUint32_(t.bytes, 0, little);
    var den = readUint32_(t.bytes, 4, little);
    return den ? num / den : null;
  }

  var resUnit = readIntTag(296) || 2; // 既定: inch
  var xRes = readRationalTag(282);
  var yRes = readRationalTag(283);
  if (resUnit === 3) { // cm → inch
    if (xRes != null) xRes *= 2.54;
    if (yRes != null) yRes *= 2.54;
  } else if (resUnit === 1) {
    xRes = null; yRes = null; // 絶対単位なし
  }

  return {
    width: readIntTag(256),
    height: readIntTag(257),
    dpiX: xRes != null ? Math.round(xRes) : null,
    dpiY: yRes != null ? Math.round(yRes) : null,
    colorMode: classifyColorMode_(readIntTag(262), readIntTag(277) || 1)
  };
}

/** PhotometricInterpretation(262) と SamplesPerPixel(277) からカラーモードを判定。 */
function classifyColorMode_(photometric, samples) {
  switch (photometric) {
    case 0:
    case 1: return 'グレースケール';
    case 2: return 'RGB';
    case 3: return 'パレットカラー';
    case 5: return 'CMYK';
    case 6: return 'YCbCr';
    case 8:
    case 9: return 'Lab';
    default:
      if (photometric == null) return samples >= 3 ? 'カラー' : '不明';
      return 'その他(' + photometric + ')';
  }
}

/** JPEG: マーカーを順にたどり、APP0(JFIF)の解像度と SOFn の寸法・成分数を読む。GitHub Pages 版 parseJpegSpec と同じ判定。 */
function parseJpegSpec_(reader) {
  var soi = reader.getBytes(0, 2);
  if (!(soi[0] === 0xFF && soi[1] === 0xD8)) throw new Error('JPEG形式ではありません');
  var offset = 2;
  var dpiX = null, dpiY = null, width = null, height = null, comps = null;
  for (var guard = 0; guard < 2000; guard++) {
    var hdr = reader.getBytes(offset, 2);
    while (hdr[0] === 0xFF && hdr[1] === 0xFF) { offset += 1; hdr = reader.getBytes(offset, 2); }
    if (hdr[0] !== 0xFF) { offset += 1; continue; }
    var marker = hdr[1];
    offset += 2;
    if (marker === 0xD8 || marker === 0xD9 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) continue;
    var lenB = reader.getBytes(offset, 2);
    var segLen = (lenB[0] << 8) | lenB[1];
    var segStart = offset + 2;
    if (marker === 0xE0) {
      var d = reader.getBytes(segStart, Math.min(Math.max(segLen - 2, 1), 16));
      if (d.length >= 12 && d[0] === 0x4A && d[1] === 0x46 && d[2] === 0x49 && d[3] === 0x46 && d[4] === 0x00) {
        var units = d[7];
        var xd = (d[8] << 8) | d[9];
        var yd = (d[10] << 8) | d[11];
        if (units === 1) { dpiX = xd; dpiY = yd; }
        else if (units === 2) { dpiX = Math.round(xd * 2.54); dpiY = Math.round(yd * 2.54); }
      }
    } else if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      var s = reader.getBytes(segStart, 6);
      height = (s[1] << 8) | s[2];
      width = (s[3] << 8) | s[4];
      comps = s[5];
      break;
    }
    offset = segStart + (segLen - 2);
  }
  if (width == null || height == null) throw new Error('JPEGの寸法情報が見つかりません');
  var colorMode;
  if (comps === 1) colorMode = 'グレースケール';
  else if (comps === 4) colorMode = 'CMYK';
  else if (comps === 3) colorMode = 'カラー';
  else colorMode = comps ? 'カラー' : '不明';
  return { width: width, height: height, dpiX: dpiX, dpiY: dpiY, colorMode: colorMode };
}

// ============================================================
// 取引先マスタ(利用者本人の権限で読み書き。GitHub Pages 版と同じシート)
// ============================================================

/** 返り値: { ok: true, values }(Sheets API の値配列。1行目は見出し) / { ok: false, status } */
function api_loadMaster() {
  requireAllowed_();
  var res = googleApiGet_(buildSheetsValuesUrl_(MASTER_SHEET_ID, MASTER_RANGE));
  if (res.status !== 200) return { ok: false, status: res.status };
  return { ok: true, values: JSON.parse(res.text).values || [] };
}

/** rowValues: [取引先名, 幅px, 高さpx, DPI, カラーモード, 幅判定, 高さ判定, 拡張子] / rowNumber: 上書きする行(新規なら null) */
function api_saveMasterRow(rowValues, rowNumber) {
  requireAllowed_();
  var values = normalizeMasterRow_(rowValues);
  ensureMasterHeaderRow_();
  var res;
  if (rowNumber != null && rowNumber !== '') {
    var n = validMasterRowNumber_(rowNumber);
    res = googleApiSend_('put', buildSheetsValuesUrl_(MASTER_SHEET_ID, 'A' + n + ':H' + n) + '?valueInputOption=RAW', { values: [values] });
  } else {
    res = googleApiSend_('post', buildSheetsValuesUrl_(MASTER_SHEET_ID, MASTER_RANGE) + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', { values: [values] });
  }
  if (res.status !== 200) throw new Error(masterWriteErrorMessage_(res.status));
  return { ok: true };
}

/** 行を削除する。読み込み後に他の人が行を足し引きしていたら、別の行を消さないよう止める。 */
function api_deleteMasterRow(rowNumber, expectedName) {
  requireAllowed_();
  var n = validMasterRowNumber_(rowNumber);
  var cur = googleApiGet_(buildSheetsValuesUrl_(MASTER_SHEET_ID, 'A' + n));
  if (cur.status !== 200) throw new Error(masterWriteErrorMessage_(cur.status));
  var curValues = JSON.parse(cur.text).values || [];
  var curName = curValues[0] && curValues[0][0] != null ? String(curValues[0][0]) : '';
  if (curName !== String(expectedName == null ? '' : expectedName)) {
    throw new Error('マスタが更新されています。「一覧を再読み込み」してから、もう一度削除してください。');
  }
  var meta = googleApiGet_('https://sheets.googleapis.com/v4/spreadsheets/' + MASTER_SHEET_ID + '?fields=sheets.properties.sheetId');
  if (meta.status !== 200) throw new Error(masterWriteErrorMessage_(meta.status));
  var sheetId = JSON.parse(meta.text).sheets[0].properties.sheetId;
  var res = googleApiSend_('post', 'https://sheets.googleapis.com/v4/spreadsheets/' + MASTER_SHEET_ID + ':batchUpdate', {
    requests: [{ deleteDimension: { range: { sheetId: sheetId, dimension: 'ROWS', startIndex: n - 1, endIndex: n } } }]
  });
  if (res.status !== 200) throw new Error(masterWriteErrorMessage_(res.status));
  return { ok: true };
}

function ensureMasterHeaderRow_() {
  var res = googleApiGet_(buildSheetsValuesUrl_(MASTER_SHEET_ID, 'A1:H1'));
  if (res.status !== 200) throw new Error(masterWriteErrorMessage_(res.status));
  var row = (JSON.parse(res.text).values || [])[0] || [];
  var complete = MASTER_HEADER.every(function (h, i) { return row[i]; });
  if (complete) return;
  var put = googleApiSend_('put', buildSheetsValuesUrl_(MASTER_SHEET_ID, 'A1:H1') + '?valueInputOption=RAW', { values: [MASTER_HEADER] });
  if (put.status !== 200) throw new Error(masterWriteErrorMessage_(put.status));
}

// ============================================================
// 純粋ロジック(GAS API非依存・tests/server.test.mjs でテスト)
// ============================================================

function normalizeEmail_(email) {
  return String(email == null ? '' : email).trim().toLowerCase();
}

/** フォルダURL(/folders/…、?id=…)または素のIDからフォルダIDを取り出す。読めなければ ''。 */
function extractFolderId_(input) {
  var s = String(input == null ? '' : input).trim();
  if (!s) return '';
  var m = s.match(/\/folders\/([-\w]{10,})/) || s.match(/[?&]id=([-\w]{10,})/);
  if (m) return m[1];
  var bare = s.split(/[?#]/)[0].split('/').pop();
  return /^[-\w]{10,}$/.test(bare) ? bare : '';
}

function buildDriveListUrl_(folderId, pageToken) {
  var q = encodeURIComponent("'" + folderId + "' in parents and trashed = false");
  var fields = encodeURIComponent('nextPageToken, files(id,name,mimeType,size,webViewLink)');
  var url = 'https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=' + fields +
    '&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives';
  return pageToken ? url + '&pageToken=' + encodeURIComponent(pageToken) : url;
}

function buildDriveMediaUrl_(fileId) {
  return 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media&supportsAllDrives=true';
}

function buildSheetsValuesUrl_(spreadsheetId, range) {
  return 'https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + '/values/' + encodeURIComponent(range);
}

var MASTER_OPS_ = ['ちょうど', '以上', '以下'];
var MASTER_COLORS_ = ['', 'グレースケール', 'カラー'];
var MASTER_EXTS_ = ['', 'tiff', 'tif', 'jpg', 'jpeg', 'png'];

/** 画面から来たマスタ1行を検証して、書き込む値の配列にする(不正なら例外)。 */
function normalizeMasterRow_(rowValues) {
  if (!Array.isArray(rowValues) || rowValues.length !== MASTER_HEADER.length) throw new Error('マスタの行の形式が正しくありません');
  var v = rowValues.map(function (x) { return String(x == null ? '' : x).trim(); });
  if (!v[0]) throw new Error('取引先名を入力してください');
  if (v[0].length > 100) throw new Error('取引先名が長すぎます(100文字まで)');
  [1, 2, 3].forEach(function (i) {
    if (v[i] && !/^\d{1,6}$/.test(v[i])) throw new Error(MASTER_HEADER[i] + ' は数字で入力してください');
  });
  if (MASTER_COLORS_.indexOf(v[4]) === -1) throw new Error('カラーモードの値が正しくありません');
  if (MASTER_OPS_.indexOf(v[5]) === -1 || MASTER_OPS_.indexOf(v[6]) === -1) throw new Error('幅・高さの判定の値が正しくありません');
  if (MASTER_EXTS_.indexOf(v[7]) === -1) throw new Error('拡張子の値が正しくありません');
  if (!v[1] && !v[2] && !v[3] && !v[4] && !v[7]) throw new Error('幅・高さ・DPI・カラーモード・拡張子のうち、少なくとも1つは条件を設定してください');
  return v;
}

function validMasterRowNumber_(rowNumber) {
  var n = Number(rowNumber);
  if (!(n >= 2 && Math.floor(n) === n)) throw new Error('マスタの行番号が正しくありません');
  return n;
}

function masterWriteErrorMessage_(status) {
  if (status === 403) return '取引先マスタを編集する権限がありません(HTTP 403)。管理者にマスタの共有(編集者)を依頼してください。';
  if (status === 404) return '取引先マスタが見つかりません(HTTP 404)。';
  return '取引先マスタの読み書きに失敗しました(HTTP ' + status + ')。時間をおいて再度お試しください。';
}

/** テンプレートの <script> に埋め込むJSON。</script> で閉じられないよう < をエスケープする。 */
function bootJsonForHtml_(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}
