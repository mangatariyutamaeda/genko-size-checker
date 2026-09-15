// GAS版サーバ側(gas/src/*.gs)の単体テスト。GASランタイムはモックし、実ファイルを vm で読み込んで本物の関数を検証する。
// 実行: node --test gas/tests/server.test.mjs   (または npm run test:gas)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const FIXTURES = JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'tests', 'fixtures.json'), 'utf8'));
const ADMIN = 'mangatari.yuta.maeda@gmail.com';
const STAFF = 'staff@example.com';
const DRIVE_MEDIA = /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^?]+)\?alt=media/;

// state: email / allowed / admins / acThrows / files(id→Buffer) / responses(url→{status,body}) / calls
function load(state = {}) {
  const s = Object.assign({
    email: '', props: {}, noDbDefault: false, allowed: [], admins: [], acThrows: false,
    files: {}, responses: {}, calls: [], rangeCalls: [], triggers: [], hubUsers: [], sheetRows: [],
  }, state);
  const respond = (url, opts) => {
    s.calls.push({ url, method: (opts.method || 'get').toLowerCase(), payload: opts.payload ? JSON.parse(opts.payload) : null });
    const r = s.responses[url] || { status: 404, body: '' };
    return { getResponseCode: () => r.status, getContentText: () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  };
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in s.props ? s.props[k] : null) }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => s.email }) },
    AccessControl: {
      isAllowedEmail: (e) => { if (s.acThrows) throw new Error('boom'); return s.allowed.includes(e); },
      isAdminEmail: (e) => { if (s.acThrows) throw new Error('boom'); return s.admins.includes(e); },
      loadPeopleHubToolUsers: () => s.hubUsers,
      loadPeopleHubDisplayNames: () => ({}),
      computeAllowedEmailsSyncPlan: (existing, desired) => ({ desired }),
      applyAllowedEmailsSyncPlan: (sheet, plan) => { s.sheetRows = plan.desired; return { added: plan.desired.length, updated: 0, removed: 0, unchanged: 0 }; },
      invalidateAllowedEmailsCache: () => {},
    },
    SpreadsheetApp: {
      openById: () => {
        const sheet = { rows: 0, getLastRow: () => sheet.rows, getRange: () => ({ setValues: (v) => { sheet.rows += v.length; }, getValues: () => [] }), setFrozenRows: () => {} };
        return { getSheetByName: () => null, insertSheet: () => sheet };
      },
    },
    ScriptApp: {
      getOAuthToken: () => 'TOKEN',
      getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/G/exec' }),
      getProjectTriggers: () => s.triggers.map(fn => ({ getHandlerFunction: () => fn })),
      deleteTrigger: () => {},
      newTrigger: (fn) => { const t = { timeBased: () => t, atHour: () => t, everyDays: () => t, create: () => s.triggers.push(fn) }; return t; },
    },
    UrlFetchApp: {
      fetch: respond,
      // Drive の部分取得をファイルの Buffer から再現する(GASと同じく getContent は -128〜127 の配列)
      fetchAll: (reqs) => reqs.map((req) => {
        const id = decodeURIComponent(req.url.match(DRIVE_MEDIA)[1]);
        const [a, b] = req.headers.Range.replace('bytes=', '').split('-').map(Number);
        s.rangeCalls.push({ id, start: a, end: b });
        const buf = s.files[id];
        if (buf === 403) return { getResponseCode: () => 403, getContent: () => [] };
        if (!buf) return { getResponseCode: () => 404, getContent: () => [] };
        if (a >= buf.length) return { getResponseCode: () => 416, getContent: () => [] };
        const part = buf.subarray(a, Math.min(b + 1, buf.length));
        return { getResponseCode: () => 206, getContent: () => Array.from(part, (x) => (x > 127 ? x - 256 : x)) };
      }),
    },
    Utilities: { formatDate: () => '2026-09-16' },
    HtmlService: {
      createTemplateFromFile: (name) => ({ name, evaluate() { const self = this; return { setTitle() { return this; }, addMetaTag() { return this; }, template: self }; } }),
    },
    encodeURIComponent, Uint8Array,
  };
  vm.createContext(ctx);
  for (const f of ['Config.gs', 'Code.gs', 'PeopleHubSync.gs']) {
    vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
  }
  if (s.noDbDefault) ctx.DB_SPREADSHEET_ID_DEFAULT = '';
  ctx.__state = s;
  return ctx;
}
const plain = (x) => JSON.parse(JSON.stringify(x));

// ---- 合成画像: IFD がファイル末尾側にある TIFF / 前置きが長い JPEG(先頭64KBでは読み切れない) ----
function tiffWithFarIfd({ width, height, dpi, photometric, ifdOffset }) {
  const entries = [[256, 3, 1, width], [257, 4, 1, height], [262, 3, 1, photometric], [277, 3, 1, 1], [282, 5, 1, 'X'], [283, 5, 1, 'Y'], [296, 3, 1, 2]];
  const ifdSize = 2 + entries.length * 12 + 4;
  const buf = Buffer.alloc(ifdOffset + ifdSize + 16);
  buf.write('II', 0, 'latin1'); buf.writeUInt16LE(42, 2); buf.writeUInt32LE(ifdOffset, 4);
  buf.writeUInt16LE(entries.length, ifdOffset);
  const ratAt = ifdOffset + ifdSize;
  entries.forEach(([tag, type, count, v], i) => {
    const o = ifdOffset + 2 + i * 12;
    buf.writeUInt16LE(tag, o); buf.writeUInt16LE(type, o + 2); buf.writeUInt32LE(count, o + 4);
    if (type === 5) buf.writeUInt32LE(ratAt + (v === 'X' ? 0 : 8), o + 8);
    else if (type === 3) buf.writeUInt16LE(v, o + 8);
    else buf.writeUInt32LE(v, o + 8);
  });
  buf.writeUInt32LE(dpi, ratAt); buf.writeUInt32LE(1, ratAt + 4); buf.writeUInt32LE(dpi, ratAt + 8); buf.writeUInt32LE(1, ratAt + 12);
  return buf;
}
function jpegWithLongPreamble({ width, height, dpi, comps }) {
  const parts = [Buffer.from([0xFF, 0xD8])];
  const app0 = Buffer.from([0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 1, 1, 1, dpi >> 8, dpi & 255, dpi >> 8, dpi & 255, 0, 0]);
  parts.push(app0);
  for (let i = 0; i < 2; i++) { // ICCプロファイル相当の大きなAPP2を2つ(約120KB)
    const seg = Buffer.alloc(2 + 60000); seg[0] = 0xFF; seg[1] = 0xE2; seg.writeUInt16BE(60000, 2);
    parts.push(seg);
  }
  parts.push(Buffer.from([0xFF, 0xC0, 0x00, 0x11, 8, height >> 8, height & 255, width >> 8, width & 255, comps]), Buffer.alloc(14));
  parts.push(Buffer.from([0xFF, 0xD9]));
  return Buffer.concat(parts);
}

test('appsscript.json: USER_ACCESSING + ANYONE、Driveは読み取り専用スコープ', () => {
  const m = JSON.parse(fs.readFileSync(path.join(SRC, 'appsscript.json'), 'utf8'));
  assert.equal(m.webapp.executeAs, 'USER_ACCESSING');
  assert.equal(m.webapp.access, 'ANYONE');
  assert.ok(m.oauthScopes.includes('https://www.googleapis.com/auth/drive.readonly'));
  assert.ok(!m.oauthScopes.includes('https://www.googleapis.com/auth/drive'));
});

test('doGet: 未登録は拒否画面、登録済みは本画面(マスタURL・Slackチャンネルを渡す)', () => {
  assert.equal(load({ email: '' }).doGet({}).template.name, 'denied');
  assert.equal(load({ email: 'stranger@gmail.com' }).doGet({}).template.name, 'denied');
  const ok = load({ email: STAFF, allowed: [STAFF] }).doGet({});
  assert.equal(ok.template.name, 'index');
  const boot = JSON.parse(ok.template.bootJson);
  assert.equal(boot.email, STAFF);
  assert.equal(boot.masterSheetUrl, 'https://docs.google.com/spreadsheets/d/1QnYqQA7NpSkhuC5dUL8klBaeTQc2EjYDcACROG3OBRU/edit');
  assert.equal(boot.slackChannel, '#dev_原稿サイズチェッカー');
  assert.equal(boot.setup, null);
});

test('isAllowed_: fail-closed(DB未設定・ライブラリ例外は拒否)、ADMIN_EMAILS は常に許可', () => {
  assert.equal(load({ noDbDefault: true, allowed: [STAFF] }).isAllowed_(STAFF), false);
  assert.equal(load({ allowed: [STAFF], acThrows: true }).isAllowed_(STAFF), false);
  assert.equal(load({ acThrows: true }).isAllowed_(ADMIN), true);
});

test('画面用API・管理用関数は、未登録の人/管理者以外に実行させない(google.script.run から呼べるため)', () => {
  const calls = { api_listFolders: [['1AbCdEfGhIjKlMnOp'], false], api_inspectImages: [[{ id: '1AbCdEfGhIjKlMnOp', name: 'a.tif' }]],
    api_loadMaster: [], api_saveMasterRow: [['A', '1', '', '', '', 'ちょうど', 'ちょうど', '']], api_deleteMasterRow: [2, 'A'] };
  for (const [fn, args] of Object.entries(calls)) {
    const ctx = load({ email: 'stranger@gmail.com' });
    assert.throws(() => ctx[fn](...args), /権限がありません/, fn);
    assert.equal(ctx.__state.calls.length + ctx.__state.rangeCalls.length, 0, fn + ' は何も読まない');
  }
  for (const fn of ['setupAccessSheet', 'syncAllowedEmails', 'installAccessSyncTrigger', 'uninstallAccessSyncTrigger']) {
    assert.throws(() => load({ email: STAFF, allowed: [STAFF] })[fn](), /管理者のみ/, fn);
  }
});

test('画像の解析: 実画像(tests/fixtures.json)の寸法・DPI・カラーモードが GitHub Pages 版と同じになる', () => {
  const ctx = load({ email: STAFF, allowed: [STAFF] });
  for (const fx of FIXTURES) {
    const id = 'fixture_' + fx.key + '_0000';
    ctx.__state.files[id] = Buffer.from(fx.b64, 'base64');
    const [r] = plain(ctx.api_inspectImages([{ id, name: 'sample.' + fx.fmt }]));
    assert.ok(r.spec, fx.key + ': ' + JSON.stringify(r));
    assert.deepEqual({ width: r.spec.width, height: r.spec.height, dpiX: r.spec.dpiX, colorMode: r.spec.colorMode }, fx.exp, fx.key);
  }
});

test('画像の解析: 先頭64KBに無い情報は、その位置だけ並列に読み足す', () => {
  const ctx = load({ email: STAFF, allowed: [STAFF] });
  ctx.__state.files.far_tiff_0000000 = tiffWithFarIfd({ width: 5186, height: 7323, dpi: 600, photometric: 1, ifdOffset: 300000 });
  ctx.__state.files.long_jpeg_000000 = jpegWithLongPreamble({ width: 5186, height: 7323, dpi: 350, comps: 3 });
  ctx.__state.files.small_tif_000000 = Buffer.from(FIXTURES.find(f => f.key === 'tif_gray').b64, 'base64');
  const out = plain(ctx.api_inspectImages([
    { id: 'far_tiff_0000000', name: 'p_003.tif' }, { id: 'long_jpeg_000000', name: 'p_004.jpg' }, { id: 'small_tif_000000', name: 'p_005.tif' },
  ]));
  assert.deepEqual(out[0].spec, { width: 5186, height: 7323, dpiX: 600, dpiY: 600, colorMode: 'グレースケール' });
  assert.deepEqual(out[1].spec, { width: 5186, height: 7323, dpiX: 350, dpiY: 350, colorMode: 'カラー' });
  assert.equal(out[2].spec.width, 300);
  const perFile = (id) => ctx.__state.rangeCalls.filter(c => c.id === id);
  assert.equal(perFile('small_tif_000000').length, 1, '小さいファイルは1回で済む');
  assert.ok(perFile('far_tiff_0000000').length >= 2 && perFile('far_tiff_0000000').length <= 3, 'IFDが遠いTIFFは読み足しが入り、数回で読める');
  assert.ok(perFile('long_jpeg_000000').length >= 2, '前置きが長いJPEGも読み足しが入る');
  assert.ok(ctx.__state.rangeCalls.every(c => c.end - c.start + 1 <= 64 * 1024), 'ファイル全体はダウンロードしない');
});

test('画像の解析: 権限なし・壊れたファイル・不正なIDはファイルごとのエラーで返し、他のファイルは解析する', () => {
  const ctx = load({ email: STAFF, allowed: [STAFF] });
  const good = Buffer.from(FIXTURES.find(f => f.key === 'jpg_gray').b64, 'base64');
  ctx.__state.files.good_jpg_0000000 = good;
  ctx.__state.files.forbidden_000000 = 403;
  ctx.__state.files.truncated_tif_00 = tiffWithFarIfd({ width: 1, height: 1, dpi: 1, photometric: 1, ifdOffset: 300000 }).subarray(0, 1000);
  ctx.__state.files.not_image_00000 = Buffer.from('hello world, not an image');
  const out = plain(ctx.api_inspectImages([
    { id: 'good_jpg_0000000', name: 'a.jpg' }, { id: 'forbidden_000000', name: 'b.tif' },
    { id: 'truncated_tif_00', name: 'c.tif' }, { id: 'not_image_00000', name: 'd.tif' }, { id: '../x', name: 'e.tif' },
  ]));
  assert.equal(out[0].spec.colorMode, 'グレースケール');
  assert.match(out[1].error, /HTTP 403/);
  assert.match(out[2].error, /途中で切れている/);
  assert.match(out[3].error, /TIFF形式ではありません/);
  assert.match(out[4].error, /不正なファイルID/);
});

test('applyRangeResponse_: GASの符号付きバイト配列を 0〜255 に直す', () => {
  const ctx = load();
  const st = { chunks: [], eof: null, result: null };
  ctx.applyRangeResponse_(st, 0, 4, 206, [-1, -40, 73, 73]);
  assert.deepEqual(Array.from(st.chunks[0].bytes), [255, 216, 73, 73]);
  assert.equal(st.eof, null, '要求どおりの長さなら終端は不明のまま');
});

test('api_listFolders: サブフォルダをたどり、ページ送りし、フォルダ自体は返さない', () => {
  const ctx = load({ email: STAFF, allowed: [STAFF] });
  const r = ctx.__state.responses;
  r[ctx.buildDriveListUrl_('ROOTFOLDER01', '')] = { status: 200, body: { nextPageToken: 'P2', files: [
    { id: 'f1', name: 'a_001.tif', mimeType: 'image/tiff', size: '123', webViewLink: 'L1' },
    { id: 'SUBFOLDER001', name: 'psd', mimeType: 'application/vnd.google-apps.folder' },
  ] } };
  r[ctx.buildDriveListUrl_('ROOTFOLDER01', 'P2')] = { status: 200, body: { files: [{ id: 'f2', name: 'a_002.tif', mimeType: 'image/tiff' }] } };
  r[ctx.buildDriveListUrl_('SUBFOLDER001', '')] = { status: 200, body: { files: [{ id: 'f3', name: 'a_001.psd', mimeType: 'image/vnd.adobe.photoshop' }] } };

  const flat = plain(ctx.api_listFolders(['https://drive.google.com/drive/folders/ROOTFOLDER01?usp=sharing'], false));
  assert.deepEqual(flat.files.map(f => f.id), ['f1', 'f2']);
  const deep = plain(ctx.api_listFolders(['ROOTFOLDER01'], true));
  assert.deepEqual(deep.files.map(f => [f.id, f.folder, f.root]), [['f1', 'ROOTFOLDER01', 'ROOTFOLDER01'], ['f3', 'ROOTFOLDER01 / psd', 'ROOTFOLDER01'], ['f2', 'ROOTFOLDER01', 'ROOTFOLDER01']]);
  assert.equal(deep.files[0].size, 123);

  assert.throws(() => ctx.api_listFolders(['NOPEFOLDER01'], false), /フォルダ一覧取得に失敗しました \(HTTP 404\)/);
  assert.throws(() => ctx.api_listFolders(['台割フォルダ'], false), /フォルダのURL\(またはID\)として読めません/);
  assert.throws(() => ctx.api_listFolders([], false), /1つ以上/);
});

test('取引先マスタ: 読み込み・新規は append・既存行は上書き・削除は行の名前を確かめてから', () => {
  const ctx = load({ email: STAFF, allowed: [STAFF] });
  const M = '1QnYqQA7NpSkhuC5dUL8klBaeTQc2EjYDcACROG3OBRU';
  const r = ctx.__state.responses;
  const values = (range) => ctx.buildSheetsValuesUrl_(M, range);
  r[values('A:H')] = { status: 200, body: { values: [['取引先名'], ['シーモア', '5186']] } };
  assert.deepEqual(plain(ctx.api_loadMaster()), { ok: true, values: [['取引先名'], ['シーモア', '5186']] });

  r[values('A1:H1')] = { status: 200, body: { values: [['取引先名', '幅px', '高さpx', 'DPI', 'カラーモード', '幅判定', '高さ判定', '拡張子']] } };
  r[values('A:H') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS'] = { status: 200, body: {} };
  r[values('A3:H3') + '?valueInputOption=RAW'] = { status: 200, body: {} };
  ctx.api_saveMasterRow([' めちゃ ', '1200', '', '', '', '以上', 'ちょうど', 'jpg'], null);
  ctx.api_saveMasterRow(['シーモア', '5186', '7323', '600', 'グレースケール', 'ちょうど', 'ちょうど', 'tiff'], 3);
  const writes = ctx.__state.calls.filter(c => c.method !== 'get');
  assert.deepEqual(writes.map(w => [w.method, w.payload.values[0][0]]), [['post', 'めちゃ'], ['put', 'シーモア']]);

  r[values('A2')] = { status: 200, body: { values: [['別の取引先']] } };
  assert.throws(() => ctx.api_deleteMasterRow(2, 'シーモア'), /マスタが更新されています/);
  assert.equal(ctx.__state.calls.filter(c => c.url.includes(':batchUpdate')).length, 0, '名前が違えば消さない');

  r[values('A2')] = { status: 200, body: { values: [['シーモア']] } };
  r[`https://sheets.googleapis.com/v4/spreadsheets/${M}?fields=sheets.properties.sheetId`] = { status: 200, body: { sheets: [{ properties: { sheetId: 77 } }] } };
  r[`https://sheets.googleapis.com/v4/spreadsheets/${M}:batchUpdate`] = { status: 200, body: {} };
  ctx.api_deleteMasterRow(2, 'シーモア');
  const del = ctx.__state.calls.find(c => c.url.endsWith(':batchUpdate'));
  assert.deepEqual(del.payload.requests[0].deleteDimension.range, { sheetId: 77, dimension: 'ROWS', startIndex: 1, endIndex: 2 });
});

test('normalizeMasterRow_: 値を検証する(不正な値はシートに書かない)', () => {
  const ctx = load();
  assert.deepEqual(plain(ctx.normalizeMasterRow_(['A', ' 350 ', '', '', '', 'ちょうど', '以下', ''])), ['A', '350', '', '', '', 'ちょうど', '以下', '']);
  assert.throws(() => ctx.normalizeMasterRow_(['', '1', '', '', '', 'ちょうど', 'ちょうど', '']), /取引先名/);
  assert.throws(() => ctx.normalizeMasterRow_(['A', '=IMPORTXML()', '', '', '', 'ちょうど', 'ちょうど', '']), /数字/);
  assert.throws(() => ctx.normalizeMasterRow_(['A', '', '', '', '', 'ちょうど', 'ちょうど', '']), /少なくとも1つ/);
  assert.throws(() => ctx.normalizeMasterRow_(['A', '1', '', '', 'セピア', 'ちょうど', 'ちょうど', '']), /カラーモード/);
  assert.throws(() => ctx.normalizeMasterRow_(['A', '1']), /形式/);
  assert.throws(() => ctx.validMasterRowNumber_(1), /行番号/);
});

test('ensureInitialSetup_: 前田さんが初めて開いたときだけ 同期→トリガー設置', () => {
  const ctx = load({ email: ADMIN, hubUsers: [{ email: ADMIN, permission: '管理者' }, { email: STAFF, permission: '利用可' }] });
  const r = plain(ctx.ensureInitialSetup_(ADMIN));
  assert.equal(r.ok, true);
  assert.equal(r.sync.desired, 2);
  assert.equal(ctx.__state.triggers.length, 3);
  assert.equal(ctx.ensureInitialSetup_(ADMIN), null);
  assert.equal(load({ email: STAFF, admins: [STAFF] }).ensureInitialSetup_(STAFF), null);
});

test('extractFolderId_: フォルダURL / ?id= / 素のID / 無関係な文字列', () => {
  const ctx = load();
  assert.equal(ctx.extractFolderId_('https://drive.google.com/drive/folders/1itn2DKKo_UrFbtxtWYBv75OZRN_JohD8?usp=drive_link'), '1itn2DKKo_UrFbtxtWYBv75OZRN_JohD8');
  assert.equal(ctx.extractFolderId_('https://drive.google.com/drive/u/1/folders/1itn2DKKo_UrFbtxtWYBv75OZRN_JohD8'), '1itn2DKKo_UrFbtxtWYBv75OZRN_JohD8');
  assert.equal(ctx.extractFolderId_('https://drive.google.com/open?id=1itn2DKKo_UrFbtxtWYBv75OZRN_JohD8'), '1itn2DKKo_UrFbtxtWYBv75OZRN_JohD8');
  assert.equal(ctx.extractFolderId_(' 1itn2DKKo_UrFbtxtWYBv75OZRN_JohD8 '), '1itn2DKKo_UrFbtxtWYBv75OZRN_JohD8');
  assert.equal(ctx.extractFolderId_("x' or name contains 'a"), '');
  assert.equal(ctx.extractFolderId_(''), '');
});
