/**
 * Notify.gs - Slack通知(Botトークン方式)
 * ============================================================
 * 自動チェック(AutoCheck.gs)の結果を Slack に出す。Incoming Webhook ではなく Bot トークンを使う
 * (チャンネルIDに投稿する・メンションを飛ばすため)。
 *
 * 【投稿先】
 *   - 集約: NOTIFY_CHANNEL_ID(まんがたりWS)。その晩の結果を1投稿にまとめる。
 *   - エラーのみ: 作品ごとの用途『編集ディレクター』ch(ネットマンガラボWS・社内だけ)。
 *     宛先の正本は business-hub「Slackチャンネル」タブ(共通ルール6-1。ツール側にIDを直書きしない)。
 *
 * 🚩**メンションのメンバーIDはワークスペースごとに別物。** まんがたりWSの投稿に
 *   ネットマンガラボのIDを書いても「@unknown」になるだけで誰にも届かない。
 *   投稿先とメンション辞書(people-hub のツール名)を必ず揃える。
 *
 * 【トークン】Script Properties。コードにもシートにも書かない。
 *   SLACK_BOT_TOKEN_MANGATARI(必須) / SLACK_BOT_TOKEN_NETMANGALABO(あれば作品chにも出す)
 *   必要スコープ: chat:write(公開chは chat:write.public で未参加でも投稿できる)
 */

/** Script Properties からトークンを読む。無ければ ''(呼び側が送信を諦める)。 */
function slackToken_(propName) {
  try {
    return String(PropertiesService.getScriptProperties().getProperty(propName) || '').trim();
  } catch (err) {
    console.error('slackToken_: スクリプトプロパティを読めません: ' + err);
    return '';
  }
}

/**
 * chat.postMessage。例外は投げず結果を返す(通知の失敗で本処理を落とさない)。
 * @return {{ok: boolean, error: string, ts: string}}
 */
function slackPost_(token, channelId, text) {
  if (!token) return { ok: false, error: 'トークン未設定', ts: '' };
  if (!channelId) return { ok: false, error: 'チャンネル未指定', ts: '' };
  var res = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ channel: channelId, text: text, unfurl_links: false, unfurl_media: false }),
    muteHttpExceptions: true
  });
  var body = {};
  try { body = JSON.parse(res.getContentText()); } catch (err) { body = {}; }
  if (!body.ok) {
    console.error('slackPost_: 失敗 HTTP ' + res.getResponseCode() + ' / ' + (body.error || res.getContentText().slice(0, 200)));
    return { ok: false, error: String(body.error || ('HTTP ' + res.getResponseCode())), ts: '' };
  }
  return { ok: true, error: '', ts: String(body.ts || '') };
}

/**
 * 氏名の突合キー。作家作品リストと社員一覧で空白の有無が揺れる(「山崎 一生」/「山崎一生」)ので
 * 空白(半角・全角)を落として比べる。people-hub の正式名称管理が存在する理由そのものなので、
 * ここで完全一致を期待しない。
 */
function normalizePersonName_(name) {
  return String(name == null ? '' : name).replace(/[\s　]+/g, '').trim();
}

/** 氏名の欄(「山崎一生」「山崎/木原」「山崎 一生、木原 凜」)を氏名の配列にする。 */
function splitPersonNames_(value) {
  return String(value == null ? '' : value)
    .split(/[\/、,，・\n]+/)
    .map(function (s) { return String(s).trim(); })
    .filter(function (s) { return s && s !== '-' && s !== '―' && s !== '未定'; });
}

/**
 * 氏名の配列 → メンション文字列。辞書に無い人は名前のまま残す(通知自体は止めない)。
 * @param {!Array<string>} names 氏名(重複可)
 * @param {!Object} byName 正規化氏名 -> SlackメンバーID
 * @return {{text: string, resolved: !Array<string>, unresolved: !Array<string>}}
 */
function buildMentions_(names, byName) {
  byName = byName || {};
  var seenId = {}, seenName = {}, parts = [], resolved = [], unresolved = [];
  (names || []).forEach(function (raw) {
    var name = String(raw || '').trim();
    if (!name) return;
    var key = normalizePersonName_(name);
    if (!key || seenName[key]) return;
    seenName[key] = true;
    var id = byName[key] || '';
    if (id) {
      if (seenId[id]) return;       // 同じ人が2つの列に入っていたら1回だけ
      seenId[id] = true;
      parts.push('<@' + id + '>');
      resolved.push(name);
    } else {
      parts.push(name + '(Slack未解決)');
      unresolved.push(name);
    }
  });
  return { text: parts.join(' '), resolved: resolved, unresolved: unresolved };
}

/**
 * people-hub から「氏名 -> SlackメンバーID」を引く。ワークスペースごとにツール名が違う。
 * 失敗しても空の辞書を返す(メンションが名前のままになるだけ)。実行ごとに1回だけ読む。
 */
var NOTIFY_DIR_CACHE_ = {};
function mentionDirectory_(slackToolName) {
  if (NOTIFY_DIR_CACHE_[slackToolName]) return NOTIFY_DIR_CACHE_[slackToolName];
  var dir = { byEmail: {}, byName: {} };
  try {
    dir = AccessControl.buildPeopleHubSlackDirectory({
      peopleHubSpreadsheetId: PEOPLE_HUB_SPREADSHEET_ID,
      toolUsageSheetName: PEOPLE_HUB_TOOL_USAGE_SHEET,
      employeesSheetName: PEOPLE_HUB_EMPLOYEES_SHEET,
      slackToolName: slackToolName,
      normalizeName: normalizePersonName_
    });
  } catch (err) {
    console.error('mentionDirectory_: people-hub を読めませんでした(メンションは名前のまま): ' + err);
  }
  NOTIFY_DIR_CACHE_[slackToolName] = dir;
  return dir;
}

/**
 * 作品の用途『編集ディレクター』チャンネルを business-hub から引く。
 * 投稿できない(非公開でBot未参加)・登録が無い場合は null。
 */
function titleChannelFor_(titleNo) {
  try {
    var ch = BusinessMaster.resolveTitleSlackChannel(titleNo, NOTIFY_TITLE_CHANNEL_PURPOSE, {
      spreadsheetId: BUSINESS_MASTER_SS_ID
    });
    if (ch && ch.channelId && ch.canPost) return ch;
    if (ch) console.log('titleChannelFor_: ' + titleNo + ' の ' + NOTIFY_TITLE_CHANNEL_PURPOSE + ' chは投稿不可(非公開でBot未参加): ' + ch.channelName);
    return null;
  } catch (err) {
    console.error('titleChannelFor_: Slackチャンネルタブを読めませんでした: ' + err);
    return null;
  }
}
