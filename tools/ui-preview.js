#!/usr/bin/env node
/**
 * ui-preview.js — 原稿サイズチェッカー GAS 版（gas/src/index.html）の画面を **GAS を通さずに** ローカルで開いて触る開発ツール
 *   node tools/ui-preview.js                  → http://127.0.0.1:8814/
 *   node tools/ui-preview.js --shot a.png     → ヘッドレス Chrome で1枚撮って終わる（最初の画面＝お知らせ）
 *   node tools/ui-preview.js --shot a.png --path '/?demo=1'   → チェック画面で「取引先を選ぶ → フォルダ → チェック開始」まで自動で進めた状態
 * 仕組みは共通の土台 mangatari-ci-common/tools/ui-preview/（同じフォルダに clone してあること）。
 * GitHub Pages 版（リポジトリ直下の index.html）はそのままブラウザで開けるので、ここでは扱わない。
 *
 * 画面側の戻り値は手で書かない。gas/src/*.gs を **本物のまま** Node で読み込み（gas-stubs.js）、外側だけをダミーにする:
 *   - Drive の REST（UrlFetchApp.fetch / fetchAll）… 下の「ダミーの Drive」。画像の中身は tests/fixtures.json の本物の小さな TIFF/JPEG
 *     （Range 指定にも答えるので、先頭だけ読む → 足りなければ読み足す の流れも本物のまま通る）
 *   - 取引先マスタ（Sheets の REST）… メモリ上の表。保存・削除してもメモリが変わるだけ
 * ?demo=1 は画面側に無い機能なので、プレビューだけで右上の部品の後ろに「自動で操作する」数行を足している。
 * tools/ は GAS の rootDir（gas/src）の外なので GAS には push されない。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const UI = path.join(__dirname, '..', '..', 'mangatari-ci-common', 'tools', 'ui-preview');
if (!fs.existsSync(path.join(UI, 'gas-stubs.js'))) {
  console.error('mangatari-ci-common が同じフォルダにありません（または古い）: ' + UI + '\n  git clone / git pull してから試してください');
  process.exit(1);
}
const G = require(path.join(UI, 'gas.js'));
const { loadServer } = require(path.join(UI, 'gas-stubs.js'));

const SRC = path.join(__dirname, '..', 'gas', 'src');
const EMAIL = 'preview@mangatari.co.jp';
const FOLDER = 'application/vnd.google-apps.folder';
const SAMPLE = {};
require(path.join(__dirname, '..', 'tests', 'fixtures.json')).forEach((f) => { SAMPLE[f.key] = Buffer.from(f.b64, 'base64'); });

// ---- ダミーの Drive ----
const nodes = {};
let seq = 0;
function add(parent, name, sample, id) {
  id = id || 'PRV' + String(++seq).padStart(8, '0');
  nodes[id] = { id, name, parent, sample, mimeType: !sample ? FOLDER : /\.jpe?g$/.test(name) ? 'image/jpeg' : /\.psd$/.test(name) ? 'image/vnd.adobe.photoshop' : 'image/tiff' };
  return id;
}
const ROOT_FOLDER = add(null, '001_全提出データ_TIF', null, 'PRVfolder0001');
const vol1 = add(ROOT_FOLDER, '01巻');
for (let p = 1; p <= 12; p++) {
  if (p === 8) continue; // 欠番
  add(vol1, `352974_001_${String(p).padStart(3, '0')}.tif`, p === 5 ? 'tif_rgb' : 'tif_gray');
}
add(vol1, '352974_001_003.psd', 'tif_gray');
const vol2 = add(ROOT_FOLDER, '02巻');
for (let p = 1; p <= 6; p++) add(vol2, `352974_002_${String(p).padStart(3, '0')}.tif`, p === 6 ? 'tif_cmyk' : 'tif_gray');
add(vol2, 'おまけ_001.jpg', 'jpg_gray');

// ---- ダミーの取引先マスタ（A:H） ----
const master = [
  ['取引先名', '幅px', '高さpx', 'DPI', 'カラーモード', '幅判定', '高さ判定', '拡張子'],
  ['プレビュー出版（本文）', '300', '400', '350', 'グレースケール', 'ちょうど', 'ちょうど', 'tif'],
  ['コミックシーモア（合本版）', '4299', '6071', '600', 'グレースケール', 'ちょうど', 'ちょうど', 'tif'],
  ['めちゃコミック', '1200', '', '', '', '以上', 'ちょうど', 'jpg'],
];

function respond(status, body, extra) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return { getResponseCode: () => status, getContentText: () => buf.toString('utf8'), getContent: () => Array.from(buf).map((x) => (x > 127 ? x - 256 : x)), getHeaders: () => (extra || {}) };
}
function fakeGoogleApi(url, opts) {
  const u = new URL(url);
  const method = String((opts && opts.method) || 'get').toLowerCase();
  let m;
  if (u.pathname === '/drive/v3/files') {
    const parent = (u.searchParams.get('q').match(/'([^']+)' in parents/) || [])[1];
    if (!nodes[parent]) return respond(404, { error: { message: 'File not found' } });
    return respond(200, { files: Object.values(nodes).filter((n) => n.parent === parent).map((n) => ({
      id: n.id, name: n.name, mimeType: n.mimeType, size: n.sample ? String(SAMPLE[n.sample].length) : undefined,
      webViewLink: 'https://drive.google.com/file/d/' + n.id + '/view' })) });
  }
  if ((m = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/)) && u.searchParams.get('alt') === 'media') {
    const n = nodes[decodeURIComponent(m[1])];
    if (!n || !n.sample) return respond(404, '');
    const bytes = SAMPLE[n.sample];
    const range = /bytes=(\d+)-(\d+)/.exec((opts && opts.headers && opts.headers.Range) || '');
    if (!range) return respond(200, bytes);
    const start = Number(range[1]);
    if (start >= bytes.length) return respond(416, '');
    return respond(206, bytes.subarray(start, Number(range[2]) + 1));
  }
  if (u.hostname === 'sheets.googleapis.com') return fakeSheets(u, method, opts);
  throw new Error('プレビューでは外部通信は使えません: ' + u.hostname + u.pathname);
}
/** 取引先マスタの Sheets API（values の GET / PUT / append と、行削除の batchUpdate だけ） */
function fakeSheets(u, method, opts) {
  const body = opts && opts.payload ? JSON.parse(opts.payload) : null;
  if (/:batchUpdate$/.test(u.pathname)) {
    const r = body.requests[0].deleteDimension.range;
    master.splice(r.startIndex, r.endIndex - r.startIndex);
    return respond(200, {});
  }
  if (!/\/values\//.test(u.pathname)) return respond(200, { sheets: [{ properties: { sheetId: 0 } }] });
  const range = decodeURIComponent(u.pathname.split('/values/')[1]).replace(/:append$/, '');
  if (/:append$/.test(u.pathname)) { master.push(body.values[0]); return respond(200, {}); }
  const cell = /^A(\d+)(?::H(\d+))?$/.exec(range);
  if (method === 'put' && cell) { master[Number(cell[1]) - 1] = body.values[0]; return respond(200, {}); }
  if (range === 'A:H') return respond(200, { values: master });
  if (cell) return respond(200, { values: master.slice(Number(cell[1]) - 1, Number(cell[2] || cell[1])).map((row) => (cell[2] ? row : row.slice(0, 1))) });
  return respond(400, { error: { message: 'プレビューに無い範囲です: ' + range } });
}

const S = loadServer(SRC, ['Config.gs', 'Code.gs', 'PeopleHubSync.gs'], {
  email: EMAIL,
  extra: {
    UrlFetchApp: {
      fetch: (url, opts) => fakeGoogleApi(url, opts),
      fetchAll: (reqs) => reqs.map((r) => fakeGoogleApi(r.url, r)),
    },
    encodeURIComponent,
  },
});

// 画面から呼ぶ api_* を、そのまま本物につなぐ。管理メニューの「今すぐ同期」はプレビューでは何もしない
const handlers = {};
Object.keys(S).forEach((k) => { if (typeof S[k] === 'function' && /^api_/.test(k)) handlers[k] = (args) => S[k](...args); });
handlers.syncAllowedEmails = () => ({ ok: true, skipped: true, message: 'プレビューでは同期しません' });

// プレビューだけの足し算: ?demo=1 なら、取引先マスタを読み終えたところで チェック画面 → 取引先 → フォルダ（01巻）→ チェック開始 まで進める
const DEMO = '<script>\n(function(){ if (!/[?&]demo=1/.test(location.search)) return;\n'
  + '  var t = setInterval(function(){ var sel = document.getElementById("runClientSelect"); if (!sel || sel.options.length < 2) return; clearInterval(t);\n'
  + '    showView("view-run"); sel.value = "0"; sel.dispatchEvent(new Event("change"));\n'
  + '    document.getElementById("folderList").value = "https:" + "/" + "/drive.google.com/drive/folders/' + vol1 + '";\n'
  + '    document.getElementById("recursiveCheck").checked = false; document.getElementById("runCheckBtn").click();\n    var g = document.getElementById("usageGuide"); if (g) g.open = false; }, 100); })();\n'
  + '<' + '/script>';

const VIEWER = { email: EMAIL, displayName: 'プレビュー太郎', isAdmin: true };
G.run({
  name: '原稿サイズチェッカー',
  root: SRC,
  port: 8814,
  viewer: VIEWER,
  pages: {
    '/': {
      file: 'index', label: '最初の画面（?demo=1 でチェック結果まで進める）',
      vars: (q) => ({
        bootJson: S.bootJsonForHtml_({ email: EMAIL, isAdmin: true, toolUrl: 'https://script.google.com/macros/s/PREVIEW/exec',
          masterSheetUrl: 'https://docs.google.com/spreadsheets/d/PREVIEW-MASTER/edit', slackChannel: '#dev_原稿サイズチェッカー',
          portalUrl: 'https://example.com/portal', setup: null }),
        headerKitHtml: G.headerKitHtml(VIEWER, '原稿サイズチェッカー') + (q.demo ? DEMO : ''),
      }),
    },
    '/denied': {
      file: 'denied', label: '拒否画面（未許可の人）',
      vars: () => ({ email: 'someone@example.com', deniedTitle: 'このツールを使う権限がありません', deniedMessage: '原稿サイズチェッカーは、登録された人だけが使えます。',
        portalUrl: 'https://example.com/portal', slackChannel: '#dev_原稿サイズチェッカー' }),
    },
  },
  handlers,
});
