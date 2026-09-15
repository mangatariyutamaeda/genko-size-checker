// 単体テスト(GAS版の画面側): gas/src/index.html 内のロジック関数を「実ソースから抽出」して検証する。
// GitHub Pages 版の tests/checker.test.mjs から作った。画像の解析はサーバ側(Code.gs)に移したので gas/tests/server.test.mjs で見る。
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
const pieces = [
  shimNewsStore,
  extractConst('EXT_ALIASES'),
  extractFn('isGrayscaleMode'), extractFn('checkColorMode'),
  extractFn('fileExt'), extractFn('normExt'), extractFn('isSupportedImage'), extractFn('isPsdFile'),
  extractFn('checkExtension'), extractFn('checkDimension'), extractFn('judgeDpi'),
  extractFn('extractPageNumber'), extractFn('analyzeFolderNumbering'), extractFn('comparePsdTif'),
  extractFn('detectCrossRootCollisions'), extractFn('computeSetChecks'),
  extractFn('classifyListedFiles'), extractFn('chunkArray'), extractFn('judgeImage'), extractFn('setupNoticeText'),
  extractFn('toSpec'), extractFn('describeSpec'),
  extractFn('buildMasterErrorNotifyText'),
  extractConst('NEWS'),
  extractFn('getSeenNewsId'), extractFn('hasUnreadNews'),
];
const exportNames = ['isGrayscaleMode','checkColorMode','fileExt','normExt',
  'isSupportedImage','isPsdFile','checkExtension','checkDimension','judgeDpi','classifyListedFiles','chunkArray','judgeImage','setupNoticeText',
  'extractPageNumber','analyzeFolderNumbering','comparePsdTif',
  'detectCrossRootCollisions','computeSetChecks',
  'toSpec','describeSpec','buildMasterErrorNotifyText',
  'NEWS','getSeenNewsId','hasUnreadNews','__setSeenNews'];
const C = new Function(pieces.join('\n\n') + '\nreturn {' + exportNames.join(',') + '};')();

// --- ミニテストランナー ---
let pass = 0, fail = 0;
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function check(name, got, want) {
  if (eq(got, want)) { pass++; }
  else { fail++; console.log(`  FAIL ${name}\n    got : ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`); }
}

// ===== 純粋関数 =====
console.log('# checkColorMode');
check('指定なし', C.checkColorMode('', 'グレースケール'), null);
check('gray==gray', C.checkColorMode('グレースケール', 'グレースケール'), true);
check('gray vs RGB', C.checkColorMode('グレースケール', 'RGB'), false);
check('カラー vs RGB', C.checkColorMode('カラー', 'RGB'), true);
check('カラー vs CMYK', C.checkColorMode('カラー', 'CMYK'), true);
check('カラー vs gray', C.checkColorMode('カラー', 'グレースケール'), false);
check('gray vs 不明', C.checkColorMode('グレースケール', '不明'), false);

console.log('# checkDimension (以上/ちょうど/以下/空欄)');
check('空欄=不問', C.checkDimension('', 1000, 'ちょうど'), null);
check('ちょうど一致', C.checkDimension('3000', 3000, 'ちょうど'), true);
check('ちょうど不一致', C.checkDimension('3000', 2999, 'ちょうど'), false);
check('以上OK(等しい)', C.checkDimension('1200', 1200, '以上'), true);
check('以上OK(大きい)', C.checkDimension('1200', 5000, '以上'), true);
check('以上NG', C.checkDimension('1200', 1199, '以上'), false);
check('以下OK', C.checkDimension('1200', 1200, '以下'), true);
check('以下NG', C.checkDimension('1200', 1201, '以下'), false);
check('実測null=NG', C.checkDimension('1200', null, '以上'), false);

console.log('# judgeDpi (不明はNGにせず未検証スキップ)');
check('DPI不問(期待空)=ok', C.judgeDpi('', null, null).status, 'ok');
check('両軸不明=未検証(NGにしない)', C.judgeDpi('350', null, null).status, 'unverified');
check('未検証に注記が付く', C.judgeDpi('350', null, null).detail.includes('DPI未検証'), true);
check('両軸一致=ok', C.judgeDpi('350', 350, 350).status, 'ok');
check('不一致=ng', C.judgeDpi('350', 72, 72).status, 'ng');
check('片軸のみ既知で一致=ok', C.judgeDpi('350', 350, null).status, 'ok');
check('片軸のみ既知で不一致=ng', C.judgeDpi('350', 72, null).status, 'ng');
check('X一致Y不一致=ng', C.judgeDpi('350', 350, 72).status, 'ng');

console.log('# fileExt / normExt / isSupportedImage / checkExtension');
check('fileExt tif', C.fileExt('A.TIF'), 'tif');
check('fileExt jpeg', C.fileExt('b.JPEG'), 'jpeg');
check('fileExt none', C.fileExt('noext'), '');
check('normExt jpeg->jpg', C.normExt('jpeg'), 'jpg');
check('normExt tif->tiff', C.normExt('.TIF'), 'tiff');
check('supported tiff', C.isSupportedImage('x.tif', ''), true);
check('supported jpg', C.isSupportedImage('x.jpg', ''), true);
check('png は対象外', C.isSupportedImage('x.png', 'image/png'), false);
check('txt は対象外', C.isSupportedImage('x.txt', ''), false);
check('ext 指定なし', C.checkExtension('', 'a.jpg'), null);
check('ext jpg matches .jpeg', C.checkExtension('jpg', 'a.jpeg'), true);
check('ext tiff matches .tif', C.checkExtension('tiff', 'a.tif'), true);
check('ext jpg vs .tif', C.checkExtension('jpg', 'a.tif'), false);

console.log('# describeSpec');
check('全項目', C.describeSpec({width:'3000',widthOp:'ちょうど',height:'4000',heightOp:'ちょうど',dpi:'350',color:'グレースケール',ext:'tiff'}),
  '幅 3000px ちょうど / 高さ 4000px ちょうど / 350dpi / グレースケール / 拡張子 tiff');
check('不問混在(めちゃコミック)', C.describeSpec({width:'1200',widthOp:'以上',height:'',heightOp:'ちょうど',dpi:'',color:'',ext:'jpg'}),
  '幅 1200px 以上 / 高さ 不問 / DPI 不問 / カラー不問 / 拡張子 jpg');

// ===== シナリオ(サーバの解析結果を想定して judgeImage で OK/NG を判定) =====
// 解析値は tests/fixtures.json の実画像の期待値(サーバ側の解析は gas/tests/server.test.mjs で実画像から検証)。
const FIXTURES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'tests', 'fixtures.json'), 'utf8'));
console.log('# シナリオ(めちゃコミック / コミックシーモア)');
const fxMap = Object.fromEntries(FIXTURES.map(f => [f.key, { spec: { ...f.exp, dpiY: f.exp.dpiX } }]));
const mecha = {name:'めちゃコミック',width:'1200',height:'',dpi:'',color:'',widthOp:'以上',heightOp:'ちょうど',ext:'jpg'};
const cmoa  = {name:'シーモア',width:'90',height:'110',dpi:'600',color:'グレースケール',widthOp:'ちょうど',heightOp:'ちょうど',ext:'tiff'};
{
  const r = C.judgeImage({ name: 'p.jpg' }, fxMap.jpg_rgb, C.toSpec(mecha), 'x');
  check('めちゃ: 幅不足jpg→NG(幅)', { ok: r.ok, width: r.reason.includes('幅不一致') }, { ok: false, width: true });
}
{
  const r = C.judgeImage({ name: 'g.tif' }, fxMap.tif_gray, C.toSpec(mecha), 'x');
  check('めちゃ: tif混入→NG(拡張子)', { ok: r.ok, ext: r.reason.includes('拡張子不一致') }, { ok: false, ext: true });
}
{
  const r = C.judgeImage({ name: 'c.tif' }, fxMap.tif_cmyk, C.toSpec(cmoa), 'x');
  check('シーモア: CMYK混入→NG(カラー)', { ok: r.ok, color: r.reason.includes('カラーモード不一致') }, { ok: false, color: true });
}
{
  const r = C.judgeImage({ name: 'g.tif' }, fxMap.tif_gray, C.toSpec(cmoa), 'x');
  check('シーモア: 寸法違い→NG', r.ok, false);
}
{
  const ok = C.judgeImage({ name: 'c.tif' }, { spec: { width: 90, height: 110, dpiX: 600, dpiY: 600, colorMode: 'グレースケール' } }, C.toSpec(cmoa), 'x');
  check('シーモア: 条件どおり→OK', { ok: ok.ok, reason: ok.reason }, { ok: true, reason: '' });
  const err = C.judgeImage({ name: 'c.tif' }, { error: 'TIFF形式ではありません' }, C.toSpec(cmoa), 'x');
  check('解析エラーはNG・理由に出す', { ok: err.ok, reason: err.reason }, { ok: false, reason: '解析エラー: TIFF形式ではありません' });
  const none = C.judgeImage({ name: 'c.tif' }, undefined, C.toSpec(cmoa), 'x');
  check('結果が無いときもNG', none.ok, false);
}

console.log('# classifyListedFiles / chunkArray / setupNoticeText');
{
  const files = C.classifyListedFiles([
    { id: '1', name: 'a_001.tif', mimeType: 'image/tiff', folder: 'F', root: 'F' },
    { id: '2', name: 'a_001.psd', mimeType: 'image/vnd.adobe.photoshop', folder: 'F', root: 'F' },
    { id: '3', name: 'memo.txt', mimeType: 'text/plain', folder: 'F', root: 'F' },
  ]);
  check('画像とpsdだけ残し kind を付ける', files.map(f => [f.id, f.kind]), [['1', 'image'], ['2', 'psd']]);
  check('chunkArray', C.chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  check('setupNoticeText: 無ければ空', C.setupNoticeText(null), '');
  check('setupNoticeText: 人数', C.setupNoticeText({ ok: true, sync: { desired: 4 }, hours: [8, 13, 18] }).includes('4人分'), true);
}

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

// ===== ファイルセット整合性チェック =====
console.log('# isPsdFile');
check('拡張子psd', C.isPsdFile('a.psd', ''), true);
check('mimeでpsd', C.isPsdFile('a', 'image/vnd.adobe.photoshop'), true);
check('tifはpsdでない', C.isPsdFile('a.tif', 'image/tiff'), false);

console.log('# extractPageNumber (末尾の数字を柔軟に抽出)');
check('sakuhin_001.tif=1', C.extractPageNumber('sakuhin_001.tif'), 1);
check('012.psd=12', C.extractPageNumber('012.psd'), 12);
check('末尾側優先', C.extractPageNumber('2024_p_003.tif'), 3);
check('数字なし=null', C.extractPageNumber('cover.tif'), null);
check('拡張子内の数字は無視(mp3等ないがtiff)', C.extractPageNumber('p5.tiff'), 5);
check('数字のみ', C.extractPageNumber('7.jpg'), 7);

console.log('# analyzeFolderNumbering (重複/連番抜け/最大番号ずれ)');
{
  const clean = C.analyzeFolderNumbering([{name:'p001.tif'},{name:'p002.tif'},{name:'p003.tif'}]);
  check('正常: 重複なし', clean.duplicates, []);
  check('正常: 欠番なし', clean.missing, []);
  check('正常: 最大番号ずれなし', clean.countMismatch, null);
  check('正常: 最大番号3', clean.maxNumber, 3);
}
{
  const dup = C.analyzeFolderNumbering([{name:'p001.tif'},{name:'p001_old.tif'},{name:'p002.tif'}]);
  check('重複: page1が2件', dup.duplicates, [{number:1, names:['p001.tif','p001_old.tif']}]);
}
{
  const gap = C.analyzeFolderNumbering([{name:'p001.tif'},{name:'p002.tif'},{name:'p004.tif'}]);
  check('欠番: 3が抜け', gap.missing, [3]);
  check('欠番: 最大番号ずれも検出(3件/最大4)', gap.countMismatch, {max:4, count:3});
}
{
  const start2 = C.analyzeFolderNumbering([{name:'p002.tif'},{name:'p003.tif'}]);
  check('1始まりでない: 1が欠番', start2.missing, [1]);
}
{
  const un = C.analyzeFolderNumbering([{name:'p001.tif'},{name:'cover.tif'}]);
  check('番号なしを分離', un.unnumbered, ['cover.tif']);
  check('番号なしは番号付き数に含めない', un.numberedCount, 1);
}

console.log('# comparePsdTif (psdと画像のページ突合)');
{
  const same = C.comparePsdTif([1,2,3], [1,2,3]);
  check('一致: 差分なし', {oi:same.onlyImage, op:same.onlyPsd}, {oi:[], op:[]});
}
{
  const miss = C.comparePsdTif([1,2,3], [1,3]);
  check('psd欠け: ページ2', miss.onlyImage, [2]);
  check('件数: 画像3/psd2', {i:miss.imageCount, p:miss.psdCount}, {i:3, p:2});
}
{
  const extra = C.comparePsdTif([1,3], [1,2,3]);
  check('画像欠け: ページ2', extra.onlyPsd, [2]);
}

console.log('# detectCrossRootCollisions (複数入力フォルダの番号衝突=別案件混在)');
{
  // 単一rootのみ: 衝突なし
  const none = C.detectCrossRootCollisions([
    {name:'p001.tif', kind:'image', root:'A'},
    {name:'p002.tif', kind:'image', root:'A'},
  ]);
  check('単一rootは衝突なし', none, []);
}
{
  // 別rootに同じ画像ページ番号 → 衝突
  const col = C.detectCrossRootCollisions([
    {name:'p001.tif', kind:'image', root:'A'},
    {name:'p001.tif', kind:'image', root:'B'},
  ]);
  check('画像ページ1が2つのrootに', col, [{kind:'image', number:1, roots:['A','B']}]);
}
{
  // 種別が違えば衝突扱いしない(画像1とpsd1は別レイヤー)
  const mixed = C.detectCrossRootCollisions([
    {name:'p001.tif', kind:'image', root:'A'},
    {name:'p001.psd', kind:'psd', root:'B'},
  ]);
  check('種別違いは衝突ではない', mixed, []);
}

console.log('# computeSetChecks (表示/CSV/PDF共用の警告組み立て)');
{
  // クリーン: 画像だけ・連番OK・psdなし → 警告なし
  const clean = C.computeSetChecks([
    {name:'p001.tif', kind:'image', root:'A'},
    {name:'p002.tif', kind:'image', root:'A'},
  ]);
  check('問題なしはok=true', {ok:clean.ok, n:clean.warnings.length}, {ok:true, n:0});
}
{
  // 重複あり → 要確認
  const dup = C.computeSetChecks([
    {name:'p001.tif', kind:'image', root:'A'},
    {name:'p001_old.tif', kind:'image', root:'A'},
    {name:'p002.tif', kind:'image', root:'A'},
  ]);
  check('重複でok=false', dup.ok, false);
  check('重複警告の本文に「重複」', dup.warnings.some(w => w.items.some(i => i.includes('重複'))), true);
}
{
  // psdあり・単一案件・突合OK → psd突合セクションは出ない(全てOK)
  const okPsd = C.computeSetChecks([
    {name:'p001.tif', kind:'image', root:'img'},
    {name:'p002.tif', kind:'image', root:'img'},
    {name:'p001.psd', kind:'psd', root:'psd'},
    {name:'p002.psd', kind:'psd', root:'psd'},
  ]);
  check('単一案件・突合一致はok=true', okPsd.ok, true);
}
{
  // 複数案件混在(画像ページ1が2つのrootに) + psdあり → 衝突警告を出し、突合結果は当てにしない
  const collide = C.computeSetChecks([
    {name:'p001.tif', kind:'image', root:'案件A/img'},
    {name:'p001.tif', kind:'image', root:'案件B/img'},
    {name:'p001.psd', kind:'psd', root:'案件A/psd'},
  ]);
  const psdSection = collide.warnings.find(w => w.title.includes('突合'));
  check('突合セクションが存在', !!psdSection, true);
  check('衝突を警告(「別案件が混在」)', psdSection.items.some(i => i.includes('別案件が混在')), true);
  check('突合は当てにならない旨を明記', psdSection.items.some(i => i.includes('1案件ずつ')), true);
  // 衝突時は onlyImage/onlyPsd の断定的な差分行は出さない
  check('衝突時は「psd が無いページ」を出さない', psdSection.items.some(i => i.startsWith('psd が無いページ')), false);
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
