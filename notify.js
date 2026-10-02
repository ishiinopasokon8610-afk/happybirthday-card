// 使い方：既存の functions/index.js の末尾に
//   Object.assign(exports, require('./notify'));
// を1行足す。 cd functions && npm i nodemailer
// firebase functions:secrets:set SMTP_USER / SMTP_PASS（Gmailのアプリパスワード）
const {onValueCreated,onValueWritten}=require('firebase-functions/v2/database');
const {onSchedule}=require('firebase-functions/v2/scheduler');
const {defineSecret}=require('firebase-functions/params');
const admin=require('firebase-admin');
const nodemailer=require('nodemailer');
if(!admin.apps.length)admin.initializeApp();

const SMTP_USER=defineSecret('SMTP_USER'),SMTP_PASS=defineSecret('SMTP_PASS');
const SITE='https://ishiinopasokon8610-afk.github.io/happybirthday-card/';
const db=()=>admin.database();
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

const mail=(to,subject,text,html)=>nodemailer.createTransport({service:'gmail',auth:{user:SMTP_USER.value(),pass:SMTP_PASS.value()}})
  .sendMail({from:`おたんじょうびカード <${SMTP_USER.value()}>`,to,subject,text,html});

// push（全端末）＋ メール（オンの人だけ）
async function notify(uid,title,pushBody,text,html){
  const [tk,nt]=await Promise.all([db().ref('tokens/'+uid).get(),db().ref('notify/'+uid).get()]);
  const ents=Object.entries(tk.val()||{}),n=nt.val(),jobs=[];
  if(ents.length)jobs.push(admin.messaging().sendEachForMulticast({tokens:ents.map(e=>e[1]),data:{title,body:pushBody,url:SITE}})
    .then(r=>Promise.all(r.responses.map((x,i)=>x.error&&/not-registered|invalid-argument|invalid-registration/.test(x.error.code)?db().ref(`tokens/${uid}/${ents[i][0]}`).remove():0)))
    .catch(e=>console.error('push',uid,e)));
  if(n&&n.on&&n.em)jobs.push(mail(n.em,title,(text||pushBody)+'\n\n'+SITE,html).catch(e=>console.error('mail',uid,e)));
  await Promise.all(jobs);
}

// ① カードが届いたとき（+1の風船は数が多いので通知しない。中身は誕生日当日まで秘密）
//    アカウントの引っ越しで移ってきたカード（mig印つき）も通知しない
const OPT={region:'asia-southeast1',instance:'happybithday-card-default-rtdb',secrets:[SMTP_USER,SMTP_PASS]};
const onCard=ref=>onValueCreated({...OPT,ref},async ev=>{
  const c=ev.data.val();if(!c||c.bg==='bal'||c.mig)return;
  await notify(ev.params.to,'🎈 カードが届きました',`${c.fromNm||'友だち'}さんからカードが届きました。中身は誕生日の当日に読めます。`);
});
exports.onWallCard=onCard('/wall/{to}/{id}');
exports.onPrivCard=onCard('/private/{to}/{id}');

// ② 毎朝8時(日本時間)：自分の誕生日（メッセージ内容つき）＋ 友だちの誕生日
exports.birthdayDaily=onSchedule({schedule:'0 8 * * *',timeZone:'Asia/Tokyo',region:'asia-northeast1',secrets:[SMTP_USER,SMTP_PASS],timeoutSeconds:300},async()=>{
  const j=new Date(Date.now()+9*3600e3),Y=j.getUTCFullYear(),M=j.getUTCMonth()+1,D=j.getUTCDate();
  const leap=new Date(Date.UTC(Y,1,29)).getUTCMonth()===1;
  const profs=(await db().ref('profiles').get()).val()||{};
  for(const [uid,p] of Object.entries(profs)){
    if(!((p.m===M&&p.d===D)||(!leap&&p.m===2&&p.d===29&&M===3&&D===1)))continue;
    const [w,pr]=await Promise.all([db().ref('wall/'+uid).get(),db().ref('private/'+uid).get()]);
    const cards=[...Object.entries(w.val()||{}).map(([id,c])=>({...c,id,k:'body'})),...Object.entries(pr.val()||{}).map(([id,c])=>({...c,id,k:'privbody',priv:true}))].filter(c=>c.y===Y);
    const msgs=[];
    for(const c of cards){
      if(c.bg==='bal')continue;
      const t=(await db().ref(`${c.k}/${uid}/${c.id}`).get()).val();
      if(t&&t.t)msgs.push({from:c.fromNm||'友だち',t:t.t,priv:!!c.priv});
    }
    const head=`${p.nm}さん、お誕生日おめでとう！🎉\n風船 ${cards.length}個 ／ メッセージ ${msgs.length}件`;
    const text=head+'\n\n'+msgs.map(m=>`■ ${m.from}さん${m.priv?'（非公開）':''}\n${m.t}`).join('\n\n');
    const html=`<p>${esc(head).replace(/\n/g,'<br>')}</p>`+msgs.map(m=>`<div style="margin:12px 0;padding:12px;border:1px solid #d3eadb;border-radius:10px"><b>${esc(m.from)}さん${m.priv?'（非公開）':''}</b><br>${esc(m.t).replace(/\n/g,'<br>')}</div>`).join('');
    await notify(uid,'🎉 お誕生日おめでとう！',`${msgs.length}件のメッセージが届いています。`,text,html);
    for(const f of Object.keys((await db().ref('friends/'+uid).get()).val()||{}))
      await notify(f,`🎂 今日は${p.nm}さんの誕生日`,`${p.nm}さんの誕生日です。お祝いのカードを送ろう！`);
  }
});

// ③ メール通知を「保存」したとき、オンなら確認メールを送る（同じ内容で保存し直しても送る）
//    アプリは保存のたびに ts（保存時刻）を書くので、同じアドレスでも保存を検知できる
//    連打防止：同じアドレスへは1分に1通まで。記録は mailLog/{uid}（クライアントからは読み書き不可）
exports.onNotifySaved=onValueWritten({...OPT,ref:'/notify/{uid}'},async ev=>{
  const b=ev.data.before.val(),a=ev.data.after.val();
  if(!a||!a.on||!a.em)return;
  if(b&&b.on&&b.em===a.em&&b.ts===a.ts)return;
  const uid=ev.params.uid,log=db().ref('mailLog/'+uid),old=(await log.get()).val();
  if(old&&old.em===a.em&&Date.now()-old.ts<60e3)return;
  await log.set({em:a.em,ts:Date.now()});
  const text=`メール通知の登録ありがとう！\n\nこのアドレスに、次のときにお知らせします。\n・カードが届いたとき\n・自分や友だちの誕生日の朝\n\nメールが不要になったら、アプリの「詳細設定」で「メールで通知する」のチェックを外して保存してください。\n\n心当たりがない場合は、このメールは無視してください。`;
  const html=`<p>メール通知の登録ありがとう！🎈</p><p>このアドレスに、次のときにお知らせします。</p><ul><li>カードが届いたとき</li><li>自分や友だちの誕生日の朝</li></ul><p>メールが不要になったら、アプリの「詳細設定」で「メールで通知する」のチェックを外して保存してください。</p><p style="color:#888;font-size:12px">心当たりがない場合は、このメールは無視してください。</p><p><a href="${SITE}">${SITE}</a></p>`;
  try{await mail(a.em,'【おたんじょうびカード】メール通知を登録しました',text+'\n\n'+SITE,html)}
  catch(e){console.error('confirm mail',uid,e)}
});
