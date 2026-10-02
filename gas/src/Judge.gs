/**
 * Judge.gs - 判定ロジックの正本(サーバ側)
 * ============================================================
 * 「取引先の条件 × 解析結果」の照合と、ファイルセット整合性チェック(重複・欠番・最大番号ずれ・psd突合)。
 * 2026-10-02 に画面(index.html)から移設した。画面も自動チェック(AutoCheck.gs)も**ここだけ**を使う。
 * 画面は api_inspectImages / api_setChecks 経由で呼ぶ(直接は呼べない)。
 *
 * 【ここに置くもの】Drive もスプレッドシートも Slack も触らない純粋関数だけ。
 *   GASランタイムのAPIを使わないので、テスト(gas/tests/judge.test.mjs)はこのファイルを
 *   そのまま読み込んで実行できる。I/O を足したくなったら別ファイルへ。
 * 【関数名】すべて末尾「_」。末尾「_」の無いサーバ関数は google.script.run から誰でも呼べるため
 *   (共通ルール。判定自体は無害だが、公開面は api_* だけに保つ)。
 * 【判定の文言】画面の表・CSV・PDF・Slack通知がそのまま出すので、変えるとテストが落ちる。
 */

// 期待拡張子名 -> 実ファイル拡張子の候補
var EXT_ALIASES_ = { tiff: ['.tif', '.tiff'], tif: ['.tif', '.tiff'], jpg: ['.jpg', '.jpeg'], jpeg: ['.jpg', '.jpeg'], png: ['.png'] };

function fileExt_(name) {
  const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

// 表示・照合用に拡張子を正規化(jpeg->jpg, tif->tiff)
function normExt_(ext) {
  ext = (ext || '').toLowerCase().replace(/^\./, '');
  if (ext === 'jpeg') return 'jpg';
  if (ext === 'tif') return 'tiff';
  return ext;
}

function isSupportedImage_(name, mimeType) {
  // 解析対応はTIFFとJPEGのみ(PNG等は走査対象外)
  if (mimeType === 'image/tiff' || mimeType === 'image/jpeg') return true;
  const e = fileExt_(name);
  return ['tif', 'tiff', 'jpg', 'jpeg'].includes(e);
}

// psd ファイル判定(拡張子 or Drive の mimeType)
function isPsdFile_(name, mimeType) {
  if (mimeType === 'image/vnd.adobe.photoshop' || mimeType === 'application/x-photoshop') return true;
  return fileExt_(name) === 'psd';
}

/** Drive のファイル1件を 'image'(解析対象) / 'psd'(セット整合性のみ) / ''(対象外) に振り分ける。 */
function fileKind_(name, mimeType) {
  if (isSupportedImage_(name, mimeType)) return 'image';
  if (isPsdFile_(name, mimeType)) return 'psd';
  return '';
}

// 期待拡張子とファイル名を照合。true=一致 / false=不一致 / null=チェック対象外
function checkExtension_(expectedExt, name) {
  if (!expectedExt) return null;
  const cands = EXT_ALIASES_[expectedExt.toLowerCase()] || ['.' + expectedExt.toLowerCase()];
  const lower = String(name).toLowerCase();
  return cands.some(e => lower.endsWith(e));
}

// 数値条件の照合。true=OK / false=NG / null=対象外(空欄)
function checkDimension_(expected, actual, op) {
  if (expected === '' || expected == null) return null; // 空欄=不問
  const exp = parseInt(expected, 10);
  if (isNaN(exp)) return null;
  if (actual == null) return false; // 実測が取れない
  if (op === '以上') return actual >= exp;
  if (op === '以下') return actual <= exp;
  return actual === exp; // ちょうど(既定)
}

// DPIの判定。期待DPIと実測(X/Y)を照合する。
// DPIは「読めない=違反」ではなく、読めた軸だけ検証し、両軸とも不明なら未検証(OK扱い+注記)にする。
// (JPEGはJFIFにしか解像度が無く units=0 のことがあり、寸法等が正しくても誤NGになるのを防ぐ)
// 戻り値: { status: 'ok' | 'ng' | 'unverified', detail: string }
function judgeDpi_(expectedDpi, dpiX, dpiY) {
  if (expectedDpi === '' || expectedDpi == null) return { status: 'ok', detail: '' }; // 不問
  const known = [dpiX, dpiY].filter(v => v != null);
  if (known.length === 0) return { status: 'unverified', detail: 'DPI未検証(ファイルに解像度情報なし)' };
  const ng = known.some(v => checkDimension_(expectedDpi, v, 'ちょうど') === false);
  if (ng) return { status: 'ng', detail: 'DPI不一致(期待 ' + expectedDpi + ' / 実測 X:' + orUnknown_(dpiX) + ' / Y:' + orUnknown_(dpiY) + ')' };
  return { status: 'ok', detail: '' };
}

function isGrayscaleMode_(mode) {
  return mode === 'グレースケール';
}

// 期待カラーモード(expected: '' / 'グレースケール' / 'カラー')と実測(mode)を照合
// 戻り値: true=OK, false=NG, null=チェック対象外
function checkColorMode_(expected, mode) {
  if (!expected) return null; // 指定なし
  if (!mode || mode === '不明') return false; // 判定できない
  if (expected === 'グレースケール') return isGrayscaleMode_(mode);
  if (expected === 'カラー') return !isGrayscaleMode_(mode);
  return null;
}

/** null/undefined を「不明」に。画面の `?? '不明'` と同じ。 */
function orUnknown_(v) {
  return v == null ? '不明' : v;
}

// ---------- ファイルセット整合性チェック(重複/連番抜け/最大値ずれ/psd-tif不一致) ----------
// ファイル名末尾の数字列をページ番号として抽出。数字を含まなければ null。
// 例: 'sakuhin_001.tif'->1, '012.psd'->12, '2024_p3_v2.tif'->2(末尾側優先)
function extractPageNumber_(name) {
  const base = String(name).replace(/\.[a-z0-9]+$/i, ''); // 拡張子除去
  const m = base.match(/(\d+)(?!.*\d)/);                   // 末尾側の連続数字
  return m ? parseInt(m[1], 10) : null;
}

// 1フォルダ内のファイル群のページ番号整合性を解析する。
// files: [{name}]。戻り値に重複/連番抜け/最大番号ずれ/番号なしをまとめる。
function analyzeFolderNumbering_(files) {
  const byNumber = new Map(); // number -> [name,...]
  const unnumbered = [];
  for (const f of files) {
    const n = extractPageNumber_(f.name);
    if (n == null) { unnumbered.push(f.name); continue; }
    if (!byNumber.has(n)) byNumber.set(n, []);
    byNumber.get(n).push(f.name);
  }
  const numbers = [...byNumber.keys()].sort((a, b) => a - b);
  const duplicates = numbers.filter(n => byNumber.get(n).length > 1)
    .map(n => ({ number: n, names: byNumber.get(n).slice().sort() }));
  const numberedCount = files.length - unnumbered.length;
  const maxNumber = numbers.length ? numbers[numbers.length - 1] : 0;
  const missing = [];
  for (let i = 1; i < maxNumber; i++) if (!byNumber.has(i)) missing.push(i); // 1..max の欠番
  // 最大番号ずれ: 番号付きファイル数 と 最大番号 が食い違う(重複や欠番、0始まり等で発生)
  const countMismatch = (numbers.length && numberedCount !== maxNumber)
    ? { max: maxNumber, count: numberedCount } : null;
  return { total: files.length, numbers, duplicates, missing, maxNumber, numberedCount, countMismatch, unnumbered };
}

// psd と 画像(tif等)のページ番号セットを突き合わせる(数不一致/アップ漏れ検出)。
// 案件を1つずつ実行する前提で、全入力フォルダを横断して集計する。
// imageNums/psdNums はファイル1件につき1要素(番号なしは含めない)。
function comparePsdTif_(imageNums, psdNums) {
  const imgSet = new Set(imageNums);
  const psdSet = new Set(psdNums);
  const onlyImage = [...imgSet].filter(n => !psdSet.has(n)).sort((a, b) => a - b); // 画像にあってpsdに無い
  const onlyPsd = [...psdSet].filter(n => !imgSet.has(n)).sort((a, b) => a - b);   // psdにあって画像に無い
  return { imageCount: imageNums.length, psdCount: psdNums.length, onlyImage, onlyPsd };
}

// 複数の入力フォルダ(root)にまたがって同じページ番号が存在するかを調べる。
// 存在する場合は別案件が混在している可能性が高く、実行全体を横断するpsd↔画像の突合結果は当てにならない。
// 種別(画像/psd)ごとに独立して判定する。戻り値: [{kind, number, roots:[...]}]。
function detectCrossRootCollisions_(allFiles) {
  const collisions = [];
  for (const kind of ['image', 'psd']) {
    const byNumber = new Map(); // number -> Set(root)
    for (const f of allFiles) {
      if (f.kind !== kind) continue;
      const n = extractPageNumber_(f.name);
      if (n == null) continue;
      if (!byNumber.has(n)) byNumber.set(n, new Set());
      byNumber.get(n).add(f.root);
    }
    for (const [n, roots] of byNumber) {
      if (roots.size > 1) collisions.push({ kind, number: n, roots: [...roots].sort() });
    }
  }
  collisions.sort((a, b) => a.kind === b.kind ? a.number - b.number : (a.kind < b.kind ? -1 : 1));
  return collisions;
}

// ファイルセット整合性チェックの結果を「プレーンテキスト」で組み立てる(表示・CSV・PDF・Slackで共用)。
// 戻り値: { ok:boolean, warnings:[{title, items:[string]}] }。HTMLエスケープは描画側の責務。
function computeSetChecks_(allFiles) {
  const roots = [...new Set(allFiles.map(f => f.root))];
  const warnings = [];

  // --- 入力フォルダ単位: 重複 / 連番抜け / 最大番号ずれ / 番号なし ---
  for (const root of roots) {
    const files = allFiles.filter(f => f.root === root);
    for (const kind of ['image', 'psd']) { // 種別ごとに独立して番号整合性を見る
      const group = files.filter(f => f.kind === kind);
      if (!group.length) continue;
      const a = analyzeFolderNumbering_(group);
      const kindLabel = kind === 'psd' ? 'psd' : '画像';
      const items = [];
      for (const d of a.duplicates) {
        items.push('ページ ' + d.number + ' が重複(' + d.names.join(' / ') + ')→ 古いファイルを削除し、正しい1点のみ残してください');
      }
      if (a.missing.length) items.push('連番の欠番: ' + a.missing.join(', ') + '(アップ漏れの可能性)');
      if (a.countMismatch && !a.duplicates.length && !a.missing.length) {
        items.push('最大番号 ' + a.countMismatch.max + ' に対しファイル数 ' + a.countMismatch.count + ' 件(番号のずれ・アップ漏れの可能性)');
      }
      if (a.unnumbered.length) items.push('番号を読み取れないファイル: ' + a.unnumbered.join(' / '));
      if (items.length) warnings.push({ title: 'フォルダ ' + root + ' / ' + kindLabel + '(' + group.length + '件)', items });
    }
  }

  // --- 実行全体: psd と 画像 のページ突合(psdがある時のみ) ---
  const psdFiles = allFiles.filter(f => f.kind === 'psd');
  if (psdFiles.length) {
    const collisions = detectCrossRootCollisions_(allFiles); // 複数案件が混在していないか
    const items = [];
    if (collisions.length) {
      // 番号衝突あり = 複数案件が混在している可能性大。突合結果は信頼できないので突合は出さず、警告のみ。
      const sample = collisions.slice(0, 5)
        .map(x => (x.kind === 'psd' ? 'psd' : '画像') + 'ページ' + x.number).join(', ');
      items.push('複数の入力フォルダで同じページ番号が見つかりました(' + sample + (collisions.length > 5 ? ' ほか' : '') + ')。別案件が混在している可能性があります');
      items.push('psd↔画像の突合はページ番号が衝突するため、この結果は当てになりません。正確に確認するには1案件ずつ実行してください');
    } else {
      const imageNums = allFiles.filter(f => f.kind === 'image').map(f => extractPageNumber_(f.name)).filter(n => n != null);
      const psdNums = psdFiles.map(f => extractPageNumber_(f.name)).filter(n => n != null);
      const c = comparePsdTif_(imageNums, psdNums);
      if (c.imageCount !== c.psdCount) items.push('画像 ' + c.imageCount + ' 件 / psd ' + c.psdCount + ' 件 でファイル数が不一致');
      if (c.onlyImage.length) items.push('psd が無いページ: ' + c.onlyImage.join(', '));
      if (c.onlyPsd.length) items.push('画像が無いページ: ' + c.onlyPsd.join(', '));
      if (items.length) items.push('※ 1案件ずつ実行する前提で、全入力フォルダを横断して集計しています');
    }
    if (items.length) warnings.push({ title: 'psd と 画像 の突合(実行全体)', items });
  }

  return { ok: warnings.length === 0, warnings };
}

// ---------- 1ファイルの判定 ----------
/**
 * file はファイル情報({name,...})、r はサーバの解析結果({ spec } または { error })、s は取引先の条件。
 * 戻り値: { ok, reason, expected }。画面は file/spec を自分で持っているので、ここでは判定だけ返す。
 */
function judgeImage_(file, r, s, expectedText) {
  const reasons = [];       // NG理由(1つでもあればNG)
  const notes = [];         // 補足(OK判定は変えない。例: DPI未検証)
  const extResult = checkExtension_(s.ext, file.name); // true/false/null
  if (extResult === false) reasons.push('拡張子不一致(期待 ' + s.ext + ' / 実測 ' + (normExt_(fileExt_(file.name)) || '不明') + ')');
  const spec = r && r.spec ? r.spec : null;
  if (spec) {
    if (checkDimension_(s.width, spec.width, s.widthOp) === false) reasons.push('幅不一致(期待 ' + s.width + 'px ' + s.widthOp + ' / 実測 ' + orUnknown_(spec.width) + 'px)');
    if (checkDimension_(s.height, spec.height, s.heightOp) === false) reasons.push('高さ不一致(期待 ' + s.height + 'px ' + s.heightOp + ' / 実測 ' + orUnknown_(spec.height) + 'px)');
    const dpiJudge = judgeDpi_(s.dpi, spec.dpiX, spec.dpiY);
    if (dpiJudge.status === 'ng') reasons.push(dpiJudge.detail);
    else if (dpiJudge.status === 'unverified') notes.push(dpiJudge.detail);
    if (checkColorMode_(s.color, spec.colorMode) === false) reasons.push('カラーモード不一致(期待 ' + s.color + ' / 実測 ' + (spec.colorMode || '不明') + ')');
  } else {
    reasons.push('解析エラー: ' + ((r && r.error) || '結果を受け取れませんでした'));
  }
  return { ok: reasons.length === 0, reason: reasons.concat(notes).join(' / '), expected: expectedText || '' };
}

// ---------- 取引先マスタの行 → 判定条件 ----------
/** 取引先マスタの1行(A取引先名 B幅 C高さ D DPI Eカラー F幅判定 G高さ判定 H拡張子) → spec。 */
function specFromMasterRow_(row) {
  row = row || [];
  function at(i) { return row[i] == null ? '' : String(row[i]).trim(); }
  return {
    name: at(0),
    width: at(1), widthOp: at(5) || 'ちょうど',
    height: at(2), heightOp: at(6) || 'ちょうど',
    dpi: at(3),
    color: at(4),
    ext: at(7)
  };
}

/** 条件を人が読める文字列に(画面の describeSpec と同じ文言)。 */
function describeSpec_(s) {
  const parts = [];
  const hasVal = v => v !== '' && v != null;
  parts.push(hasVal(s.width) ? '幅 ' + s.width + 'px ' + s.widthOp : '幅 不問');
  parts.push(hasVal(s.height) ? '高さ ' + s.height + 'px ' + s.heightOp : '高さ 不問');
  parts.push(hasVal(s.dpi) ? s.dpi + 'dpi' : 'DPI 不問');
  parts.push(s.color ? s.color : 'カラー不問');
  parts.push(s.ext ? '拡張子 ' + s.ext : '拡張子不問');
  return parts.join(' / ');
}
