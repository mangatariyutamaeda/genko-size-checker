// 単体テスト(判定ロジックの正本): gas/src/Judge.gs をそのまま読み込んで検証する。
// Judge.gs は GAS の API を一切使わない純粋関数だけなので、ファイルを丸ごと評価できる。
//
// 2026-10-02 に画面(index.html)からここへ移設した。移設前の gas/tests/checker.test.mjs の
// アサーションはすべてここへ引き継いである(画面側のテストは表示用の関数だけを見る)。
//
// 実行: node gas/tests/judge.test.mjs   (または npm run test:gas)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'Judge.gs'), 'utf8');
const NAMES = [
  'fileExt_', 'normExt_', 'isSupportedImage_', 'isPsdFile_', 'fileKind_',
  'checkExtension_', 'checkDimension_', 'judgeDpi_', 'isGrayscaleMode_', 'checkColorMode_',
  'extractPageNumber_', 'analyzeFolderNumbering_', 'comparePsdTif_', 'detectCrossRootCollisions_',
  'computeSetChecks_', 'judgeImage_', 'specFromMasterRow_', 'describeSpec_',
];
const J = new Function(SRC + '\nreturn {' + NAMES.join(',') + '};')();

// --- ミニテストランナー ---
let pass = 0, fail = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function check(name, got, want) {
  if (eq(got, want)) { pass++; }
  else { fail++; console.log(`  FAIL ${name}\n    got : ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`); }
}

console.log('# checkColorMode_');
check('指定なし', J.checkColorMode_('', 'グレースケール'), null);
check('gray==gray', J.checkColorMode_('グレースケール', 'グレースケール'), true);
check('gray vs RGB', J.checkColorMode_('グレースケール', 'RGB'), false);
check('カラー vs RGB', J.checkColorMode_('カラー', 'RGB'), true);
check('カラー vs CMYK', J.checkColorMode_('カラー', 'CMYK'), true);
check('カラー vs gray', J.checkColorMode_('カラー', 'グレースケール'), false);
check('gray vs 不明', J.checkColorMode_('グレースケール', '不明'), false);

console.log('# checkDimension_ (以上/ちょうど/以下/空欄)');
check('空欄=不問', J.checkDimension_('', 1000, 'ちょうど'), null);
check('ちょうど一致', J.checkDimension_('3000', 3000, 'ちょうど'), true);
check('ちょうど不一致', J.checkDimension_('3000', 2999, 'ちょうど'), false);
check('以上OK(等しい)', J.checkDimension_('1200', 1200, '以上'), true);
check('以上OK(大きい)', J.checkDimension_('1200', 5000, '以上'), true);
check('以上NG', J.checkDimension_('1200', 1199, '以上'), false);
check('以下OK', J.checkDimension_('1200', 1200, '以下'), true);
check('以下NG', J.checkDimension_('1200', 1201, '以下'), false);
check('実測null=NG', J.checkDimension_('1200', null, '以上'), false);

console.log('# judgeDpi_ (不明はNGにせず未検証スキップ)');
check('DPI不問(期待空)=ok', J.judgeDpi_('', null, null).status, 'ok');
check('両軸不明=未検証(NGにしない)', J.judgeDpi_('350', null, null).status, 'unverified');
check('未検証に注記が付く', J.judgeDpi_('350', null, null).detail.includes('DPI未検証'), true);
check('両軸一致=ok', J.judgeDpi_('350', 350, 350).status, 'ok');
check('不一致=ng', J.judgeDpi_('350', 72, 72).status, 'ng');
check('片軸のみ既知で一致=ok', J.judgeDpi_('350', 350, null).status, 'ok');
check('片軸のみ既知で不一致=ng', J.judgeDpi_('350', 72, null).status, 'ng');
check('X一致Y不一致=ng', J.judgeDpi_('350', 350, 72).status, 'ng');
check('不明な軸は「不明」と書く', J.judgeDpi_('350', 72, null).detail, 'DPI不一致(期待 350 / 実測 X:72 / Y:不明)');

console.log('# fileExt_ / normExt_ / isSupportedImage_ / checkExtension_');
check('fileExt tif', J.fileExt_('A.TIF'), 'tif');
check('fileExt jpeg', J.fileExt_('b.JPEG'), 'jpeg');
check('fileExt none', J.fileExt_('noext'), '');
check('normExt jpeg->jpg', J.normExt_('jpeg'), 'jpg');
check('normExt tif->tiff', J.normExt_('.TIF'), 'tiff');
check('supported tiff', J.isSupportedImage_('x.tif', ''), true);
check('supported jpg', J.isSupportedImage_('x.jpg', ''), true);
check('png は対象外', J.isSupportedImage_('x.png', 'image/png'), false);
check('txt は対象外', J.isSupportedImage_('x.txt', ''), false);
check('ext 指定なし', J.checkExtension_('', 'a.jpg'), null);
check('ext jpg matches .jpeg', J.checkExtension_('jpg', 'a.jpeg'), true);
check('ext tiff matches .tif', J.checkExtension_('tiff', 'a.tif'), true);
check('ext jpg vs .tif', J.checkExtension_('jpg', 'a.tif'), false);

console.log('# fileKind_ (api_listFolders が返す振り分け)');
check('tif は image', J.fileKind_('a_001.tif', 'image/tiff'), 'image');
check('psd は psd', J.fileKind_('a_001.psd', 'image/vnd.adobe.photoshop'), 'psd');
check('txt は対象外(空)', J.fileKind_('memo.txt', 'text/plain'), '');

console.log('# specFromMasterRow_ / describeSpec_');
{
  const row = ['コミックシーモア（NTTソルマーレ）', 5186, 7323, 600, 'グレースケール', 'ちょうど', 'ちょうど', 'tiff'];
  const spec = J.specFromMasterRow_(row);
  check('取引先マスタの行 → spec', spec,
    { name: 'コミックシーモア（NTTソルマーレ）', width: '5186', widthOp: 'ちょうど', height: '7323', heightOp: 'ちょうど', dpi: '600', color: 'グレースケール', ext: 'tiff' });
  check('判定条件の文言', J.describeSpec_(spec),
    '幅 5186px ちょうど / 高さ 7323px ちょうど / 600dpi / グレースケール / 拡張子 tiff');
}
{
  // 判定列が空欄なら「ちょうど」を既定にする(めちゃコミックの行は高さ・DPI・カラーが空)
  const spec = J.specFromMasterRow_(['めちゃコミック', 1200, '', '', '', '以上', 'ちょうど', 'jpg']);
  check('空欄混在 → 不問の表記', J.describeSpec_(spec),
    '幅 1200px 以上 / 高さ 不問 / DPI 不問 / カラー不問 / 拡張子 jpg');
}

// ===== シナリオ(サーバの解析結果を想定して judgeImage_ で OK/NG を判定) =====
// 解析値は tests/fixtures.json の実画像の期待値(サーバ側の解析は gas/tests/server.test.mjs で実画像から検証)。
const FIXTURES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'tests', 'fixtures.json'), 'utf8'));
console.log('# シナリオ(めちゃコミック / コミックシーモア)');
const fxMap = Object.fromEntries(FIXTURES.map(f => [f.key, { spec: { ...f.exp, dpiY: f.exp.dpiX } }]));
const mecha = { name: 'めちゃコミック', width: '1200', height: '', dpi: '', color: '', widthOp: '以上', heightOp: 'ちょうど', ext: 'jpg' };
const cmoa = { name: 'シーモア', width: '90', height: '110', dpi: '600', color: 'グレースケール', widthOp: 'ちょうど', heightOp: 'ちょうど', ext: 'tiff' };
{
  const r = J.judgeImage_({ name: 'p.jpg' }, fxMap.jpg_rgb, mecha, 'x');
  check('めちゃ: 幅不足jpg→NG(幅)', { ok: r.ok, width: r.reason.includes('幅不一致') }, { ok: false, width: true });
}
{
  const r = J.judgeImage_({ name: 'g.tif' }, fxMap.tif_gray, mecha, 'x');
  check('めちゃ: tif混入→NG(拡張子)', { ok: r.ok, ext: r.reason.includes('拡張子不一致') }, { ok: false, ext: true });
}
{
  const r = J.judgeImage_({ name: 'c.tif' }, fxMap.tif_cmyk, cmoa, 'x');
  check('シーモア: CMYK混入→NG(カラー)', { ok: r.ok, color: r.reason.includes('カラーモード不一致') }, { ok: false, color: true });
}
{
  const r = J.judgeImage_({ name: 'g.tif' }, fxMap.tif_gray, cmoa, 'x');
  check('シーモア: 寸法違い→NG', r.ok, false);
}
{
  const ok = J.judgeImage_({ name: 'c.tif' }, { spec: { width: 90, height: 110, dpiX: 600, dpiY: 600, colorMode: 'グレースケール' } }, cmoa, 'x');
  check('シーモア: 条件どおり→OK', { ok: ok.ok, reason: ok.reason, expected: ok.expected }, { ok: true, reason: '', expected: 'x' });
  const err = J.judgeImage_({ name: 'c.tif' }, { error: 'TIFF形式ではありません' }, cmoa, 'x');
  check('解析エラーはNG・理由に出す', { ok: err.ok, reason: err.reason }, { ok: false, reason: '解析エラー: TIFF形式ではありません' });
  const none = J.judgeImage_({ name: 'c.tif' }, undefined, cmoa, 'x');
  check('結果が無いときもNG', none.ok, false);
}
{
  // DPI未検証は OK のまま理由欄に注記だけ残す(自動チェックはこれをNGに数えない)
  const note = J.judgeImage_({ name: 'c.tif' }, { spec: { width: 90, height: 110, dpiX: null, dpiY: null, colorMode: 'グレースケール' } }, cmoa, 'x');
  check('DPI未検証はOKのまま', note.ok, true);
  check('DPI未検証は理由欄に注記', note.reason.includes('DPI未検証'), true);
}
{
  // 実測が取れない軸は「不明」と出す
  const r = J.judgeImage_({ name: 'c.tif' }, { spec: { width: null, height: 110, dpiX: 600, dpiY: 600, colorMode: 'グレースケール' } }, cmoa, 'x');
  check('幅が読めないときの文言', r.reason, '幅不一致(期待 90px ちょうど / 実測 不明px)');
}

// ===== ファイルセット整合性チェック =====
console.log('# isPsdFile_');
check('拡張子psd', J.isPsdFile_('a.psd', ''), true);
check('mimeでpsd', J.isPsdFile_('a', 'image/vnd.adobe.photoshop'), true);
check('tifはpsdでない', J.isPsdFile_('a.tif', 'image/tiff'), false);

console.log('# extractPageNumber_ (末尾の数字を柔軟に抽出)');
check('sakuhin_001.tif=1', J.extractPageNumber_('sakuhin_001.tif'), 1);
check('012.psd=12', J.extractPageNumber_('012.psd'), 12);
check('末尾側優先', J.extractPageNumber_('2024_p_003.tif'), 3);
check('数字なし=null', J.extractPageNumber_('cover.tif'), null);
check('拡張子内の数字は無視(mp3等ないがtiff)', J.extractPageNumber_('p5.tiff'), 5);
check('数字のみ', J.extractPageNumber_('7.jpg'), 7);

console.log('# analyzeFolderNumbering_ (重複/連番抜け/最大番号ずれ)');
{
  const clean = J.analyzeFolderNumbering_([{ name: 'p001.tif' }, { name: 'p002.tif' }, { name: 'p003.tif' }]);
  check('正常: 重複なし', clean.duplicates, []);
  check('正常: 欠番なし', clean.missing, []);
  check('正常: 最大番号ずれなし', clean.countMismatch, null);
  check('正常: 最大番号3', clean.maxNumber, 3);
}
{
  const dup = J.analyzeFolderNumbering_([{ name: 'p001.tif' }, { name: 'p001_old.tif' }, { name: 'p002.tif' }]);
  check('重複: page1が2件', dup.duplicates, [{ number: 1, names: ['p001.tif', 'p001_old.tif'] }]);
}
{
  const gap = J.analyzeFolderNumbering_([{ name: 'p001.tif' }, { name: 'p002.tif' }, { name: 'p004.tif' }]);
  check('欠番: 3が抜け', gap.missing, [3]);
  check('欠番: 最大番号ずれも検出(3件/最大4)', gap.countMismatch, { max: 4, count: 3 });
}
{
  const start2 = J.analyzeFolderNumbering_([{ name: 'p002.tif' }, { name: 'p003.tif' }]);
  check('1始まりでない: 1が欠番', start2.missing, [1]);
}
{
  const un = J.analyzeFolderNumbering_([{ name: 'p001.tif' }, { name: 'cover.tif' }]);
  check('番号なしを分離', un.unnumbered, ['cover.tif']);
  check('番号なしは番号付き数に含めない', un.numberedCount, 1);
}

console.log('# comparePsdTif_ (psdと画像のページ突合)');
{
  const same = J.comparePsdTif_([1, 2, 3], [1, 2, 3]);
  check('一致: 差分なし', { oi: same.onlyImage, op: same.onlyPsd }, { oi: [], op: [] });
}
{
  const miss = J.comparePsdTif_([1, 2, 3], [1, 3]);
  check('psd欠け: ページ2', miss.onlyImage, [2]);
  check('件数: 画像3/psd2', { i: miss.imageCount, p: miss.psdCount }, { i: 3, p: 2 });
}
{
  const extra = J.comparePsdTif_([1, 3], [1, 2, 3]);
  check('画像欠け: ページ2', extra.onlyPsd, [2]);
}

console.log('# detectCrossRootCollisions_ (複数入力フォルダの番号衝突=別案件混在)');
{
  const none = J.detectCrossRootCollisions_([
    { name: 'p001.tif', kind: 'image', root: 'A' },
    { name: 'p002.tif', kind: 'image', root: 'A' },
  ]);
  check('単一rootは衝突なし', none, []);
}
{
  const col = J.detectCrossRootCollisions_([
    { name: 'p001.tif', kind: 'image', root: 'A' },
    { name: 'p001.tif', kind: 'image', root: 'B' },
  ]);
  check('画像ページ1が2つのrootに', col, [{ kind: 'image', number: 1, roots: ['A', 'B'] }]);
}
{
  const mixed = J.detectCrossRootCollisions_([
    { name: 'p001.tif', kind: 'image', root: 'A' },
    { name: 'p001.psd', kind: 'psd', root: 'B' },
  ]);
  check('種別違いは衝突ではない', mixed, []);
}

console.log('# computeSetChecks_ (表示/CSV/PDF/Slack共用の警告組み立て)');
{
  const clean = J.computeSetChecks_([
    { name: 'p001.tif', kind: 'image', root: 'A' },
    { name: 'p002.tif', kind: 'image', root: 'A' },
  ]);
  check('問題なしはok=true', { ok: clean.ok, n: clean.warnings.length }, { ok: true, n: 0 });
}
{
  const dup = J.computeSetChecks_([
    { name: 'p001.tif', kind: 'image', root: 'A' },
    { name: 'p001_old.tif', kind: 'image', root: 'A' },
    { name: 'p002.tif', kind: 'image', root: 'A' },
  ]);
  check('重複でok=false', dup.ok, false);
  check('重複警告の本文に「重複」', dup.warnings.some(w => w.items.some(i => i.includes('重複'))), true);
}
{
  const okPsd = J.computeSetChecks_([
    { name: 'p001.tif', kind: 'image', root: 'img' },
    { name: 'p002.tif', kind: 'image', root: 'img' },
    { name: 'p001.psd', kind: 'psd', root: 'psd' },
    { name: 'p002.psd', kind: 'psd', root: 'psd' },
  ]);
  check('単一案件・突合一致はok=true', okPsd.ok, true);
}
{
  const collide = J.computeSetChecks_([
    { name: 'p001.tif', kind: 'image', root: '案件A/img' },
    { name: 'p001.tif', kind: 'image', root: '案件B/img' },
    { name: 'p001.psd', kind: 'psd', root: '案件A/psd' },
  ]);
  const psdSection = collide.warnings.find(w => w.title.includes('突合'));
  check('突合セクションが存在', !!psdSection, true);
  check('衝突を警告(「別案件が混在」)', psdSection.items.some(i => i.includes('別案件が混在')), true);
  check('突合は当てにならない旨を明記', psdSection.items.some(i => i.includes('1案件ずつ')), true);
  check('衝突時は「psd が無いページ」を出さない', psdSection.items.some(i => i.startsWith('psd が無いページ')), false);
}

// ===== 結果 =====
console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILED'} : ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
