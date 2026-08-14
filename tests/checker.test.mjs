// 単体テスト: index.html 内のロジック関数を「実ソースから抽出」して検証する。
// コピーではなく実ファイルから切り出すため、index.html を変更するとテストも追従する。
// 画像パースはネットワーク層(TiffReader)だけをローカルBufferで差し替えて実関数を動かす。
//
// 実行: node tests/checker.test.mjs   (または npm test)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
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

// --- 実関数群を組み立て(TiffReader はローカルBuffer版に差し替え) ---
const shimReader = `
class TiffReader {            // ネットワーク層のみ差し替え。引数(本来fileId)を Buffer として扱う
  constructor(buf) { this.buf = buf; }
  async getBytes(offset, length) { return this.buf.subarray(offset, offset + length); }
}`;
const pieces = [
  shimReader,
  extractConst('TYPE_SIZE'),
  extractConst('EXT_ALIASES'),
  extractFn('readUint16'), extractFn('readUint32'),
  extractFn('classifyColorMode'), extractFn('isGrayscaleMode'), extractFn('checkColorMode'),
  extractFn('fileExt'), extractFn('normExt'), extractFn('isSupportedImage'),
  extractFn('checkExtension'), extractFn('checkDimension'),
  extractFn('parseTiffSpec'), extractFn('parseJpegSpec'), extractFn('parseImageSpec'),
  extractFn('toSpec'), extractFn('describeSpec'),
  extractFn('buildAccessRequestText'),
];
const exportNames = ['classifyColorMode','isGrayscaleMode','checkColorMode','fileExt','normExt',
  'isSupportedImage','checkExtension','checkDimension','parseTiffSpec','parseJpegSpec','parseImageSpec',
  'toSpec','describeSpec','buildAccessRequestText'];
const C = new Function(pieces.join('\n\n') + '\nreturn {' + exportNames.join(',') + '};')();

// --- ミニテストランナー ---
let pass = 0, fail = 0;
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function check(name, got, want) {
  if (eq(got, want)) { pass++; }
  else { fail++; console.log(`  FAIL ${name}\n    got : ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`); }
}

// ===== 純粋関数 =====
console.log('# classifyColorMode (TIFF photometric)');
check('photometric 0=gray', C.classifyColorMode(0, 1), 'グレースケール');
check('photometric 1=gray', C.classifyColorMode(1, 1), 'グレースケール');
check('photometric 2=RGB', C.classifyColorMode(2, 3), 'RGB');
check('photometric 5=CMYK', C.classifyColorMode(5, 4), 'CMYK');
check('null+3samples=カラー', C.classifyColorMode(null, 3), 'カラー');
check('null+1sample=不明', C.classifyColorMode(null, 1), '不明');

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

// ===== 実画像パース(実TIFF/JPEGバイナリ) =====
const FIXTURES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));
console.log('# parseImageSpec (実画像バイナリ)');
for (const fx of FIXTURES) {
  const buf = Buffer.from(fx.b64, 'base64');
  const file = { name: 'sample.' + fx.fmt, id: buf }; // TiffReader shim が id を Buffer として扱う
  let spec;
  try { spec = await C.parseImageSpec(file); }
  catch (e) { fail++; console.log(`  FAIL ${fx.key}: parse error ${e.message}`); continue; }
  check(`${fx.key} width`, spec.width, fx.exp.width);
  check(`${fx.key} height`, spec.height, fx.exp.height);
  check(`${fx.key} dpiX`, spec.dpiX, fx.exp.dpiX);
  check(`${fx.key} colorMode`, spec.colorMode, fx.exp.colorMode);
}

// ===== シナリオ統合(実行ハンドラと同じ関数呼び出しで OK/NG を判定) =====
// 注: runCheckBtn ハンドラは DOM 依存で抽出できないため、同一の関数呼び出し列で判定を再現する。
console.log('# シナリオ(めちゃコミック / コミックシーモア)');
async function judgeReal(master, fx, filename) {
  const s = C.toSpec(master);
  const file = { name: filename, id: Buffer.from(fx.b64, 'base64') };
  const reasons = [];
  if (C.checkExtension(s.ext, file.name) === false) reasons.push('ext');
  let spec;
  try {
    spec = await C.parseImageSpec(file);
    if (C.checkDimension(s.width, spec.width, s.widthOp) === false) reasons.push('width');
    if (C.checkDimension(s.height, spec.height, s.heightOp) === false) reasons.push('height');
    if (C.checkDimension(s.dpi, spec.dpiX, 'ちょうど') === false || C.checkDimension(s.dpi, spec.dpiY, 'ちょうど') === false) reasons.push('dpi');
    if (C.checkColorMode(s.color, spec.colorMode) === false) reasons.push('color');
  } catch (e) { reasons.push('parse'); }
  return { ok: reasons.length === 0, reasons };
}
const fxMap = Object.fromEntries(FIXTURES.map(f => [f.key, f]));
const mecha = {name:'めちゃコミック',width:'1200',height:'',dpi:'',color:'',widthOp:'以上',heightOp:'ちょうど',ext:'jpg'};
const cmoa  = {name:'シーモア',width:'90',height:'110',dpi:'600',color:'グレースケール',widthOp:'ちょうど',heightOp:'ちょうど',ext:'tiff'};
{
  // めちゃコミック: jpg_rgb は 150x200 → 幅150<1200 で NG
  const r = await judgeReal(mecha, fxMap.jpg_rgb, 'p.jpg');
  check('めちゃ: 幅不足jpg→NG(width)', r, { ok:false, reasons:['width'] });
}
{
  // めちゃコミック相当で幅十分なjpgを合成: jpg_rgb は幅150しかないので、tif_gray(300)も幅<1200。
  // 幅>=1200のフィクスチャが無いため、以上判定は checkDimension 単体テストで担保済み。
  // ここでは拡張子NG(tiffをjpg期待)を確認
  const r = await judgeReal(mecha, fxMap.tif_gray, 'g.tif');
  check('めちゃ: tif混入→NG(ext+width)', { ok:r.ok, hasExt:r.reasons.includes('ext') }, { ok:false, hasExt:true });
}
{
  // シーモア相当(90x110/600/gray/tiff)に tif_cmyk(90x110/600/CMYK) → カラーNG
  const r = await judgeReal(cmoa, fxMap.tif_cmyk, 'c.tif');
  check('シーモア: CMYK混入→NG(color)', { ok:r.ok, hasColor:r.reasons.includes('color') }, { ok:false, hasColor:true });
}
{
  // シーモア相当に tif_gray(300x400/350/gray) → 寸法/DPI不一致(90/110/600期待)
  const r = await judgeReal(cmoa, fxMap.tif_gray, 'g.tif');
  check('シーモア: 寸法違い→NG(width/height/dpi)', { ok:r.ok }, { ok:false });
}

// ===== buildAccessRequestText (Slack通知本文) =====
console.log('# buildAccessRequestText (Slack通知本文)');
{
  const t = C.buildAccessRequestText('山田 太郎', 'yamada@gmail.com', 'https://example.com/app/');
  check('前田メンションを含む', t.includes('<@UASKEB16X>'), true);
  check('お名前を含む', t.includes('*お名前:* 山田 太郎'), true);
  check('メールを含む', t.includes('*メールアドレス:* yamada@gmail.com'), true);
  check('ツールURLを含む', t.includes('https://example.com/app/'), true);
  check('案内文の宛名(◯◯さん)を含む', t.includes('山田 太郎 さん'), true);
  check('コードブロック``` で囲む(開始/終了の2つ)', t.split('```').length === 3, true);
  check('本人向け3ステップ(チェック開始)を含む', t.includes('チェック開始'), true);
  check('担当者向け対応手順(Add users)を含む', t.includes('Add users'), true);
  // Slack webhook ペイロードとして有効なJSONに載ること
  const payload = 'payload=' + encodeURIComponent(JSON.stringify({ text: t }));
  const parsed = JSON.parse(decodeURIComponent(payload.slice('payload='.length)));
  check('Slackペイロードが有効なJSONに往復する', parsed.text === t, true);
}

// ===== 結果 =====
console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILED'} : ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
