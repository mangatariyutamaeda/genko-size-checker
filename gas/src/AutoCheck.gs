/**
 * AutoCheck.gs - 写植データの自動チェック(毎晩2:00)
 * ============================================================
 * コミックシーモアの「完結・制作中止でない」作品の写植フォルダを見て、
 * **新しく上がった話だけ**を取引先の条件(5186×7323 / 600dpi / グレースケール / tiff)で照合し、
 * ファイルセットの整合性(重複・欠番・最大番号ずれ・psd突合)も見て、Slack に出す。
 *
 * 【たどる道】
 *   business-hub 作品タブ(取引先コード 0007 / 案件ステータス90未満) → 作品DriveフォルダID
 *     → 430_写植 → 200_写植依頼→完成ファイル → {N話} → (TIF) → 画像
 *
 * 【なぜ2:00か】写植をやっている中国側の稼働が 7:00-21:00 なので、アップロード中に走って
 *   「欠番だらけ」の誤報を出す心配が実質ない(前田さん 2026-10-02)。
 *
 * 【増えた話の見つけ方】🚩**フォルダの modifiedTime は使えない**。Drive は子の追加で親フォルダの
 *   更新日時を変えない(`10_お客様とのやり取り用` は中身が毎日動いているのに 2020年のまま)。
 *   そこで話フォルダの中身を list して「件数＋ファイルIDの署名」をDB(autoCheckState)と比べる。
 *   写植は話の順に上がるので、見に行くのは**新しい方から AUTO_CHECK_RECENT_CHAPTERS 話だけ**
 *   (＋前回NGだった話。直ったら次の晩にOKが出る)。作品が増えても1晩のAPI呼び出しが増え続けない。
 *
 * 【初回】その作品がDB(autoCheckTitles)に**まだ登録されていない**ときは、いまある話を
 *   チェックせず既読として記録する(結果='初回登録')。過去の全話を遡って通知が溢れるのを防ぐ。
 *   🚩判定に使うのは「作品の登録」。話の行の有無で見ると、写植がまだ無い作品の
 *   「はじめての1話」まで黙って既読になり、連載開始を取りこぼす。
 *
 * 【権限】トリガーは前田さん(ADMIN_EMAILS)のアカウントで作る。Drive はその人の権限で読む
 *   (`10_お客様とのやり取り用` は前田さん所有なので全作品が読める)。OAuthスコープは増えない。
 */

// ============================================================
// 入口
// ============================================================

/**
 * 時間主導トリガーの本体。🚩関数名を変えるとトリガーが参照できなくなる(文字列で持っている)。
 * CI状態シートへの死活記録(ハートビート)はライブラリに任せる。これがあると、新しい話が無くて
 * Slackが無音の晩でも「動いた事実」が残る(ツールポータルの管理者タブ「動作状況」が読む)。
 * 古いライブラリで withHeartbeat が無いときは記録だけ諦めて本体は動かす。
 */
function runAutoCheck() {
  var body = function () { return autoCheckMain_({ notify: true }); };
  if (typeof AccessControl.withHeartbeat !== 'function') {
    console.log('AccessControl.withHeartbeat がありません(ライブラリの版を上げてください)。ハートビートなしで実行します。');
    return body();
  }
  return AccessControl.withHeartbeat(TOOL_NAME, AUTO_CHECK_HANDLER, body);
}

/** 管理者が手で動かす(GASエディタ or 画面から)。通知も出る。 */
function runAutoCheckNow() {
  requireAdmin_();
  return autoCheckMain_({ notify: true });
}

/**
 * 動作確認用。**通知もせず、DBにも何も残さない**(何度やっても状態が変わらない)。
 * 🚩記録しないのが大事: 記録してしまうと「チェック済みなのに誰にも通知されていない話」ができる。
 * 初回登録(いまある話を既読にする)をやりたいときは runAutoCheckNow を使う(初回は通知が出ない)。
 */
function dryRunAutoCheck() {
  requireAdmin_();
  return autoCheckMain_({ notify: false, persist: false });
}

/**
 * Slack への疎通確認。集約チャンネルへ1行だけ投稿して結果を返す。管理者のみ。
 * スクリプトプロパティのトークンが生きているか・チャンネルに投稿できるかを、
 * **本番と同じ経路(slackPost_)で**確かめるためのもの。毎晩の通知とは関係ない。
 */
function testAutoCheckNotify() {
  requireAdmin_();
  var token = slackToken_(NOTIFY_TOKEN_PROP);
  if (!token) {
    throw new Error('スクリプトプロパティ ' + NOTIFY_TOKEN_PROP + ' が未設定です。' +
      'まんがたりWSのBotトークン(xoxb-)を入れてから、もう一度実行してください。');
  }
  var stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  var res = slackPost_(token, NOTIFY_CHANNEL_ID,
    '🔧 疎通確認 (' + stamp + ')。このチャンネルに投稿できています。毎晩' + AUTO_CHECK_HOUR + ':00の自動チェックの結果はここに出ます。');
  if (!res.ok) {
    throw new Error('Slackに投稿できませんでした: ' + res.error +
      '（トークンが違う・チャンネルIDが違う・Botがチャンネルに居ない、のいずれかです）');
  }
  console.log('Slackへ投稿できました: ' + NOTIFY_CHANNEL_NAME);
  return { ok: true, channel: NOTIFY_CHANNEL_NAME, url: NOTIFY_CHANNEL_URL };
}

/** 毎晩 AUTO_CHECK_HOUR 時のトリガーを設置(重複設置しない)。管理者のみ。 */
function installAutoCheckTrigger() {
  requireAdmin_();
  removeAutoCheckTriggers_();
  ScriptApp.newTrigger(AUTO_CHECK_HANDLER).timeBased().atHour(AUTO_CHECK_HOUR).everyDays(1).create();
  console.log('写植データ自動チェックのトリガーを設置しました: 毎日 ' + AUTO_CHECK_HOUR + '時台');
  return { hour: AUTO_CHECK_HOUR };
}

function uninstallAutoCheckTrigger() {
  requireAdmin_();
  removeAutoCheckTriggers_();
}

function removeAutoCheckTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === AUTO_CHECK_HANDLER; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

// ============================================================
// 本体
// ============================================================

/**
 * 1回の実行。options.notify=false なら Slack に出さずに結果を返す。
 * @return {{targets:number, checked:number, ok:number, ng:number, baseline:number, skipped:!Array<string>, posted:!Object}}
 */
function autoCheckMain_(options) {
  var notify = !options || options.notify !== false;
  var persist = !options || options.persist !== false;   // false = 下見だけ(DBを書き換えない)
  var deadline = Date.now() + AUTO_CHECK_DEADLINE_MS;

  var spec = loadAutoCheckSpec_();
  var state = loadAutoCheckState_();
  var titles = loadAutoCheckTitles_();
  // 🚩「最後に見た時刻が古い順」に回る。作品No順のままだと、時間切れのたびに**毎回同じ作品**が
  //   後回しになって永久に見てもらえない。前の晩に回せなかった作品が次の晩は先頭に来る。
  var targets = orderTargetsByStaleness_(collectTargets_(), titles);
  var results = [];
  var baseline = 0;
  var skipped = [];
  var deferred = 0;

  for (var i = 0; i < targets.length; i++) {
    var title = targets[i];
    if (results.length >= AUTO_CHECK_MAX_CHAPTERS_PER_RUN || Date.now() > deadline) {
      deferred = targets.length - i;      // 1作品1行で並べると長くなるので件数だけ出す
      break;
    }

    // この作品を前に見たことがあるか(初回は過去の話を既読にするだけでチェックしない)。
    // 🚩判定は「作品の登録」で行う。話の行の有無で見ると、写植がまだ無い作品の
    //   「はじめての1話」を黙って既読にしてしまう(連載開始を取りこぼす)。
    var known = titles.byNo[title.no] || null;
    var isFirstTime = !known;

    var resolved;
    try {
      resolved = resolveSourceFolder_(title, known);
    } catch (err) {
      console.error('autoCheckMain_: ' + title.no + ' の写植フォルダを見られませんでした: ' + err);
      skipped.push(title.no + ' ' + title.name + '(' + errMessage_(err) + ')');
      continue;
    }
    // 写植フォルダが無くても作品は登録する(次に話が出てきたら「はじめての1話」としてチェックできる)
    upsertAutoCheckTitle_(titles, title, resolved.folderId);
    if (!resolved.folderId) {
      if (resolved.report) skipped.push(title.no + ' ' + title.name + '(' + resolved.note + ')');
      else console.log('autoCheckMain_: ' + title.no + ' ' + title.name + ' は対象外: ' + resolved.note);
      continue;
    }

    var chapters = findChangedChapters_(title, resolved, state);
    for (var c = 0; c < chapters.length; c++) {
      var chapter = chapters[c];
      if (isFirstTime) {
        // 初回登録: チェックせず既読にする(過去の話で通知が溢れないように)
        upsertAutoCheckState_(state, chapter, { result: '初回登録', ngCount: 0 });
        baseline++;
        continue;
      }
      if (results.length >= AUTO_CHECK_MAX_CHAPTERS_PER_RUN || Date.now() > deadline) {
        deferred = Math.max(deferred, targets.length - i);
        break;
      }
      var result = checkChapter_(title, chapter, spec);
      results.push(result);
      upsertAutoCheckState_(state, chapter, { result: result.ok ? 'OK' : 'NG', ngCount: result.ngCount });
    }
  }
  if (deferred) {
    skipped.push('ほか ' + deferred + '作品は上限(' + AUTO_CHECK_MAX_CHAPTERS_PER_RUN + '話/回)か時間の都合で翌晩に回しました');
  }

  if (persist) {
    saveAutoCheckState_(state);
    saveAutoCheckTitles_(titles);
    appendAutoCheckLog_(results);
  }

  // 投稿するのは「動きがあった晩」だけ(チェックした話がある / 見に行けなかった作品がある)。
  // 何も無い晩は黙る。動いた事実はハートビート(CI状態シート)とログに残るので、
  // 毎晩「なし」を流して通知を読み飛ばす癖をつけさせない。
  // 直っていないNGも、この投稿の末尾に添えるだけ(そのために毎晩投稿はしない)。
  var posted = { aggregate: null, titles: [] };
  if (notify && (results.length || skipped.length)) posted = notifyAutoCheck_(results, state, targets.length, skipped);

  var stat = {
    targets: targets.length,
    checked: results.length,
    persisted: persist,
    ok: results.filter(function (r) { return r.ok; }).length,
    ng: results.filter(function (r) { return !r.ok; }).length,
    baseline: baseline,
    skipped: skipped,
    posted: posted
  };
  console.log('写植データ自動チェック: ' + JSON.stringify(stat));
  if (persist) saveLastRun_(stat);
  return stat;
}

/**
 * 「最後に動いた」記録をスクリプトプロパティに残す。
 * 新しい話が無くて Slack が無音の晩でも、画面に動いていると出せるようにするため。
 * 失敗しても本体は落とさない。
 */
function saveLastRun_(stat) {
  try {
    PropertiesService.getScriptProperties().setProperty(AUTO_CHECK_LAST_RUN_PROP, JSON.stringify({
      at: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm'),
      targets: stat.targets, checked: stat.checked, ok: stat.ok, ng: stat.ng,
      baseline: stat.baseline, skipped: stat.skipped.length,
      // 通知の失敗はログに消えて誰も気づけないので、画面に出すために残す
      notifyError: (stat.posted && stat.posted.aggregate && !stat.posted.aggregate.ok)
        ? String(stat.posted.aggregate.error || '') : ''
    }));
  } catch (err) {
    console.log('saveLastRun_: 記録できませんでした(動作には影響しません): ' + err);
  }
}

/** 最後に動いた記録を読む。無ければ null。 */
function loadLastRun_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(AUTO_CHECK_LAST_RUN_PROP);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

/** autoCheckLog の新しい方から limit 件を読む(画面用)。 */
function loadAutoCheckLog_(limit) {
  var sheet = autoCheckSheet_(AUTO_CHECK_LOG_SHEET, AUTO_CHECK_LOG_HEADER);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var take = Math.min(limit || AUTO_CHECK_VIEW_LOG_ROWS, lastRow - 1);
  var from = lastRow - take + 1;
  return sheet.getRange(from, 1, take, AUTO_CHECK_LOG_HEADER.length).getValues().map(function (r) {
    return {
      at: r[0] instanceof Date ? Utilities.formatDate(r[0], 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') : String(r[0] || ''),
      titleNo: String(r[1] || ''), titleName: String(r[2] || ''), chapter: String(r[3] || ''),
      fileCount: r[4] === '' || r[4] == null ? null : Number(r[4]),
      result: String(r[5] || ''), ngCount: r[6] === '' || r[6] == null ? 0 : Number(r[6]),
      detail: String(r[7] || ''), folderUrl: String(r[8] || '')
    };
  }).reverse();   // 新しい順
}

/**
 * 画面の「自動チェック」タブに出す中身を組み立てる(純粋関数。I/Oは呼ぶ側)。
 * @return {{unresolved:!Array<Object>, works:!Array<Object>}}
 */
function buildAutoCheckView_(titles, state) {
  var byTitle = {};
  (state.rows || []).forEach(function (r) {
    if (!byTitle[r.titleNo]) byTitle[r.titleNo] = { chapters: 0, ng: 0, lastCheckedAt: '', lastResult: '' };
    var t = byTitle[r.titleNo];
    t.chapters++;
    if (r.result === 'NG') t.ng++;
    if (r.checkedAt > t.lastCheckedAt) { t.lastCheckedAt = r.checkedAt; t.lastResult = r.result; }
  });

  var unresolved = (state.rows || []).filter(function (r) { return r.result === 'NG'; })
    .sort(function (a, b) {
      if (a.titleNo !== b.titleNo) return a.titleNo < b.titleNo ? -1 : 1;
      return (a.chapter || 0) - (b.chapter || 0);
    })
    .map(function (r) {
      return {
        titleNo: r.titleNo, titleName: r.titleName, chapter: r.chapter,
        checkedAt: r.checkedAt, ngCount: r.ngCount, folderUrl: driveFolderUrl_(r.folderId)
      };
    });

  var works = (titles.rows || []).slice().sort(function (a, b) {
    return a.titleNo < b.titleNo ? -1 : (a.titleNo > b.titleNo ? 1 : 0);
  }).map(function (t) {
    var sum = byTitle[t.titleNo] || { chapters: 0, ng: 0, lastCheckedAt: '', lastResult: '' };
    return {
      titleNo: t.titleNo, titleName: t.titleName, seenAt: t.seenAt,
      folderUrl: t.folderId ? driveFolderUrl_(t.folderId) : '',
      chapters: sum.chapters, ng: sum.ng,
      lastCheckedAt: sum.lastCheckedAt, lastResult: sum.lastResult
    };
  });
  return { unresolved: unresolved, works: works };
}

/** 取引先マスタ(MASTER_SHEET_ID)から コミックシーモア の条件を読む。無ければ例外。 */
function loadAutoCheckSpec_() {
  var res = googleApiGet_(buildSheetsValuesUrl_(MASTER_SHEET_ID, MASTER_RANGE));
  if (res.status !== 200) {
    throw new Error('取引先マスタを読めません (HTTP ' + res.status + ')' + withDetail_(apiErrorDetail_(res.text)));
  }
  var values = (JSON.parse(res.text).values || []);
  for (var r = 1; r < values.length; r++) {       // 1行目はヘッダー
    var spec = specFromMasterRow_(values[r]);
    if (spec.name === AUTO_CHECK_PARTNER_NAME) return spec;
  }
  throw new Error('取引先マスタに「' + AUTO_CHECK_PARTNER_NAME + '」の行がありません。');
}

/**
 * 対象作品。business-hub 作品タブの 取引先コード=0007 かつ
 * 案件ステータス(=作家作品リストG列「連載状況」)の先頭番号が 90未満 で、作品DriveフォルダIDがある行。
 * @return {!Array<{no:string, name:string, folderId:string, status:string}>}
 */
function collectTargets_() {
  var titles = BusinessMaster.listTitlesByPartner(AUTO_CHECK_PARTNER_CODE, { spreadsheetId: BUSINESS_MASTER_SS_ID });
  var out = [];
  (titles || []).forEach(function (t) {
    if (!isTargetStatus_(t.workStatus)) return;
    if (!t.driveFolderId) return;      // フォルダ未解決の作品は見に行けない(business-hub 側で解決してもらう)
    out.push({ no: t.no, name: t.formalName, folderId: t.driveFolderId, status: t.workStatus });
  });
  out.sort(function (a, b) { return a.no < b.no ? -1 : (a.no > b.no ? 1 : 0); });
  return out;
}

/**
 * 見に行く順を「最後に見た時刻が古い順」にする(純粋関数)。一度も見ていない作品が先。
 * 同着は作品No順(毎晩の並びが安定して、ログを追いやすい)。
 */
function orderTargetsByStaleness_(targets, titles) {
  return (targets || []).slice().sort(function (a, b) {
    var sa = (titles.byNo[a.no] && titles.byNo[a.no].seenAt) || '';
    var sb = (titles.byNo[b.no] && titles.byNo[b.no].seenAt) || '';
    if (sa !== sb) return sa < sb ? -1 : 1;
    return a.no < b.no ? -1 : (a.no > b.no ? 1 : 0);
  });
}

/**
 * 案件ステータスが対象か。先頭の番号だけで見る(番号の後ろの表現は変わるため)。
 * 全角数字が使われているので半角に直してから見る。90=制作中止 / 97〜99=完結 は対象外。
 * 番号が読めない行は対象に含める(連載中の取りこぼしを作らない)。
 */
function isTargetStatus_(workStatus) {
  var normalized = String(workStatus || '').trim().replace(/[０-９]/g, function (ch) {
    return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
  });
  var m = normalized.match(/^(\d+)/);
  if (!m) return true;
  return Number(m[1]) < AUTO_CHECK_SKIP_STATUS_FROM;
}

/**
 * 作品の「200_写植依頼→完成ファイル」フォルダを返す。中身(話フォルダ)も一緒に返す。
 * DB(autoCheckTitles)に控えたIDがあればそれを使う(作品フォルダと430_写植のlistを省ける)。
 * 控えが読めなければ引き直す(フォルダを作り直した・移した場合)。
 * @return {{folderId:string, children:Object, note:string, report:boolean}}
 *   folderId='' は対象外。report=true のときだけ Slack に理由を出す
 *   (写植フォルダがまだ無い作品は毎晩同じ行が出るだけなのでログにとどめる)。
 */
function resolveSourceFolder_(title, known) {
  if (known && known.folderId) {
    try {
      return { folderId: known.folderId, children: driveChildren_(known.folderId), note: '', report: false };
    } catch (err) {
      console.log('resolveSourceFolder_: 控えていたフォルダが読めないので引き直します(' + title.no + '): ' + errMessage_(err));
    }
  }
  var shashoku = pickLayoutChild_(driveChildren_(title.folderId).folders, SHASHOKU_LAYOUT.shashoku);
  if (!shashoku) return { folderId: '', children: null, note: '430_写植 がまだありません', report: false };
  var source = pickLayoutChild_(driveChildren_(shashoku.id).folders, SHASHOKU_LAYOUT.source);
  if (!source) {
    return { folderId: '', children: null, note: shashoku.name + ' の中に 200_写植依頼→完成ファイル がありません', report: true };
  }
  return { folderId: source.id, children: driveChildren_(source.id), note: '', report: false };
}

/**
 * 1作品の、中身が変わった話を返す。
 * 新しい方から AUTO_CHECK_RECENT_CHAPTERS 話(＋DBでNGのままの話)を見て、署名が変わったものだけ。
 * @return {!Array<Object>} 話の順(古い方から)
 */
function findChangedChapters_(title, resolved, state) {
  var all = resolved.children.folders
    .map(function (f) { return { id: f.id, name: f.name, number: chapterNumber_(f.name) }; })
    .filter(function (f) { return f.number != null; })
    .sort(function (a, b) { return b.number - a.number; });   // 新しい話が先
  if (!all.length) return [];

  var candidates = pickCandidateChapters_(all, state, AUTO_CHECK_RECENT_CHAPTERS);
  var chapters = [];
  for (var i = 0; i < candidates.length; i++) {
    var folder = candidates[i];
    var imageFolder = pickImageFolder_(folder);
    var files = imageFolder.files.filter(function (f) { return fileKind_(f.name, f.mimeType); })
      .map(function (f) {
        return {
          id: f.id, name: f.name, mimeType: f.mimeType,
          size: f.size != null ? Number(f.size) : null,
          kind: fileKind_(f.name, f.mimeType)
        };
      });
    if (!files.length) continue;                   // まだ何も上がっていない話は黙って飛ばす
    var signature = fileSignature_(files);
    var known = state.byFolderId[folder.id];
    if (known && known.signature === signature) continue;    // 前回から変わっていない
    chapters.push({
      titleNo: title.no, titleName: title.name,
      number: folder.number, folderName: folder.name,
      folderId: folder.id, imageFolderId: imageFolder.id, psdFolderId: imageFolder.psdFolderId,
      files: files, signature: signature
    });
  }
  chapters.sort(function (a, b) { return a.number - b.number; });  // 通知は話の順に出す
  return chapters;
}

/**
 * 見に行く話フォルダを選ぶ(純粋関数)。新しい方から recent 話＋DBで結果がNGのままの話。
 * @param {!Array<{id:string, name:string, number:number}>} sortedDesc 話番号の降順
 */
function pickCandidateChapters_(sortedDesc, state, recent) {
  var picked = [], seen = {};
  sortedDesc.slice(0, recent).forEach(function (f) { picked.push(f); seen[f.id] = true; });
  sortedDesc.forEach(function (f) {
    if (seen[f.id]) return;
    var known = state.byFolderId[f.id];
    if (known && known.result === 'NG') { picked.push(f); seen[f.id] = true; }
  });
  return picked;
}

/**
 * 話フォルダの中の TIF サブフォルダ(あれば)。無ければ話フォルダ直下を画像の置き場とみなす。
 * psd は TIF の**隣**の PSD フォルダにあるので、その場所だけ覚えて返す
 * (中身を読むのは実際にチェックする話だけ。毎晩の list を増やさないため)。
 */
function pickImageFolder_(folder) {
  var children = driveChildren_(folder.id);
  function pick(name) {
    return children.folders.filter(function (f) {
      return normalizeFolderLabel_(f.name) === normalizeFolderLabel_(name);
    })[0] || null;
  }
  var tif = pick(SHASHOKU_IMAGE_SUBFOLDER);
  var psd = pick(SHASHOKU_PSD_SUBFOLDER);
  var psdFolderId = psd ? psd.id : '';
  if (!tif) return { id: folder.id, files: children.files, psdFolderId: psdFolderId };
  return { id: tif.id, files: driveChildren_(tif.id).files, psdFolderId: psdFolderId };
}

/**
 * 隣の PSD フォルダの psd を読む(チェックする話だけ)。読めなくても空で続ける
 * (psd突合が出ないだけで、寸法などのチェックは成り立つ)。
 */
function readPsdSiblings_(chapter) {
  if (!chapter.psdFolderId) return [];
  try {
    return driveChildren_(chapter.psdFolderId).files
      .filter(function (f) { return fileKind_(f.name, f.mimeType) === 'psd'; })
      .map(function (f) { return { name: f.name, kind: 'psd' }; });
  } catch (err) {
    console.log('readPsdSiblings_: PSDフォルダを読めませんでした(' + chapter.titleNo + ' ' + chapter.number + '話): ' + errMessage_(err));
    return [];
  }
}

/** 1話をチェックする。画像の解析(部分取得)→判定→ファイルセット整合性。 */
function checkChapter_(title, chapter, spec) {
  var expected = describeSpec_(spec);
  var images = chapter.files.filter(function (f) { return f.kind === 'image'; });
  var rows = [];
  var notes = 0;

  if (images.length > AUTO_CHECK_MAX_FILES_PER_CHAPTER) {
    return {
      titleNo: title.no, titleName: title.name, chapter: chapter.number,
      folderId: chapter.imageFolderId, fileCount: chapter.files.length, imageCount: images.length,
      ok: false, ngCount: 0, noteCount: 0,
      lines: ['画像が ' + images.length + ' 件あり、1話の上限(' + AUTO_CHECK_MAX_FILES_PER_CHAPTER + '件)を超えています。画面から手で確認してください'],
      mentionNames: mentionNamesFor_(title.no)
    };
  }

  for (var start = 0; start < images.length; start += INSPECT_BATCH_MAX) {
    var batch = images.slice(start, start + INSPECT_BATCH_MAX);
    var specs;
    try {
      specs = inspectImages_(batch);
    } catch (err) {
      specs = batch.map(function () { return { error: errMessage_(err) }; });
    }
    batch.forEach(function (file, i) {
      var judged = judgeImage_(file, specs[i], spec, expected);
      if (judged.ok && judged.reason) notes++;
      rows.push({ name: file.name, ok: judged.ok, reason: judged.reason });
    });
  }

  // ファイルセット整合性は「TIFの画像 ＋ 隣のPSDフォルダのpsd」で見る(psdが無いページを拾うため)
  var setFiles = chapter.files.map(function (f) {
    return { name: f.name, kind: f.kind, root: chapter.folderName };
  }).concat(readPsdSiblings_(chapter).map(function (f) {
    return { name: f.name, kind: 'psd', root: chapter.folderName };
  }));
  var setChecks = computeSetChecks_(setFiles);
  var lines = summarizeNg_(rows, setChecks, AUTO_CHECK_MAX_NG_LINES);
  var ngCount = rows.filter(function (r) { return !r.ok; }).length;

  return {
    titleNo: title.no, titleName: title.name, chapter: chapter.number,
    folderId: chapter.imageFolderId, fileCount: chapter.files.length, imageCount: images.length,
    ok: lines.length === 0, ngCount: ngCount, noteCount: notes,
    lines: lines, mentionNames: mentionNamesFor_(title.no)
  };
}

/** api_inspectImages の中身を直接使う(入場チェックを通らない内部呼び出し)。 */
function inspectImages_(files) {
  return inspectImagesCore_(files);
}

/**
 * NG の内容を人が読む行にする(純粋関数)。ファイルごとのNG → セット整合性の警告 の順。
 * maxLines を超えたら「ほか N件」で締める。
 */
function summarizeNg_(rows, setChecks, maxLines) {
  var lines = [];
  (rows || []).forEach(function (r) {
    if (!r.ok) lines.push(r.name + ' — ' + r.reason);
  });
  ((setChecks && setChecks.warnings) || []).forEach(function (w) {
    (w.items || []).forEach(function (item) { lines.push(item); });
  });
  if (maxLines && lines.length > maxLines) {
    var rest = lines.length - maxLines;
    lines = lines.slice(0, maxLines);
    lines.push('ほか ' + rest + '件(詳細は画面でチェックしてください)');
  }
  return lines;
}

// ============================================================
// 話フォルダ名・署名(純粋関数)
// ============================================================

/** 話フォルダ名 → 話数。'1話' '第12話' '１２話' → 1 / 12 / 12。話数が読めなければ null。 */
function chapterNumber_(folderName) {
  var normalized = String(folderName == null ? '' : folderName).replace(/[０-９]/g, function (ch) {
    return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
  });
  var m = normalized.match(/(\d+)\s*話/);
  return m ? Number(m[1]) : null;
}

/** 比較用にフォルダ名を正規化(前後の空白・全角半角・大文字小文字を落とす)。 */
function normalizeFolderLabel_(name) {
  return String(name == null ? '' : name).replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (ch) {
    return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
  }).replace(/[\s　]+/g, '').toLowerCase();
}

/**
 * 「{接頭番号}_{語}」のフォルダを選ぶ(430_写植 / 200_写植依頼→完成ファイル)。
 * 接頭番号が一致するものを優先し、無ければ語を含むものを採る(作品ごとに番号が違う例があるため)。
 */
function pickLayoutChild_(folders, layout) {
  var list = folders || [];
  var byPrefix = list.filter(function (f) {
    return layout.prefix && String(f.name).indexOf(layout.prefix) === 0 && String(f.name).indexOf(layout.keyword) !== -1;
  });
  if (byPrefix.length) return byPrefix[0];
  var byKeyword = list.filter(function (f) { return String(f.name).indexOf(layout.keyword) !== -1; });
  return byKeyword.length ? byKeyword[0] : null;
}

/**
 * 話フォルダの中身の署名(純粋関数)。前回と同じ中身なら同じ文字列になる。
 * 「件数-ハッシュ」の形。ハッシュは id と size から作る(名前の変更も中身の差し替えも拾う)。
 */
function fileSignature_(files) {
  var parts = (files || []).map(function (f) {
    return String(f.id) + ':' + String(f.name) + ':' + (f.size == null ? '' : f.size);
  }).sort();
  var hash = 0x811c9dc5;                        // FNV-1a 32bit
  var joined = parts.join('|');
  for (var i = 0; i < joined.length; i++) {
    hash ^= joined.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return parts.length + '-' + ('0000000' + hash.toString(16)).slice(-8);
}

function errMessage_(err) {
  return String(err && err.message ? err.message : err);
}

// ============================================================
// Drive(フォルダとファイルの両方を返す)
// ============================================================

/**
 * フォルダの直下を1回のページングで全部読む。
 * @return {{folders:!Array<Object>, files:!Array<Object>}}
 */
function driveChildren_(folderId) {
  var folders = [], files = [], pageToken = '';
  do {
    var res = googleApiGet_(buildChildrenListUrl_(folderId, pageToken));
    if (res.status !== 200) {
      throw new Error('フォルダ一覧取得に失敗しました (HTTP ' + res.status + ')' + withDetail_(apiErrorDetail_(res.text)));
    }
    var data = JSON.parse(res.text);
    (data.files || []).forEach(function (f) {
      if (f.mimeType === 'application/vnd.google-apps.folder') folders.push(f);
      else files.push(f);
    });
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return { folders: folders, files: files };
}

function buildChildrenListUrl_(folderId, pageToken) {
  var q = encodeURIComponent("'" + folderId + "' in parents and trashed = false");
  var fields = encodeURIComponent('nextPageToken, files(id,name,mimeType,size,modifiedTime)');
  var url = 'https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=' + fields +
    '&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives' +
    '&orderBy=name';
  return pageToken ? url + '&pageToken=' + encodeURIComponent(pageToken) : url;
}

// ============================================================
// DB(autoCheckState / autoCheckLog)
// ============================================================

/**
 * 見ている作品を読む。{byNo: {作品No: row}, rows: [...]}。
 * 「前に見たことがあるか」の判定(初回登録)と、写植完成フォルダIDの控えに使う。
 */
function loadAutoCheckTitles_() {
  var sheet = autoCheckSheet_(AUTO_CHECK_TITLES_SHEET, AUTO_CHECK_TITLES_HEADER);
  var out = { byNo: {}, rows: [], dirty: false };
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return out;
  sheet.getRange(2, 1, lastRow - 1, AUTO_CHECK_TITLES_HEADER.length).getValues().forEach(function (r) {
    var row = {
      titleNo: String(r[0] || '').trim(),
      titleName: String(r[1] || '').trim(),
      folderId: String(r[2] || '').trim(),
      registeredAt: r[3] instanceof Date ? Utilities.formatDate(r[3], 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') : String(r[3] || ''),
      seenAt: r[4] instanceof Date ? Utilities.formatDate(r[4], 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') : String(r[4] || '')
    };
    if (!row.titleNo) return;
    out.rows.push(row);
    out.byNo[row.titleNo] = row;
  });
  return out;
}

/** 作品を登録する(初回は登録日時を入れる)。写植フォルダIDは空でも登録する。 */
function upsertAutoCheckTitle_(titles, title, sourceFolderId) {
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  var row = titles.byNo[title.no];
  if (!row) {
    row = { titleNo: title.no, registeredAt: now };
    titles.rows.push(row);
    titles.byNo[title.no] = row;
  }
  // 登録日時が空、または「いま」より後になっていたら直す(日付解釈でずれた分の自己修復)
  if (!row.registeredAt || row.registeredAt > now) row.registeredAt = now;
  row.titleName = title.name;
  row.folderId = sourceFolderId || '';
  row.seenAt = now;
  titles.dirty = true;
}

function saveAutoCheckTitles_(titles) {
  if (!titles.dirty) return;
  var sheet = autoCheckSheet_(AUTO_CHECK_TITLES_SHEET, AUTO_CHECK_TITLES_HEADER);
  var rows = titles.rows.slice().sort(function (a, b) {
    return a.titleNo < b.titleNo ? -1 : (a.titleNo > b.titleNo ? 1 : 0);
  }).map(function (r) {
    return [r.titleNo, r.titleName, r.folderId, r.registeredAt, r.seenAt];
  });
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, AUTO_CHECK_TITLES_HEADER.length).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, AUTO_CHECK_TITLES_HEADER.length).setValues(rows);
}

/** state を読む。{byFolderId: {id: row}, titles: {作品No: true}, rows: [...]}。 */
function loadAutoCheckState_() {
  var sheet = autoCheckSheet_(AUTO_CHECK_STATE_SHEET, AUTO_CHECK_STATE_HEADER);
  var out = { byFolderId: {}, titles: {}, rows: [], dirty: false };
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return out;
  sheet.getRange(2, 1, lastRow - 1, AUTO_CHECK_STATE_HEADER.length).getValues().forEach(function (r) {
    var row = {
      titleNo: String(r[0] || '').trim(),
      titleName: String(r[1] || '').trim(),
      chapter: r[2] === '' || r[2] == null ? null : Number(r[2]),
      folderId: String(r[3] || '').trim(),
      signature: String(r[4] || '').trim(),
      fileCount: r[5] === '' || r[5] == null ? null : Number(r[5]),
      checkedAt: r[6] instanceof Date ? Utilities.formatDate(r[6], 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') : String(r[6] || ''),
      result: String(r[7] || '').trim(),
      ngCount: r[8] === '' || r[8] == null ? 0 : Number(r[8])
    };
    if (!row.folderId) return;
    out.rows.push(row);
    out.byFolderId[row.folderId] = row;
    if (row.titleNo) out.titles[row.titleNo] = true;
  });
  return out;
}

/** 1話分の既読状態を書き込む(メモリ上。保存は saveAutoCheckState_)。 */
function upsertAutoCheckState_(state, chapter, outcome) {
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  var row = state.byFolderId[chapter.folderId];
  if (!row) {
    row = { folderId: chapter.folderId };
    state.rows.push(row);
    state.byFolderId[chapter.folderId] = row;
  }
  row.titleNo = chapter.titleNo;
  row.titleName = chapter.titleName;
  row.chapter = chapter.number;
  row.signature = chapter.signature;
  row.fileCount = chapter.files.length;
  row.checkedAt = now;
  row.result = outcome.result;
  row.ngCount = outcome.ngCount || 0;
  state.titles[chapter.titleNo] = true;
  state.dirty = true;
}

/** state をシートへ書き戻す(行数は作品数×話数で数百〜数千。まとめて1回で書く)。 */
function saveAutoCheckState_(state) {
  if (!state.dirty) return;
  var sheet = autoCheckSheet_(AUTO_CHECK_STATE_SHEET, AUTO_CHECK_STATE_HEADER);
  var rows = state.rows.slice().sort(function (a, b) {
    if (a.titleNo !== b.titleNo) return a.titleNo < b.titleNo ? -1 : 1;
    return (a.chapter || 0) - (b.chapter || 0);
  }).map(function (r) {
    return [r.titleNo, r.titleName, r.chapter, r.folderId, r.signature, r.fileCount, r.checkedAt, r.result, r.ngCount];
  });
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, AUTO_CHECK_STATE_HEADER.length).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, AUTO_CHECK_STATE_HEADER.length).setValues(rows);
}

/** チェックした話をログに足す(古い行は AUTO_CHECK_LOG_MAX_ROWS まで切る)。 */
function appendAutoCheckLog_(results) {
  if (!results || !results.length) return;
  var sheet = autoCheckSheet_(AUTO_CHECK_LOG_SHEET, AUTO_CHECK_LOG_HEADER);
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  var rows = results.map(function (r) {
    return [now, r.titleNo, r.titleName, r.chapter + '話', r.fileCount,
      r.ok ? 'OK' : 'NG', r.ngCount, r.lines.join(' / ').slice(0, 2000),
      driveFolderUrl_(r.folderId), NOTIFY_CHANNEL_NAME];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, AUTO_CHECK_LOG_HEADER.length).setValues(rows);
  var over = sheet.getLastRow() - 1 - AUTO_CHECK_LOG_MAX_ROWS;
  if (over > 0) sheet.deleteRows(2, over);
}

/**
 * DBのタブを用意する(冪等)。
 * 🚩日時の列は**書式を文字列(@)にする**。そうしないとシートが「2026-10-03 11:24」を日付として
 *   解釈し、読み直すたびにスプレッドシートのタイムゾーン差ぶん(9時間)ずれていく
 *   (2026-10-03 に登録日時が 11:24 → 20:24 になって発覚)。毎回かけ直して直す。
 */
function autoCheckSheet_(name, header) {
  var config = getConfig_();
  if (!config.dbSpreadsheetId) throw new Error(dbMissingMessage_());
  var ss = SpreadsheetApp.openById(config.dbSpreadsheetId);
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sheet.getLastRow() < 1) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    sheet.setFrozenRows(1);
  }
  for (var i = 0; i < header.length; i++) {
    if (!isTimestampHeader_(header[i])) continue;
    try {
      sheet.getRange(1, i + 1, sheet.getMaxRows(), 1).setNumberFormat('@');
    } catch (err) {
      console.log('autoCheckSheet_: ' + name + ' の「' + header[i] + '」を文字列書式にできませんでした: ' + err);
    }
  }
  return sheet;
}

/** 日時を入れる列か(見出しで判断する)。 */
function isTimestampHeader_(label) {
  return ['日時', '登録日時', '最終確認', '最終チェック'].indexOf(String(label || '')) !== -1;
}

// ============================================================
// 通知
// ============================================================

/** 集約チャンネルへ1投稿＋NGの作品ごとに『編集ディレクター』chへ1投稿。 */
function notifyAutoCheck_(results, state, targetCount, skipped) {
  var posted = { aggregate: null, titles: [] };
  var token = slackToken_(NOTIFY_TOKEN_PROP);
  if (!token) {
    console.error('notifyAutoCheck_: スクリプトプロパティ ' + NOTIFY_TOKEN_PROP + ' が未設定のため通知できません。');
    return posted;
  }
  var dir = mentionDirectory_(NOTIFY_SLACK_TOOL_NAME);
  var stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'MM/dd HH:mm');
  // 見に行く順は「古い順」だが、読む人のために投稿は作品No順・話順に並べ直す
  results = (results || []).slice().sort(function (a, b) {
    if (a.titleNo !== b.titleNo) return a.titleNo < b.titleNo ? -1 : 1;
    return a.chapter - b.chapter;
  });
  var text = buildRunMessage_(results, {
    stamp: stamp,
    targetCount: targetCount,
    skipped: skipped,
    unresolved: unresolvedNgRows_(state, results),
    mentions: results.map(function (r) { return buildMentions_(r.mentionNames, dir.byName).text; })
  });
  posted.aggregate = slackPost_(token, NOTIFY_CHANNEL_ID, text);

  // エラーだけ、作品ごとの社内ch(ネットマンガラボ)にも出す。トークンが無ければ黙って諦める。
  var titleToken = slackToken_(NOTIFY_TITLE_TOKEN_PROP);
  if (!titleToken) return posted;
  var titleDir = mentionDirectory_(NOTIFY_TITLE_SLACK_TOOL_NAME);
  results.filter(function (r) { return !r.ok; }).forEach(function (r) {
    var ch = titleChannelFor_(r.titleNo);
    if (!ch) return;
    var body = buildTitleMessage_(r, buildMentions_(r.mentionNames, titleDir.byName).text);
    var res = slackPost_(titleToken, ch.channelId, body);
    posted.titles.push({ titleNo: r.titleNo, channel: ch.channelName, ok: res.ok, error: res.error });
  });
  return posted;
}

/**
 * 前の晩までにNGで、今回チェックしなかった話(=まだ直っていない)。
 * 直っていないものを毎晩鳴らさず、まとめの末尾に一覧で添えるために使う。
 */
function unresolvedNgRows_(state, results) {
  var checkedNow = {};
  (results || []).forEach(function (r) { checkedNow[r.titleNo + '/' + r.chapter] = true; });
  return (state.rows || [])
    .filter(function (r) { return r.result === 'NG' && !checkedNow[r.titleNo + '/' + r.chapter]; })
    .sort(function (a, b) {
      if (a.titleNo !== b.titleNo) return a.titleNo < b.titleNo ? -1 : 1;
      return (a.chapter || 0) - (b.chapter || 0);
    });
}

/**
 * 集約チャンネルの本文(純粋関数)。
 * @param {!Array<Object>} results checkChapter_ の結果
 * @param {{stamp:string, targetCount:number, skipped:!Array<string>, unresolved:!Array<Object>, mentions:!Array<string>}} ctx
 */
function buildRunMessage_(results, ctx) {
  var lines = ['📐 *写植データ自動チェック* ' + ctx.stamp];
  if (!results.length) {
    lines.push('新しく上がった写植データはありませんでした。(対象 ' + ctx.targetCount + '作品)');
  } else {
    var ng = results.filter(function (r) { return !r.ok; }).length;
    lines.push('新しく上がった ' + results.length + '話 をチェックしました。(対象 ' + ctx.targetCount + '作品 / NG ' + ng + '話)');
    lines.push('');
    results.forEach(function (r, i) {
      lines.push((r.ok ? '✅ ' : '⚠️ ') + r.titleNo + ' ' + r.titleName + ' ' + r.chapter + '話 — 画像' + r.imageCount + '件' +
        (r.ok ? ' すべてOK' : ' / NG ' + r.ngCount + '件'));
      r.lines.forEach(function (item) { lines.push('　　・' + item); });
      if (r.noteCount) lines.push('　　（注記 ' + r.noteCount + '件: DPI未検証。判定はOKのまま）');
      if (!r.ok) {
        lines.push('　　' + driveFolderUrl_(r.folderId));
        var mention = (ctx.mentions || [])[i] || '';
        if (mention) lines.push('　　担当: ' + mention);
      }
    });
  }
  if (ctx.unresolved && ctx.unresolved.length) {
    lines.push('');
    lines.push('_まだ直っていない話(今回は中身に変化がないので再チェックしていません)_');
    ctx.unresolved.forEach(function (r) {
      lines.push('　・' + r.titleNo + ' ' + r.titleName + ' ' + r.chapter + '話 (' + r.checkedAt + ' 検出 / NG ' + r.ngCount + '件)');
    });
  }
  if (ctx.skipped && ctx.skipped.length) {
    lines.push('');
    lines.push('_見に行けなかった作品_');
    ctx.skipped.forEach(function (s) { lines.push('　・' + s); });
  }
  return lines.join('\n');
}

/** 作品ごとの社内ch(編集ディレクター)の本文(純粋関数)。エラーのときだけ出す。 */
function buildTitleMessage_(result, mentionText) {
  var lines = ['⚠️ *写植データ自動チェック* — ' + result.titleName + ' ' + result.chapter + '話'];
  lines.push('画像' + result.imageCount + '件 / NG ' + result.ngCount + '件');
  result.lines.forEach(function (item) { lines.push('・' + item); });
  lines.push(driveFolderUrl_(result.folderId));
  if (mentionText) lines.push('担当: ' + mentionText);
  lines.push('_全作品の結果は まんがたりの ' + NOTIFY_CHANNEL_NAME + ' に出ています_');
  return lines.join('\n');
}

function driveFolderUrl_(folderId) {
  return 'https://drive.google.com/drive/folders/' + folderId;
}

/**
 * メンションする氏名(作家作品リストの ディレクター/編集者/アサイン責任者)。
 * 前田さん2026-10-02: 社員は全員。社外の人は辞書に無いので「名前(Slack未解決)」で出る。
 */
function mentionNamesFor_(titleNo) {
  var map = authorWorkListPeople_();
  var rec = map[titleNo] || null;
  if (!rec) return [];
  var names = [];
  NOTIFY_MENTION_COLUMNS.forEach(function (col) {
    splitPersonNames_(rec[col]).forEach(function (n) { names.push(n); });
  });
  return names;
}

/**
 * コミックシーモアの作家作品リストから「作品No -> {ディレクター, 編集者, アサイン責任者}」を作る。
 * 🚩2行目までがヘッダー・データは3行目から(共通ルール9章)。列は2行目の実列名で解決し、
 *   見つからない列は触らない。作品Noは重複しうるので先に出てきた行を採る(後勝ちで踏み潰さない)。
 * 1回の実行で1度だけ読む。
 */
var AUTO_CHECK_PEOPLE_CACHE_ = null;
function authorWorkListPeople_() {
  if (AUTO_CHECK_PEOPLE_CACHE_) return AUTO_CHECK_PEOPLE_CACHE_;
  var out = {};
  try {
    var cfg = BusinessMaster.getAuthorWorkListConfig(AUTO_CHECK_PARTNER_CODE, {
      spreadsheetId: BUSINESS_MASTER_SS_ID, sheetName: BUSINESS_MASTER_SHEET
    });
    if (!cfg) throw new Error('取引先マスタに作家作品リストの登録がありません');
    var sheet = SpreadsheetApp.openById(cfg.ssId).getSheetByName(cfg.sheetName);
    if (!sheet) throw new Error('作家作品リストに「' + cfg.sheetName + '」タブがありません');
    out = parseAuthorWorkListPeople_(sheet.getDataRange().getDisplayValues(), cfg.headerRows, NOTIFY_MENTION_COLUMNS);
  } catch (err) {
    console.error('authorWorkListPeople_: 担当者を引けませんでした(メンションなしで通知します): ' + err);
  }
  AUTO_CHECK_PEOPLE_CACHE_ = out;
  return out;
}

/**
 * 作家作品リストの表 → {作品No: {列名: 値}}(純粋関数)。
 * @param {!Array<!Array<string>>} values 表示値の2次元配列
 * @param {number} headerRows ヘッダー行数(既定2)
 * @param {!Array<string>} columns 取りたい列名(2行目の実列名)
 */
function parseAuthorWorkListPeople_(values, headerRows, columns) {
  var rows = values || [];
  var header = Math.max(1, headerRows || 2);
  var out = {};
  if (rows.length <= header) return out;

  // 列解決: 2行目(header行)を優先し、無ければ1行目。曖昧一致は許さない。
  var idx = {};
  var noCol = -1;
  for (var r = header - 1; r >= 0; r--) {
    for (var c = 0; c < rows[r].length; c++) {
      var label = String(rows[r][c] == null ? '' : rows[r][c]).trim();
      if (!label) continue;
      if (noCol === -1 && (label === '作品No' || label === 'no' || label === 'No')) noCol = c;
      columns.forEach(function (want) {
        if (idx[want] === undefined && label === want) idx[want] = c;
      });
    }
  }
  if (noCol === -1) return out;

  for (var i = header; i < rows.length; i++) {
    var raw = String(rows[i][noCol] == null ? '' : rows[i][noCol]).trim();
    var no = normalizeTitleNoForList_(raw);
    if (!no || out[no]) continue;        // 重複は先に出てきた行を採る
    var rec = {};
    columns.forEach(function (want) {
      rec[want] = idx[want] === undefined ? '' : String(rows[i][idx[want]] == null ? '' : rows[i][idx[want]]).trim();
    });
    out[no] = rec;
  }
  return out;
}

/**
 * 作家作品リストの作品No(下4桁だけの '44' / '0044' のことがある)を business-hub の形
 * '0007-0044' に揃える(純粋関数)。'0007-0044' のようにすでに揃っていればそのまま。
 */
function normalizeTitleNoForList_(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  if (/^\d{1,4}-\d{1,4}$/.test(s)) {
    var parts = s.split('-');
    return pad4_(parts[0]) + '-' + pad4_(parts[1]);
  }
  if (/^\d{1,4}$/.test(s)) return AUTO_CHECK_PARTNER_CODE + '-' + pad4_(s);
  return '';
}

function pad4_(v) {
  var s = String(v);
  while (s.length < 4) s = '0' + s;
  return s;
}
