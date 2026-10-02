const { onValueCreated, onValueDeleted } = require('firebase-functions/v2/database');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

admin.initializeApp({
  databaseURL: 'https://happybithday-card-default-rtdb.asia-southeast1.firebasedatabase.app'
});
const db = admin.database();

// Realtime Database のリージョンと同じ場所に置く
const DBOPT = { region: 'asia-southeast1', instance: 'happybithday-card-default-rtdb' };

// 指定ユーザーの全端末に通知を送る（無効になった端末は削除）
async function send(uid, title, body) {
  const tokens = (await db.ref('tokens/' + uid).get()).val() || {};
  for (const [dev, token] of Object.entries(tokens)) {
    try {
      await admin.messaging().send({ token, data: { title, body, url: './' } });
    } catch (e) {
      if (/not-registered|invalid-argument|invalid-registration/.test(e.code || '')) {
        await db.ref(`tokens/${uid}/${dev}`).remove();
      }
    }
  }
}

// カードが届いたとき
// 風船（カード）の数を数え直して保存する： balloons/{受取人}/{年}/{w:公開, p:非公開}
async function recount(to, y) {
  if (y == null) return;
  const [w, p] = await Promise.all(['wall', 'private'].map(async (k) =>
    Object.values((await db.ref(k + '/' + to).get()).val() || {}).filter((c) => c && c.y === y).length));
  await db.ref(`balloons/${to}/${y}`).set({ w, p });
}
const onCard = async (ev) => {
  const c = ev.data.val() || {};
  try { await recount(ev.params.to, c.y); } catch (e) { console.error('recount', e); }
  return send(ev.params.to, (c.fromNm || '友だち') + 'さんからカードが届きました', 'タップして風船を開こう');
};
exports.onWallCard = onValueCreated({ ...DBOPT, ref: '/wall/{to}/{id}' }, onCard);
exports.onPrivateCard = onValueCreated({ ...DBOPT, ref: '/private/{to}/{id}' }, onCard);
const onDel = (ev) => recount(ev.params.to, (ev.data.val() || {}).y);
exports.onWallDel = onValueDeleted({ ...DBOPT, ref: '/wall/{to}/{id}' }, onDel);
exports.onPrivateDel = onValueDeleted({ ...DBOPT, ref: '/private/{to}/{id}' }, onDel);

// 毎朝8時（日本時間）：誕生日の本人と友だちに通知。3日前にも友だちへ通知
const jstMD = (offset) => {
  const t = new Date(Date.now() + 9 * 3600e3 + offset * 864e5);
  return { m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
exports.birthdayDaily = onSchedule(
  { schedule: '0 8 * * *', timeZone: 'Asia/Tokyo', region: 'asia-northeast1' },
  async () => {
    const profiles = (await db.ref('profiles').get()).val() || {};
    for (const [uid, p] of Object.entries(profiles)) {
      for (const offset of [0, 3]) {
        const t = jstMD(offset);
        if (p.m !== t.m || p.d !== t.d) continue;
        if (offset === 0) await send(uid, 'お誕生日おめでとうございます！', '素敵な1年になりますように✨');
        const friends = Object.keys((await db.ref('friends/' + uid).get()).val() || {});
        for (const f of friends) {
          await send(
            f,
            offset === 0 ? '今日は' + p.nm + 'さんの誕生日です' : '3日後は' + p.nm + 'さんの誕生日です',
            offset === 0 ? 'カードや風船でお祝いしよう' : 'カードを書いてみよう'
          );
        }
      }
    }
  }
);

// LINEログイン：LINEの認可コードをFirebaseのログイン用トークンに変える
const LINE_SECRET = defineSecret('LINE_CHANNEL_SECRET');
const LINE_ID = '2011832628';
const LINE_CB = 'https://ishiinopasokon8610-afk.github.io/happybirthday-card/';
const form = async (url, o) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });
  return { ok: r.ok, j: await r.json().catch(() => ({})) };
};
exports.lineAuth = onCall({ region: 'asia-northeast1', secrets: [LINE_SECRET] }, async (req) => {
  const code = req.data && req.data.code;
  if (typeof code !== 'string' || !code || code.length > 500) throw new HttpsError('invalid-argument', 'bad code');
  const t = await form('https://api.line.me/oauth2/v2.1/token', {
    grant_type: 'authorization_code', code, redirect_uri: LINE_CB, client_id: LINE_ID, client_secret: LINE_SECRET.value().trim()
  });
  if (!t.ok || !t.j.id_token) { console.error('line token', t.j); throw new HttpsError('unauthenticated', 'LINE token: ' + (t.j.error_description || t.j.error || 'unknown')); }
  const v = await form('https://api.line.me/oauth2/v2.1/verify', { id_token: t.j.id_token, client_id: LINE_ID });
  if (!v.ok || !v.j.sub) { console.error('line verify', v.j); throw new HttpsError('unauthenticated', 'LINE verify: ' + (v.j.error_description || v.j.error || 'unknown')); }
  const token = await admin.auth().createCustomToken('line:' + v.j.sub);
  return { token, name: String(v.j.name || '').slice(0, 20) };
});
