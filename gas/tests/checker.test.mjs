// 単体テスト(GAS版の画面側): gas/src/index.html 内のロジック関数を「実ソースから抽出」して検証する。
// 画像の解析はサーバ側(Code.gs)なので gas/tests/server.test.mjs、
// 判定ロジック(拡張子・寸法・DPI・カラー・ファイルセット整合性)は gas/src/Judge.gs なので
// gas/tests/judge.test.mjs で見る。ここに残すのは**画面の表示・出力の関数だけ**。
//
// 実行: node gas/tests/checker.test.mjs   (または npm run test:gas)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const scriptMatch = html.match(/<script>\n'use strict';([\s\S]*?)<\/script>/);
if (!scriptMatch) { console.error('index.html の <script> が見つかりません'); process.exit(1); }
const SRC = scriptMatch[1];

// --- ソース抽出ユーティリティ(バランスした波括弧で関数/オブジェクトを切り出す) ---
function sliceBalanced(src, braceStart) {
  let depth = 0, inStr = null;
  for (let i = braceStart; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
  }
  throw new Error('波括弧が閉じていません');
}
function extractFn(name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(SRC);
  if (!m) throw new Error('関数が見つかりません: ' + name);
  const braceStart = SRC.indexOf('{', m.index);
  return SRC.slice(m.index, sliceBalanced(SRC, braceStart));
}
function extractConst(name) {
  const re = new RegExp('const\\s+' + name + '\\s*=\\s*');
  const m = re.exec(SRC);
  if (!m) throw new Error('const が見つかりません: ' + name);
  const after = m.index + m[0].length;
  if (SRC[after] === '{' || SRC[after] === '[') {
    const open = SRC[after];
    // 配列にも対応
    if (open === '[') {
      let depth = 0, inStr = null, i = after;
      for (; i < SRC.length; i++) {
        const c = SRC[i];
        if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
        if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
        if (c === '[') depth++; else if (c === ']') { depth--; if (depth === 0) { i++; break; } }
      }
      return 'const ' + name + ' = ' + SRC.slice(after, i) + ';';
    }
    return 'const ' + name + ' = ' + SRC.slice(after, sliceBalanced(SRC, after)) + ';';
  }
  const semi = SRC.indexOf(';', after);
  return SRC.slice(m.index, semi + 1);
}

// --- 実関数群を組み立て ---
// お知らせ機能の localStorage 依存を差し替える最小スタブ(既読idの読み書きを制御するため)。
const shimNewsStore = `
const __store = {};
const localStorage = {
  getItem: (k) => (k in __store ? __store[k] : null),
  setItem: (k, v) => { __store[k] = String(v); },
  removeItem: (k) => { delete __store[k]; },
};
function __setSeenNews(id) { if (id == null) delete __store['msc_seen_news']; else __store['msc_seen_news'] = String(id); }`;
// escapeHtml は正規表現リテラルに " と ' を含み、この抽出器では切り出せない(文字列と誤認する)。
// 同じ挙動のものを置いて、これを使う関数を動かせるようにする。
const shimEscapeHtml = `
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}`;
const pieces = [
  shimNewsStore,
  shimEscapeHtml,
  extractFn('fileExt'), extractFn('normExt'), extractFn('chunkArray'),
  extractFn('autoLastRunText'), extractFn('autoFolderLink'), extractFn('autoRecheckButton'),
  extractFn('autoDetailRows'), extractFn('autoDetailButton'), extractFn('autoChapterLabel'),
  extractFn('autoDetailCsv'), extractFn('autoTableHtml'),
  extractFn('setupNoticeText'),
  extractFn('toSpec'), extractFn('describeSpec'),
  extractFn('buildMasterErrorNotifyText'),
  extractConst('NEWS'),
  extractFn('getSeenNewsId'), extractFn('hasUnreadNews'),
];
const exportNames = ['fileExt', 'normExt', 'chunkArray', 'setupNoticeText',
  'autoLastRunText', 'autoFolderLink', 'autoRecheckButton', 'autoDetailRows', 'autoDetailButton', 'autoChapterLabel', 'autoDetailCsv', 'autoTableHtml',
  'toSpec', 'describeSpec', 'buildMasterErrorNotifyText',
  'NEWS', 'getSeenNewsId', 'hasUnreadNews', '__setSeenNews'];
const C = new Function(pieces.join('\n\n') + '\nreturn {' + exportNames.join(',') + '};')();

// --- ミニテストランナー ---
let pass = 0, fail = 0;
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function check(name, got, want) {
  if (eq(got, want)) { pass++; }
  else { fail++; console.log(`  FAIL ${name}\n    got : ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`); }
}

// ===== 判定ロジックの写しが画面に残っていないこと(2026-10-02の移設の見張り) =====
// 画面とサーバに同じ判定を2つ持つと、片方だけ直して結果が食い違う。正本は Judge.gs の1か所。
console.log('# 画面に判定ロジックの写しが無い(正本は Judge.gs)');
for (const name of ['judgeImage', 'computeSetChecks', 'analyzeFolderNumbering', 'comparePsdTif',
  'detectCrossRootCollisions', 'checkDimension', 'judgeDpi', 'checkColorMode', 'checkExtension',
  'extractPageNumber', 'isSupportedImage', 'isPsdFile', 'classifyListedFiles']) {
  check(`index.html に function ${name} が無い`, new RegExp('function\\s+' + name + '\\s*\\(').test(SRC), false);
}
check('画面はサーバに判定を頼む(api_inspectImages に spec を渡す)', /callServer\('api_inspectImages'.*, s\);/.test(SRC), true);
check('判定結果はサーバの judge を使う', SRC.includes('r.judge ||'), true);
check('ファイルセット整合性はサーバで計算する(api_setChecks)', SRC.includes("'api_setChecks'"), true);
check('振り分けはサーバの kind を使う', /listed\.files \|\| \[\]\)\.filter\(f => f\.kind\)/.test(SRC), true);

// ===== 表示用の関数 =====
console.log('# fileExt / normExt (表の「実測拡張子」列の表示用)');
check('fileExt tif', C.fileExt('A.TIF'), 'tif');
check('fileExt jpeg', C.fileExt('b.JPEG'), 'jpeg');
check('fileExt none', C.fileExt('noext'), '');
check('normExt jpeg->jpg', C.normExt('jpeg'), 'jpg');
check('normExt tif->tiff', C.normExt('.TIF'), 'tiff');

console.log('# toSpec / describeSpec (取引先の選択と判定条件の表示)');
check('toSpec: 判定の既定は「ちょうど」', C.toSpec({ name: 'X', width: '1', height: '2', dpi: '3' }),
  { name: 'X', width: '1', widthOp: 'ちょうど', height: '2', heightOp: 'ちょうど', dpi: '3', color: '', ext: '' });
check('全項目', C.describeSpec({ width: '3000', widthOp: 'ちょうど', height: '4000', heightOp: 'ちょうど', dpi: '350', color: 'グレースケール', ext: 'tiff' }),
  '幅 3000px ちょうど / 高さ 4000px ちょうど / 350dpi / グレースケール / 拡張子 tiff');
check('不問混在(めちゃコミック)', C.describeSpec({ width: '1200', widthOp: '以上', height: '', heightOp: 'ちょうど', dpi: '', color: '', ext: 'jpg' }),
  '幅 1200px 以上 / 高さ 不問 / DPI 不問 / カラー不問 / 拡張子 jpg');

console.log('# chunkArray / setupNoticeText');
check('chunkArray', C.chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
check('setupNoticeText: 無ければ空', C.setupNoticeText(null), '');
check('setupNoticeText: 人数', C.setupNoticeText({ ok: true, sync: { desired: 4 }, hours: [8, 13, 18] }).includes('4人分'), true);

// ===== buildMasterErrorNotifyText (マスタ読み込みエラーのSlack通知本文) =====
console.log('# buildMasterErrorNotifyText (管理者への連絡文)');
{
  const sheet = 'https://docs.google.com/spreadsheets/d/ABC/edit';
  const t403 = C.buildMasterErrorNotifyText('yamada@gmail.com', 403, 'https://example.com/app/', sheet);
  check('403: 利用者メールを含む', t403.includes('yamada@gmail.com'), true);
  check('403: 権限文言を含む', t403.includes('閲覧権限が無い'), true);
  check('403: 閲覧者追加の依頼を含む', t403.includes('閲覧者'), true);
  check('403: シートURLを含む(依頼にはURLをセットで)', t403.includes(sheet), true);
  check('403: ツールURLを含む', t403.includes('https://example.com/app/'), true);
  check('Slackのメンション記法は使わない(利用者が貼るため)', t403.includes('<@'), false);
  const t404 = C.buildMasterErrorNotifyText('yamada@gmail.com', 404, 'https://example.com/app/', sheet);
  check('404: 見つからない文言を含む', t404.includes('見つかりません'), true);
  const t0 = C.buildMasterErrorNotifyText(null, 0, 'https://example.com/app/', sheet);
  check('通信エラー: メール未取得の表記', t0.includes('取得できず'), true);
  check('通信エラー: 通信エラー表記を含む', t0.includes('通信エラー'), true);
}

// ===== 自動チェックタブ =====
console.log('# 自動チェックタブ (毎晩の結果を画面で見る)');
check('タブのボタンがある', /id="tabBtnAuto"/.test(html), true);
check('サーバから結果を引く', SRC.includes("'api_autoCheckSummary'"), true);
check('直したその場で再チェックできる', SRC.includes("'api_recheckChapter'"), true);
check('再チェックのボタンを出す', /class="secondary auto-recheck"/.test(SRC), true);
check('集計は画面でやらない(サーバの Judge.gs / AutoCheck.gs が正本)',
  /function\s+buildAutoCheckView\s*\(/.test(SRC), false);
{
  check('動いた記録が無いとき', C.autoLastRunText(null).includes('まだありません'), true);
  const quiet = C.autoLastRunText({ at: '2026-10-05 02:00', targets: 36, checked: 0, ok: 0, ng: 0, baseline: 0, skipped: 0 });
  check('静かな晩でも動いたことが分かる', quiet,
    '最後に動いたのは 2026-10-05 02:00 ／ 対象 36作品 ／ 新しく上がった話はありませんでした');
  const busy = C.autoLastRunText({ at: '2026-10-06 02:00', targets: 36, checked: 3, ok: 2, ng: 1, baseline: 0, skipped: 2 });
  check('チェックした晩は件数を出す', busy,
    '最後に動いたのは 2026-10-06 02:00 ／ 対象 36作品 ／ チェック 3話(OK 2 / NG 1) ／ 見に行けなかった作品 2件');
}
{
  check('フォルダURLが無ければリンクを出さない', C.autoFolderLink(''), '');
  check('フォルダリンク', C.autoFolderLink('https://drive.google.com/drive/folders/X'),
    '<a href="https://drive.google.com/drive/folders/X" target="_blank" rel="noopener">フォルダ</a>');
  // 一覧は件数だけ、中身は「詳細」ボタンのモーダルで見る
  check('詳細は「ファイル名 — 理由」と、ファイルに紐づかない警告に分ける',
    C.autoDetailRows('a.tif — 幅不一致(期待 300px ちょうど / 実測 120px)\n連番の欠番: 7'),
    [{ file: 'a.tif', reason: '幅不一致(期待 300px ちょうど / 実測 120px)' }, { file: '', reason: '連番の欠番: 7' }]);
  check('詳細が空なら行なし', C.autoDetailRows(''), []);
  check('詳細ボタンはどの行かを持つ', C.autoDetailButton('u0').includes('data-detail="u0"'), true);
  check('話の見出し', C.autoChapterLabel({ chapter: 8 }), '8話');
  check('話の見出し(ログは「8話」で入っている)', C.autoChapterLabel({ chapter: '8話' }), '8話');
  check('再チェックのボタンは話フォルダIDを持つ', C.autoRecheckButton('CHAPTER000006').includes('data-folder="CHAPTER000006"'), true);
  check('フォルダIDが無ければボタンを出さない', C.autoRecheckButton(''), '');
  // CSVは1行＝1件のNG。作品・話・日時を各行に持たせて、他の作品の分と混ぜても読めるようにする
  const csv = C.autoDetailCsv({ at: '2026-10-04 02:00', titleNo: '0007-0031', titleName: 'べつの作品', chapter: 8,
    result: 'NG', ngCount: 2, detail: 'a.tif — 幅不一致\n連番の欠番: 7' }).split('\r\n');
  check('CSVの見出し', csv[0], '日時,作品No,作品名,話,結果,NG件数,ファイル,内容');
  check('CSVの1行目', csv[1], '"2026-10-04 02:00","0007-0031","べつの作品","8話","NG","2","a.tif","幅不一致"');
  check('CSVの2行目(ファイルに紐づかない警告)', csv[2], '"2026-10-04 02:00","0007-0031","べつの作品","8話","NG","2","","連番の欠番: 7"');
  check('CSV: NGが無い話は「問題は見つかりませんでした」の1行',
    C.autoDetailCsv({ at: 'x', titleNo: 'n', titleName: 't', chapter: 1, result: 'OK', ngCount: 0, detail: '' }).split('\r\n')[1],
    '"x","n","t","1話","OK","0","","問題は見つかりませんでした"');
  check('見出しはエスケープし、セルは渡されたHTMLをそのまま入れる(エスケープは呼ぶ側の責務)',
    C.autoTableHtml(['作品<b>'], [['<span class="ok">OK</span>']]),
    '<tr><th>作品&lt;b&gt;</th></tr><tr><td><span class="ok">OK</span></td></tr>');
  // 作品名は人が入力するので、描画側で必ず escapeHtml を通していること
  check('作品名は escapeHtml を通している', /escapeHtml\(r\.titleName\)/.test(SRC), true);
check('CSVとPDFで出せる(普通のチェックと同じように)', SRC.includes('autoDetailCsv') && SRC.includes('autoDetailPdfHtml'), true);
check('詳細の中身も escapeHtml を通している', /escapeHtml\(r\.reason\)/.test(SRC), true);
}

// ===== お知らせ(最新News)の未読判定 =====
console.log('# お知らせ 未読判定 (hasUnreadNews / getSeenNewsId)');
check('NEWSが1件以上ある', C.NEWS.length >= 1, true);
check('各NEWSにid/date/title/bodyがある', C.NEWS.every(n => n.id && n.date && n.title && Array.isArray(n.body)), true);
check('NEWSのidが一意', new Set(C.NEWS.map(n => n.id)).size, C.NEWS.length);
{
  C.__setSeenNews(null); // 既読なし
  check('未読なし状態=未読あり(true)', C.hasUnreadNews(), true);
  check('getSeenNewsId 初期は空', C.getSeenNewsId(), '');

  C.__setSeenNews(C.NEWS[0].id); // 最新を既読に
  check('最新を既読にすると未読なし(false)', C.hasUnreadNews(), false);
  check('getSeenNewsId は保存したidを返す', C.getSeenNewsId(), C.NEWS[0].id);

  C.__setSeenNews('古いID'); // 新しいお知らせが増えた相当
  check('idがずれると再び未読あり(true)', C.hasUnreadNews(), true);
}

// ===== 結果 =====
console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILED'} : ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
