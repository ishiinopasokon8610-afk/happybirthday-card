const { onValueCreated } = require('firebase-functions/v2/database');
const { onSchedule } = require('firebase-functions/v2/scheduler');
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
const onCard = (ev) => {
  const c = ev.data.val() || {};
  return send(ev.params.to, (c.fromNm || '友だち') + 'さんからカードが届きました', 'タップして風船を開こう');
};
exports.onWallCard = onValueCreated({ ...DBOPT, ref: '/wall/{to}/{id}' }, onCard);
exports.onPrivateCard = onValueCreated({ ...DBOPT, ref: '/private/{to}/{id}' }, onCard);

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
