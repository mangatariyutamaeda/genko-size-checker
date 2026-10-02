// 単体テスト(写植データの自動チェック): gas/src/AutoCheck.gs と Notify.gs の純粋関数を検証する。
// GASランタイムはモックし、実ファイルを vm で読み込んで本物の関数を見る(server.test.mjs と同じ流儀)。
//
// 実行: node --test gas/tests/autocheck.test.mjs   (または npm run test:gas)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

// vm の中で作られたオブジェクトは外側と prototype が別なので deepStrictEqual が通らない。
// JSON を通して素のオブジェクトに直してから比べる(server.test.mjs と同じ対処)。
const plain = (x) => JSON.parse(JSON.stringify(x));
const deepEq = (got, want, msg) => assert.deepEqual(plain(got), want, msg);

/** Config/Judge/Notify/AutoCheck を読み込んだ context を作る。state=スプレッドシートの中身。 */
function load(state = {}) {
  const s = Object.assign({ props: {}, sheets: {}, posts: [], now: '2026-10-03 02:00' }, state);
  const sheetFor = (name) => {
    if (!s.sheets[name]) s.sheets[name] = [];
    const rows = s.sheets[name];
    const sheet = {
      getLastRow: () => rows.length,
      getLastColumn: () => (rows[0] ? rows[0].length : 0),
      setFrozenRows: () => {},
      deleteRows: (from, count) => { rows.splice(from - 1, count); },
      getRange: (row, col, numRows, numCols) => ({
        setValues: (values) => {
          values.forEach((v, i) => {
            const r = row - 1 + i;
            while (rows.length <= r) rows.push([]);
            v.forEach((cell, j) => { rows[r][col - 1 + j] = cell; });
          });
        },
        getValues: () => {
          const out = [];
          for (let i = 0; i < numRows; i++) {
            const src = rows[row - 1 + i] || [];
            out.push(Array.from({ length: numCols }, (_, j) => (src[col - 1 + j] === undefined ? '' : src[col - 1 + j])));
          }
          return out;
        },
        clearContent: () => {
          for (let i = 0; i < numRows; i++) {
            const r = rows[row - 1 + i];
            if (r) for (let j = 0; j < numCols; j++) r[col - 1 + j] = '';
          }
        },
      }),
    };
    return sheet;
  };
  const ctx = {
    console: { log() {}, warn() {}, error(...a) { s.errors = (s.errors || []).concat(a.join(' ')); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in s.props ? s.props[k] : null) }) },
    SpreadsheetApp: { openById: () => ({ getSheetByName: (n) => (s.sheets[n] ? sheetFor(n) : null), insertSheet: (n) => { s.sheets[n] = []; return sheetFor(n); } }) },
    Utilities: { formatDate: () => s.now },
    UrlFetchApp: {
      fetch: (url, opts) => {
        s.posts.push({ url, payload: JSON.parse(opts.payload) });
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(s.slackResponse || { ok: true, ts: '1.0' }) };
      },
    },
    AccessControl: { buildPeopleHubSlackDirectory: () => s.directory || { byEmail: {}, byName: {} } },
    BusinessMaster: {},
    ScriptApp: { getOAuthToken: () => 'TOKEN' },
    encodeURIComponent, Uint8Array,
  };
  vm.createContext(ctx);
  // Code.gs / PeopleHubSync.gs も読む(getConfig_ が normalizeEmail_ / dbMissingMessage_ を使うため)
  for (const f of ['Config.gs', 'Judge.gs', 'Code.gs', 'PeopleHubSync.gs', 'Notify.gs', 'AutoCheck.gs']) {
    vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
  }
  ctx.__state = s;
  return ctx;
}

// ============================================================
// 対象作品の絞り込み
// ============================================================
test('isTargetStatus_: 完結(97〜99)と制作中止(90)だけを外す。全角数字も読む', () => {
  const c = load();
  assert.equal(c.isTargetStatus_('４．連載中（継続）'), true);
  assert.equal(c.isTargetStatus_('3．連載中（初回8話）'), true);
  assert.equal(c.isTargetStatus_('１．連載準備'), true);
  assert.equal(c.isTargetStatus_('０．企画中'), true);
  assert.equal(c.isTargetStatus_('９０．制作中止'), false);
  assert.equal(c.isTargetStatus_('90．制作中止'), false);
  assert.equal(c.isTargetStatus_('９７．完結'), false);
  assert.equal(c.isTargetStatus_('９９．完結（合本済）'), false);
});

test('isTargetStatus_: 番号が読めない行は対象に含める(連載中の取りこぼしを作らない)', () => {
  const c = load();
  assert.equal(c.isTargetStatus_(''), true);
  assert.equal(c.isTargetStatus_('検討中）連載'), true);
});

// ============================================================
// 話フォルダ
// ============================================================
test('chapterNumber_: 1話/第12話/１２話 を読む。話でないフォルダは null', () => {
  const c = load();
  assert.equal(c.chapterNumber_('1話'), 1);
  assert.equal(c.chapterNumber_('第12話'), 12);
  assert.equal(c.chapterNumber_('１２話'), 12);
  assert.equal(c.chapterNumber_('03話_修正版'), 3);
  assert.equal(c.chapterNumber_('TIF'), null);
  assert.equal(c.chapterNumber_('00_素材'), null);
  assert.equal(c.chapterNumber_(''), null);
});

test('pickLayoutChild_: 接頭番号つきを優先し、無ければ語で拾う', () => {
  const c = load();
  const folders = [{ id: 'a', name: '420_ネーム' }, { id: 'b', name: '430_写植' }, { id: 'c', name: '写植(旧)' }];
  assert.equal(c.pickLayoutChild_(folders, { prefix: '430', keyword: '写植' }).id, 'b');
  // 接頭番号が作品ごとに違う例(241_/250_ のような揺れ)でも語で拾う
  assert.equal(c.pickLayoutChild_([{ id: 'z', name: '435_写植' }], { prefix: '430', keyword: '写植' }).id, 'z');
  assert.equal(c.pickLayoutChild_([{ id: 'z', name: '001_納品' }], { prefix: '430', keyword: '写植' }), null);
});

test('normalizeFolderLabel_: 全角・空白・大文字小文字を落として比べる', () => {
  const c = load();
  assert.equal(c.normalizeFolderLabel_('ＴＩＦ'), 'tif');
  assert.equal(c.normalizeFolderLabel_(' tif '), 'tif');
  assert.equal(c.normalizeFolderLabel_('TIF'), c.normalizeFolderLabel_('tif'));
});

test('fileSignature_: 中身が同じなら同じ、1件でも違えば変わる', () => {
  const c = load();
  const a = [{ id: '1', name: 'p001.tif', size: 10 }, { id: '2', name: 'p002.tif', size: 20 }];
  const shuffled = [a[1], a[0]];
  assert.equal(c.fileSignature_(a), c.fileSignature_(shuffled), '並び順では変わらない');
  assert.notEqual(c.fileSignature_(a), c.fileSignature_(a.concat([{ id: '3', name: 'p003.tif', size: 30 }])), '増えたら変わる');
  assert.notEqual(c.fileSignature_(a), c.fileSignature_([{ id: '1', name: 'p001.tif', size: 11 }, a[1]]), 'サイズが変わったら変わる');
  assert.notEqual(c.fileSignature_(a), c.fileSignature_([{ id: '1', name: 'p001_old.tif', size: 10 }, a[1]]), '名前が変わったら変わる');
  assert.match(c.fileSignature_(a), /^2-[0-9a-f]{8}$/, '「件数-ハッシュ」の形');
});

test('pickCandidateChapters_: 新しい方から N 話＋前回NGの話', () => {
  const c = load();
  const sorted = [5, 4, 3, 2, 1].map(n => ({ id: 'f' + n, name: n + '話', number: n }));
  const state = { byFolderId: { f1: { result: 'NG' }, f2: { result: 'OK' } } };
  const picked = c.pickCandidateChapters_(sorted, state, 2).map(f => f.number);
  deepEq(picked, [5, 4, 1], '最新2話＋NGのままの1話');
});

// ============================================================
// NGのまとめ
// ============================================================
test('summarizeNg_: ファイル単位のNG → セット整合性の警告 の順に並べ、上限で締める', () => {
  const c = load();
  const rows = [
    { name: 'p001.tif', ok: true, reason: '' },
    { name: 'p002.tif', ok: false, reason: '幅不一致(期待 5186px ちょうど / 実測 5100px)' },
  ];
  const setChecks = { ok: false, warnings: [{ title: 'x', items: ['連番の欠番: 7(アップ漏れの可能性)'] }] };
  deepEq(c.summarizeNg_(rows, setChecks, 8), [
    'p002.tif — 幅不一致(期待 5186px ちょうど / 実測 5100px)',
    '連番の欠番: 7(アップ漏れの可能性)',
  ]);
  deepEq(c.summarizeNg_([], { ok: true, warnings: [] }, 8), [], '問題なしは空');
});

test('summarizeNg_: 上限を超えたら「ほか N件」で締める', () => {
  const c = load();
  const rows = Array.from({ length: 10 }, (_, i) => ({ name: 'p' + i + '.tif', ok: false, reason: 'NG' }));
  const lines = c.summarizeNg_(rows, { ok: true, warnings: [] }, 3);
  assert.equal(lines.length, 4);
  assert.match(lines[3], /ほか 7件/);
});

// ============================================================
// メンション(Notify.gs)
// ============================================================
test('normalizePersonName_ / splitPersonNames_: 空白のゆれと複数人', () => {
  const c = load();
  assert.equal(c.normalizePersonName_('山崎 一生'), '山崎一生');
  assert.equal(c.normalizePersonName_('山崎　一生'), '山崎一生');
  deepEq(c.splitPersonNames_('山崎 一生、木原 凜'), ['山崎 一生', '木原 凜']);
  deepEq(c.splitPersonNames_('山崎/木原'), ['山崎', '木原']);
  deepEq(c.splitPersonNames_('-'), [], '未入力の記号は人として数えない');
  deepEq(c.splitPersonNames_(''), []);
});

test('buildMentions_: 辞書にある人はID、無い人は名前のまま(通知は止めない)', () => {
  const c = load();
  const byName = { 山崎一生: 'U111', 木原凜: 'U222' };
  const m = c.buildMentions_(['山崎 一生', '木原　凜', '外部の人'], byName);
  assert.equal(m.text, '<@U111> <@U222> 外部の人(Slack未解決)');
  deepEq(m.resolved, ['山崎 一生', '木原　凜']);
  deepEq(m.unresolved, ['外部の人']);
});

test('buildMentions_: 同じ人が2つの列に入っていても1回だけ', () => {
  const c = load();
  const m = c.buildMentions_(['山崎 一生', '山崎一生'], { 山崎一生: 'U111' });
  assert.equal(m.text, '<@U111>');
});

test('buildMentions_: 辞書が空でも落ちない', () => {
  const c = load();
  assert.equal(c.buildMentions_(['山崎 一生'], null).text, '山崎 一生(Slack未解決)');
  assert.equal(c.buildMentions_([], {}).text, '');
});

// ============================================================
// 作家作品リストの担当者
// ============================================================
test('parseAuthorWorkListPeople_: 2行ヘッダー・データは3行目から。列は2行目の実列名で解決', () => {
  const c = load();
  const values = [
    ['', '', '状況', 'to作家', '', ''],                                      // 1行目=グループ見出し
    ['作品No', 'マンガタイトル', '連載状況', 'ディレクター', '編集者', 'アサイン責任者'], // 2行目=実列名
    ['44', 'ふくしゅうさん', '４．連載中（継続）', '山崎 一生', '木原 凜', '森 友吾'],
    ['0007-0012', 'べつの作品', '４．連載中（継続）', '山崎 一生', '', ''],
  ];
  const map = c.parseAuthorWorkListPeople_(values, 2, ['ディレクター', '編集者', 'アサイン責任者']);
  deepEq(map['0007-0044'], { 'ディレクター': '山崎 一生', '編集者': '木原 凜', 'アサイン責任者': '森 友吾' });
  deepEq(map['0007-0012'], { 'ディレクター': '山崎 一生', '編集者': '', 'アサイン責任者': '' });
});

test('parseAuthorWorkListPeople_: 作品Noの重複は先に出てきた行を採る', () => {
  const c = load();
  const values = [
    ['', ''],
    ['作品No', 'ディレクター'],
    ['44', '先の行'],
    ['44', '後の行'],
  ];
  const map = c.parseAuthorWorkListPeople_(values, 2, ['ディレクター']);
  assert.equal(map['0007-0044']['ディレクター'], '先の行');
});

test('parseAuthorWorkListPeople_: 列が無いリストは触らない / 作品No列が無ければ空', () => {
  const c = load();
  const noDirector = c.parseAuthorWorkListPeople_([['', ''], ['作品No', 'マンガタイトル'], ['44', 'x']], 2, ['ディレクター']);
  deepEq(noDirector['0007-0044'], { 'ディレクター': '' });
  const noNo = c.parseAuthorWorkListPeople_([['', ''], ['タイトル', 'ディレクター'], ['x', 'y']], 2, ['ディレクター']);
  deepEq(noNo, {});
});

test('normalizeTitleNoForList_: 下4桁だけの作品Noを business-hub の形に揃える', () => {
  const c = load();
  assert.equal(c.normalizeTitleNoForList_('44'), '0007-0044');
  assert.equal(c.normalizeTitleNoForList_('0044'), '0007-0044');
  assert.equal(c.normalizeTitleNoForList_('0007-0044'), '0007-0044');
  assert.equal(c.normalizeTitleNoForList_('7-44'), '0007-0044');
  assert.equal(c.normalizeTitleNoForList_(''), '');
  assert.equal(c.normalizeTitleNoForList_('合計'), '', 'ピボット等の行は弾く');
});

// ============================================================
// Slackの本文
// ============================================================
function sampleResults() {
  return [
    { titleNo: '0007-0044', titleName: 'ふくしゅうさん', chapter: 12, folderId: 'FID1', fileCount: 32, imageCount: 32, ok: true, ngCount: 0, noteCount: 0, lines: [], mentionNames: [] },
    { titleNo: '0007-0031', titleName: 'べつの作品', chapter: 8, folderId: 'FID2', fileCount: 31, imageCount: 31, ok: false, ngCount: 1, noteCount: 0, lines: ['p005.tif — 幅不一致(期待 5186px ちょうど / 実測 5100px)'], mentionNames: ['山崎 一生'] },
  ];
}

test('buildRunMessage_: OKは1行、NGは理由とフォルダURLとメンション', () => {
  const c = load();
  const text = c.buildRunMessage_(sampleResults(), {
    stamp: '10/03 02:00', targetCount: 18, skipped: [], unresolved: [],
    mentions: ['', '<@U111>'],
  });
  assert.match(text, /\*写植データ自動チェック\* 10\/03 02:00/);
  assert.match(text, /新しく上がった 2話 をチェックしました。\(対象 18作品 \/ NG 1話\)/);
  assert.match(text, /✅ 0007-0044 ふくしゅうさん 12話 — 画像32件 すべてOK/);
  assert.match(text, /⚠️ 0007-0031 べつの作品 8話 — 画像31件 \/ NG 1件/);
  assert.match(text, /p005\.tif — 幅不一致/);
  assert.match(text, /https:\/\/drive\.google\.com\/drive\/folders\/FID2/);
  assert.match(text, /担当: <@U111>/);
  assert.ok(!text.includes('https://drive.google.com/drive/folders/FID1'), 'OKの話にフォルダURLは出さない');
});

test('buildRunMessage_: 0話のときも「無かった」と言う(ハートビート代わりではなく、スキップ報告のため)', () => {
  const c = load();
  const text = c.buildRunMessage_([], { stamp: '10/03 02:00', targetCount: 18, skipped: ['0007-0099 どれか(430_写植 が見つかりません)'], unresolved: [], mentions: [] });
  assert.match(text, /新しく上がった写植データはありませんでした。\(対象 18作品\)/);
  assert.match(text, /見に行けなかった作品/);
  assert.match(text, /430_写植 が見つかりません/);
});

test('buildRunMessage_: 直っていない話は再通知せず末尾に一覧で添える', () => {
  const c = load();
  const text = c.buildRunMessage_(sampleResults(), {
    stamp: '10/03 02:00', targetCount: 18, skipped: [], mentions: ['', ''],
    unresolved: [{ titleNo: '0007-0031', titleName: 'べつの作品', chapter: 6, checkedAt: '2026-09-30 02:00', ngCount: 2 }],
  });
  assert.match(text, /まだ直っていない話/);
  assert.match(text, /0007-0031 べつの作品 6話 \(2026-09-30 02:00 検出 \/ NG 2件\)/);
});

test('buildRunMessage_: DPI未検証は注記として出し、NGには数えない', () => {
  const c = load();
  const r = sampleResults()[0];
  r.noteCount = 3;
  const text = c.buildRunMessage_([r], { stamp: 'x', targetCount: 1, skipped: [], unresolved: [], mentions: [''] });
  assert.match(text, /✅ .*すべてOK/);
  assert.match(text, /注記 3件: DPI未検証。判定はOKのまま/);
});

test('buildTitleMessage_: 作品chにはその作品の分だけ・集約chの場所も書く', () => {
  const c = load();
  const text = c.buildTitleMessage_(sampleResults()[1], '<@U111>');
  assert.match(text, /べつの作品 8話/);
  assert.match(text, /画像31件 \/ NG 1件/);
  assert.match(text, /・p005\.tif — 幅不一致/);
  assert.match(text, /担当: <@U111>/);
  assert.match(text, /auto_tool_direction_top_cmoa_写植データ自動チェック/);
  assert.ok(!text.includes('ふくしゅうさん'), '他の作品のことは書かない');
});

// ============================================================
// DB(既読状態)
// ============================================================
test('state: 読み書きの往復。話フォルダIDが鍵で、同じ話は上書きされる', () => {
  const c = load({ props: { DB_SPREADSHEET_ID: 'DB' } });
  const state = c.loadAutoCheckState_();
  deepEq(state.rows, [], '最初は空');

  const chapter = { titleNo: '0007-0044', titleName: 'ふくしゅうさん', number: 12, folderId: 'FID1', signature: '32-abcdef01', files: new Array(32) };
  c.upsertAutoCheckState_(state, chapter, { result: 'NG', ngCount: 2 });
  c.saveAutoCheckState_(state);

  const reloaded = c.loadAutoCheckState_();
  assert.equal(reloaded.rows.length, 1);
  deepEq(reloaded.rows[0], {
    titleNo: '0007-0044', titleName: 'ふくしゅうさん', chapter: 12, folderId: 'FID1',
    signature: '32-abcdef01', fileCount: 32, checkedAt: '2026-10-03 02:00', result: 'NG', ngCount: 2,
  });
  assert.equal(reloaded.titles['0007-0044'], true, '作品が登録済みと分かる(初回登録の判定に使う)');

  // 同じ話をOKで上書き → 行は増えない
  c.upsertAutoCheckState_(reloaded, Object.assign({}, chapter, { signature: '32-ffffffff' }), { result: 'OK', ngCount: 0 });
  c.saveAutoCheckState_(reloaded);
  const again = c.loadAutoCheckState_();
  assert.equal(again.rows.length, 1);
  assert.equal(again.rows[0].result, 'OK');
  assert.equal(again.rows[0].signature, '32-ffffffff');
});

test('state: ヘッダーは AUTO_CHECK_STATE_HEADER のまま', () => {
  const c = load({ props: { DB_SPREADSHEET_ID: 'DB' } });
  c.loadAutoCheckState_();
  deepEq(c.__state.sheets[c.AUTO_CHECK_STATE_SHEET][0], plain(c.AUTO_CHECK_STATE_HEADER));
});

test('unresolvedNgRows_: 今回チェックした話は「直っていない」に入れない', () => {
  const c = load();
  const state = {
    rows: [
      { titleNo: '0007-0031', titleName: 'A', chapter: 6, result: 'NG', ngCount: 2, checkedAt: '2026-09-30 02:00' },
      { titleNo: '0007-0031', titleName: 'A', chapter: 8, result: 'NG', ngCount: 1, checkedAt: '2026-10-03 02:00' },
      { titleNo: '0007-0044', titleName: 'B', chapter: 3, result: 'OK', ngCount: 0, checkedAt: '2026-10-01 02:00' },
    ],
  };
  const rows = c.unresolvedNgRows_(state, [{ titleNo: '0007-0031', chapter: 8 }]);
  deepEq(rows.map(r => r.chapter), [6], '今回見た8話は除く・OKの話も除く');
});

// ============================================================
// Slack送信
// ============================================================
test('slackPost_: トークンが無ければ送らずに理由を返す(本処理は落とさない)', () => {
  const c = load();
  deepEq(c.slackPost_('', 'C1', 'x'), { ok: false, error: 'トークン未設定', ts: '' });
  deepEq(c.slackPost_('xoxb-x', '', 'x'), { ok: false, error: 'チャンネル未指定', ts: '' });
  assert.equal(c.__state.posts.length, 0);
});

test('slackPost_: chat.postMessage へチャンネルと本文を送る。リンク展開はしない', () => {
  const c = load();
  const res = c.slackPost_('xoxb-x', 'C1', 'やあ');
  deepEq(res, { ok: true, error: '', ts: '1.0' });
  assert.equal(c.__state.posts[0].url, 'https://slack.com/api/chat.postMessage');
  deepEq(c.__state.posts[0].payload, { channel: 'C1', text: 'やあ', unfurl_links: false, unfurl_media: false });
});

test('slackPost_: Slackが ok:false を返しても例外にしない', () => {
  const c = load({ slackResponse: { ok: false, error: 'channel_not_found' } });
  deepEq(c.slackPost_('xoxb-x', 'C1', 'x'), { ok: false, error: 'channel_not_found', ts: '' });
});

test('mentionDirectory_: people-hub が読めなくても空の辞書で続ける', () => {
  const c = load();
  c.AccessControl.buildPeopleHubSlackDirectory = () => { throw new Error('権限なし'); };
  const dir = c.mentionDirectory_('Slack（まんがたり）');
  deepEq(dir, { byEmail: {}, byName: {} });
});

// ============================================================
// 設定の取り違え防止
// ============================================================
test('設定: 集約chとメンション辞書のワークスペースが揃っている', () => {
  const c = load();
  // 集約chはまんがたりWSなので、メンションもまんがたりWSのメンバーIDで引く
  assert.equal(c.NOTIFY_SLACK_TOOL_NAME, 'Slack（まんがたり）');
  assert.match(c.NOTIFY_CHANNEL_ID, /^C[A-Z0-9]{8,}$/);
  // 作品chはネットマンガラボWSなので、そちらの辞書とトークンを使う
  assert.equal(c.NOTIFY_TITLE_SLACK_TOOL_NAME, 'Slack（ネットマンガラボ）');
  assert.equal(c.NOTIFY_TITLE_TOKEN_PROP, 'SLACK_BOT_TOKEN_NETMANGALABO');
  // 用途の文字列は business-hub「Slackチャンネル」タブの SLACK_PURPOSE_RULES と同じでないと引けない
  assert.equal(c.NOTIFY_TITLE_CHANNEL_PURPOSE, '編集ディレクター');
});

test('設定: トリガーのハンドラ名は実在する関数(文字列参照なので改名に弱い)', () => {
  const c = load();
  assert.equal(typeof c[c.AUTO_CHECK_HANDLER], 'function');
  assert.equal(c.AUTO_CHECK_HOUR, 2, '中国側の稼働 7:00-21:00 の外で動かす');
});

test('appsscript.json: BusinessMaster を固定バージョンで参照し、スコープは増えていない', () => {
  const m = JSON.parse(fs.readFileSync(path.join(SRC, 'appsscript.json'), 'utf8'));
  const libs = m.dependencies.libraries.map(l => l.userSymbol).sort();
  deepEq(libs, ['AccessControl', 'BusinessMaster']);
  m.dependencies.libraries.forEach(l => assert.match(String(l.version), /^\d+$/, 'HEAD追従にしない'));
  deepEq(m.oauthScopes.slice().sort(), [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/script.external_request',
    'https://www.googleapis.com/auth/script.scriptapp',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/userinfo.email',
  ], 'スコープを増やすと利用者全員に再認可が発生する');
});

// ============================================================
// 作品の登録(autoCheckTitles)
// ============================================================
test('titles: 読み書きの往復。登録日時は初回のまま、最終確認は毎回更新', () => {
  const c = load({ props: { DB_SPREADSHEET_ID: 'DB' }, now: '2026-10-03 02:00' });
  const titles = c.loadAutoCheckTitles_();
  deepEq(titles.rows, []);

  c.upsertAutoCheckTitle_(titles, { no: '0007-0044', name: 'ふくしゅうさん' }, 'SRC1');
  c.saveAutoCheckTitles_(titles);
  const again = c.loadAutoCheckTitles_();
  deepEq(again.rows[0], {
    titleNo: '0007-0044', titleName: 'ふくしゅうさん', folderId: 'SRC1',
    registeredAt: '2026-10-03 02:00', seenAt: '2026-10-03 02:00',
  });

  // 翌晩(別の日時)。登録日時は動かさない
  c.__state.now = '2026-10-04 02:00';
  c.upsertAutoCheckTitle_(again, { no: '0007-0044', name: 'ふくしゅうさん' }, 'SRC1');
  c.saveAutoCheckTitles_(again);
  const third = c.loadAutoCheckTitles_();
  assert.equal(third.rows.length, 1);
  assert.equal(third.rows[0].registeredAt, '2026-10-03 02:00');
  assert.equal(third.rows[0].seenAt, '2026-10-04 02:00');
});

test('titles: 写植フォルダが無い作品も登録する(連載開始を取りこぼさないため)', () => {
  const c = load({ props: { DB_SPREADSHEET_ID: 'DB' } });
  const titles = c.loadAutoCheckTitles_();
  c.upsertAutoCheckTitle_(titles, { no: '0007-0099', name: 'まだ連載前' }, '');
  c.saveAutoCheckTitles_(titles);
  const again = c.loadAutoCheckTitles_();
  assert.equal(again.byNo['0007-0099'].folderId, '');
  assert.equal(!!again.byNo['0007-0099'], true, '登録はされている=次回は初回扱いにしない');
});

// ============================================================
// 通しで動かす(Drive・取引先マスタ・Slack をモックして autoCheckMain_ を呼ぶ)
// ============================================================

/** 指定の寸法・DPI・カラーのグレースケールTIFFを作る(server.test.mjs と同じ作り方)。 */
function tiff({ width, height, dpi, photometric = 1 }) {
  const entries = [[256, 3, 1, width], [257, 4, 1, height], [262, 3, 1, photometric], [277, 3, 1, 1], [282, 5, 1, 'X'], [283, 5, 1, 'Y'], [296, 3, 1, 2]];
  const ifdOffset = 8;
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

const CMOA_ROW = ['コミックシーモア（NTTソルマーレ）', 5186, 7323, 600, 'グレースケール', 'ちょうど', 'ちょうど', 'tiff'];
const OK_TIFF = tiff({ width: 5186, height: 7323, dpi: 600 });
const NARROW_TIFF = tiff({ width: 5000, height: 7323, dpi: 600 });

/** Drive/Sheets/Slack をモックした context。tree= フォルダID -> {folders, files}。 */
function loadWired({ tree, titles = [], files = {}, state = {} }) {
  const c = load(Object.assign({ props: { DB_SPREADSHEET_ID: 'DB', SLACK_BOT_TOKEN_MANGATARI: 'xoxb-x' } }, state));
  c.BusinessMaster.listTitlesByPartner = () => titles;
  c.AccessControl.buildPeopleHubSlackDirectory = () => ({ byEmail: {}, byName: { 山崎一生: 'U111' } });
  c.UrlFetchApp.fetch = (url, opts) => {
    if (url.indexOf('slack.com/api/chat.postMessage') !== -1) {
      c.__state.posts.push({ url, payload: JSON.parse(opts.payload) });
      return { getResponseCode: () => 200, getContentText: () => '{"ok":true,"ts":"1.0"}' };
    }
    if (url.indexOf('sheets.googleapis.com') !== -1) {
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ values: [c.MASTER_HEADER, CMOA_ROW] }) };
    }
    const m = /q=([^&]+)/.exec(url);
    const id = decodeURIComponent(m[1]).replace(/^'/, '').split("'")[0];
    const node = tree[id] || { folders: [], files: [] };
    const body = { files: (node.folders || []).map(f => Object.assign({ mimeType: 'application/vnd.google-apps.folder' }, f)).concat(node.files || []) };
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body) };
  };
  c.UrlFetchApp.fetchAll = (reqs) => reqs.map((req) => {
    const id = decodeURIComponent(/files\/([^?]+)\?/.exec(req.url)[1]);
    const buf = files[id];
    if (!buf) return { getResponseCode: () => 404, getContent: () => [], getContentText: () => '{"error":{"code":404,"message":"File not found: ' + id + '"}}' };
    const [a, b] = req.headers.Range.replace('bytes=', '').split('-').map(Number);
    if (a >= buf.length) return { getResponseCode: () => 416, getContent: () => [] };
    const part = buf.subarray(a, Math.min(b + 1, buf.length));
    return { getResponseCode: () => 206, getContent: () => Array.from(part, (x) => (x > 127 ? x - 256 : x)) };
  });
  return c;
}

const TREE_ONE_CHAPTER = {
  WORK1: { folders: [{ id: 'SH1', name: '430_写植' }], files: [] },
  SH1: { folders: [{ id: 'SRC1', name: '200_写植依頼→完成ファイル' }], files: [] },
  SRC1: { folders: [{ id: 'CH1', name: '1話' }], files: [] },
  CH1: { folders: [{ id: 'TIF1', name: 'TIF' }], files: [] },
  TIF1: { folders: [], files: [{ id: 'fileOK000001', name: 'p001.tif', mimeType: 'image/tiff', size: String(OK_TIFF.length) }] },
};
const TITLES_ONE = [{ no: '0007-0044', formalName: 'ふくしゅうさん', workStatus: '４．連載中（継続）', driveFolderId: 'WORK1' }];

test('通し: 初回は既読にするだけで通知しない。次の晩に増えた分だけチェックする', () => {
  const FILES = { fileOK000001: OK_TIFF };
  const c = loadWired({ tree: TREE_ONE_CHAPTER, titles: TITLES_ONE, files: FILES });

  const first = c.autoCheckMain_({ notify: true });
  assert.equal(plain(first).baseline, 1, '1話を既読にした');
  assert.equal(plain(first).checked, 0, 'チェックはしない');
  assert.equal(c.__state.posts.length, 0, '初回は Slack に出さない');
  assert.equal(c.__state.sheets[c.AUTO_CHECK_STATE_SHEET][1][7], '初回登録');

  // 2枚目(規格外の幅)が増えた晩
  c.__state.now = '2026-10-04 02:00';
  TREE_ONE_CHAPTER.TIF1.files.push({ id: 'fileNG000002', name: 'p002.tif', mimeType: 'image/tiff', size: String(NARROW_TIFF.length) });
  FILES.fileNG000002 = NARROW_TIFF;
  const second = c.autoCheckMain_({ notify: true });
  assert.equal(plain(second).checked, 1);
  assert.equal(plain(second).ng, 1);
  assert.equal(c.__state.posts.length, 1, '集約チャンネルに1投稿');
  const text = c.__state.posts[0].payload.text;
  assert.equal(c.__state.posts[0].payload.channel, c.NOTIFY_CHANNEL_ID);
  assert.match(text, /⚠️ 0007-0044 ふくしゅうさん 1話/);
  assert.match(text, /p002\.tif — 幅不一致\(期待 5186px ちょうど \/ 実測 5000px\)/);
  assert.ok(!text.includes('p001.tif'), 'OKのファイルは並べない');

  // 中身が変わっていない3晩目は黙る(同じNGを毎晩鳴らさない)。
  // 直っていない話は「何か動きがあった晩」の投稿の末尾に添えるだけにする。
  c.__state.posts.length = 0;
  const third = c.autoCheckMain_({ notify: true });
  assert.equal(plain(third).checked, 0);
  assert.equal(c.__state.posts.length, 0, '動きが無い晩は投稿しない');

  // 別の話が増えた晩には、直っていない1話が末尾に並ぶ
  c.__state.now = '2026-10-06 02:00';
  TREE_ONE_CHAPTER.SRC1.folders.push({ id: 'CH1B', name: '2話' });
  TREE_ONE_CHAPTER.CH1B = { folders: [], files: [{ id: 'fileOK000009', name: 'p001.tif', mimeType: 'image/tiff', size: String(OK_TIFF.length) }] };
  FILES.fileOK000009 = OK_TIFF;
  c.autoCheckMain_({ notify: true });
  const later = c.__state.posts[0].payload.text;
  assert.match(later, /✅ 0007-0044 ふくしゅうさん 2話/);
  assert.match(later, /まだ直っていない話/);
  assert.match(later, /ふくしゅうさん 1話 \(2026-10-04 02:00 検出 \/ NG 1件\)/);
});

test('通し: 写植フォルダが無い作品は、はじめての1話をチェックする(初回登録にしない)', () => {
  const tree = {
    WORK2: { folders: [], files: [] },       // まだ 430_写植 が無い
    SH2: { folders: [{ id: 'SRC2', name: '200_写植依頼→完成ファイル' }], files: [] },
    SRC2: { folders: [{ id: 'CH2', name: '1話' }], files: [] },
    CH2: { folders: [], files: [{ id: 'fileNG000003', name: 'p001.tif', mimeType: 'image/tiff', size: String(NARROW_TIFF.length) }] },
  };
  const titles = [{ no: '0007-0077', formalName: 'これから連載', workStatus: '１．連載準備', driveFolderId: 'WORK2' }];
  const c = loadWired({ tree, titles, files: { fileNG000003: NARROW_TIFF } });

  const first = c.autoCheckMain_({ notify: true });
  assert.equal(plain(first).checked, 0);
  assert.equal(plain(first).baseline, 0);
  assert.equal(c.__state.posts.length, 0, '写植フォルダが無いだけなら Slack に出さない');
  assert.equal(!!c.loadAutoCheckTitles_().byNo['0007-0077'], true, '作品としては登録済み');

  // 連載が始まって 430_写植 ができ、1話が上がった
  c.__state.now = '2026-10-10 02:00';
  tree.WORK2.folders.push({ id: 'SH2', name: '430_写植' });
  const second = c.autoCheckMain_({ notify: true });
  assert.equal(plain(second).checked, 1, 'はじめての1話はチェックする');
  assert.equal(plain(second).baseline, 0, '既読にして飛ばしてはいけない');
  assert.match(c.__state.posts[0].payload.text, /⚠️ 0007-0077 これから連載 1話/);
});

test('通し: 完結・制作中止の作品は見に行かない', () => {
  const titles = [
    { no: '0007-0044', formalName: 'ふくしゅうさん', workStatus: '９９．完結（合本済）', driveFolderId: 'WORK1' },
    { no: '0007-0045', formalName: 'やめた作品', workStatus: '９０．制作中止', driveFolderId: 'WORK1' },
  ];
  const c = loadWired({ tree: {}, titles, files: {} });
  const stat = plain(c.autoCheckMain_({ notify: true }));
  assert.equal(stat.targets, 0);
  assert.equal(c.__state.posts.length, 0);
});

test('通し: 話フォルダ直下に画像がある作品(TIFサブフォルダ無し)も読む', () => {
  const tree = {
    WORK3: { folders: [{ id: 'SH3', name: '430_写植' }], files: [] },
    SH3: { folders: [{ id: 'SRC3', name: '200_写植依頼→完成ファイル' }], files: [] },
    SRC3: { folders: [{ id: 'CH3', name: '第2話' }], files: [] },
    CH3: { folders: [], files: [{ id: 'fileOK000004', name: 'p001.tif', mimeType: 'image/tiff', size: String(OK_TIFF.length) }] },
  };
  const titles = [{ no: '0007-0088', formalName: 'ベタ置き作品', workStatus: '４．連載中（継続）', driveFolderId: 'WORK3' }];
  const c = loadWired({ tree, titles, files: { fileOK000004: OK_TIFF } });
  c.autoCheckMain_({ notify: false });                       // 初回登録
  const state = c.loadAutoCheckState_();
  assert.equal(state.rows[0].chapter, 2, '「第2話」を2話として読む');
  assert.equal(state.rows[0].fileCount, 1);
});
