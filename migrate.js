// 使い方：functions/index.js の末尾に
//   Object.assign(exports, require('./migrate'));
// を1行足す（notify.js と同じ）。新しいnpmパッケージは要りません。
//
// アカウントの引っ越し：
//   ① 旧アカウントで「引っ越しコード」を作る（10分間・1回だけ有効）
//   ② 新アカウントでコードを入れると、旧アカウントのプロフィール・友だち・カードが新アカウントへ移る
// LINE・Google・名前だけ（匿名）のどの組み合わせでも使えます。
// データの書き換えは1回の更新にまとめているので、「全部成功」か「全部失敗」のどちらかです。
//
// 復元コード（名前だけで始めた人用）：
//   ログアウトしたり端末のデータを消したりしても、コードを入れれば同じアカウントに戻れます。
//   makeRecoveryCode … ログイン中の人がコードを作る（作り直すと前のコードは無効）
//   recoverLogin     … ログインしていない状態でコードを入れると、同じアカウントに入れるトークンを返す
//   保存するのはコードのハッシュだけ（recovery / recoveryOwner はクライアントから読み書きできません）
const {onCall,HttpsError}=require('firebase-functions/v2/https');
const admin=require('firebase-admin');
const crypto=require('crypto');
if(!admin.apps.length)admin.initializeApp();

const db=()=>admin.database();
const OPT={region:'asia-northeast1',cors:true,timeoutSeconds:300};
const AL='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい 0 O 1 I は使わない（32文字）
const TTL=10*60e3;
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const norm=s=>String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
const read=async p=>(await db().ref(p).get()).val()||{};
const need=req=>{if(!req.auth)throw new HttpsError('unauthenticated','ログインしてからやり直してね。');return req.auth.uid};

// ① コードを作る（保存するのはハッシュだけ。transfer / transferOwner はクライアントから読み書きできない）
exports.makeTransferCode=onCall(OPT,async req=>{
  const uid=need(req);
  if(!(await db().ref('profiles/'+uid).get()).exists())throw new HttpsError('failed-precondition','先にプロフィールを登録してね。');
  const own=db().ref('transferOwner/'+uid),old=(await own.get()).val();
  if(old)await db().ref('transfer/'+old).remove();
  const code=Array.from({length:10},()=>AL[crypto.randomInt(AL.length)]).join(''),key=sha(code);
  await db().ref('transfer/'+key).set({uid,exp:Date.now()+TTL});
  await own.set(key);
  return {code:code.slice(0,5)+'-'+code.slice(5)};
});

// コードの当てずっぽう対策：間違いが1時間に8回続いたら止める
const tooMany=async uid=>{const v=(await db().ref('transferTry/'+uid).get()).val();return !!v&&Date.now()-v.ts<3600e3&&v.n>=8};
const miss=uid=>db().ref('transferTry/'+uid).transaction(v=>{const t=Date.now();return(!v||t-v.ts>=3600e3)?{n:1,ts:t}:{n:v.n+1,ts:v.ts}});

// ② コードを入れて引き継ぐ（呼んだ人＝引っ越し先）
exports.claimTransfer=onCall(OPT,async req=>{
  const to=need(req),code=norm(req.data&&req.data.code);
  if(code.length!==10)throw new HttpsError('invalid-argument','コードは10文字です。');
  if(await tooMany(to))throw new HttpsError('resource-exhausted','間違いが続いたため、しばらく使えません。1時間後にもう一度試してね。');
  const er=db().ref('transfer/'+sha(code));
  let ent=null;
  const r=await er.transaction(v=>{
    ent=v;
    if(!v||v.uid===to)return v;                              // 無い／自分のコード → そのまま
    if(v.claimedBy&&v.claimedBy!==to)return;                 // 他の人が使用中 → 中断
    if(!v.claimedBy&&v.exp<Date.now())return;               // 期限切れ → 中断
    return {...v,claimedBy:to};                              // 使用済みにする（途中で失敗しても同じコードでやり直せる）
  });
  if(ent&&ent.uid===to)throw new HttpsError('failed-precondition','これはいま使っているアカウントのコードです。引っ越し先で、別のログイン方法でログインしてから入れてね。');
  const s=r.snapshot.val();
  if(!r.committed||!s||s.claimedBy!==to){await miss(to);throw new HttpsError('not-found','コードが違うか、期限切れです。もう一度コードを作ってね。')}
  let res;
  try{res=await moveAccount(s.uid,to)}
  catch(e){
    if(e instanceof HttpsError)throw e;
    console.error('moveAccount',s.uid,to,e);
    throw new HttpsError('internal','引き継ぎの途中で失敗しました。同じコードでもう一度試してね。');
  }
  await Promise.all([er.remove(),db().ref('transferOwner/'+s.uid).remove()]);
  return res;
});

// ---- 復元コード ----
const RAL=AL; // 16文字×32種類＝80ビット。当てずっぽうは現実的に不可能
exports.makeRecoveryCode=onCall(OPT,async req=>{
  const uid=need(req),tk=req.auth.token||{};
  const anon=(tk.firebase&&tk.firebase.sign_in_provider)==='anonymous';
  if(!anon&&tk.rec!==true)throw new HttpsError('failed-precondition','復元コードは、名前だけで始めたアカウント用です。GoogleやLINEの人は、同じログイン方法でログインし直してね。');
  if(!(await db().ref('profiles/'+uid).get()).exists())throw new HttpsError('failed-precondition','先にプロフィールを登録してね。');
  const code=Array.from({length:16},()=>RAL[crypto.randomInt(RAL.length)]).join(''),key=sha(code);
  const old=(await db().ref('recoveryOwner/'+uid).get()).val(),u={};
  if(old)u['recovery/'+old]=null;
  u['recovery/'+key]={uid};u['recoveryOwner/'+uid]=key;
  await db().ref().update(u);
  return {code:code.match(/.{4}/g).join('-')};
});
exports.recoverLogin=onCall(OPT,async req=>{
  const code=norm(req.data&&req.data.code);
  if(code.length!==16)throw new HttpsError('invalid-argument','コードは16文字です。');
  const uid=(await db().ref('recovery/'+sha(code)+'/uid').get()).val();
  if(!uid)throw new HttpsError('not-found','コードが違います。もう一度見てね。');
  // rec:true を付けておくと、アプリ側が「名前だけのアカウント」と分かる
  return {token:await admin.auth().createCustomToken(uid,{rec:true})};
});

// A（引っ越し元）→ B（引っ越し先）
async function moveAccount(A,B){
  const D=db();
  const [prof,fr,wall,priv,body,pbody,profiles,nA,nB]=await Promise.all(
    ['profiles/'+A,'friends/'+A,'wall/'+A,'private/'+A,'body/'+A,'privbody/'+A,'profiles','notify/'+A,'notify/'+B].map(read));
  const rh=(await db().ref('recoveryOwner/'+A).get()).val();
  if(!prof.nm)throw new HttpsError('not-found','引っ越し元にデータがありません。');
  const u={};

  // プロフィールは引っ越し元のものにする
  u['profiles/'+B]={nm:prof.nm,m:prof.m,d:prof.d};
  u['profiles/'+A]=null;

  // 友だち：Bに付け替え（Bの既存の友だちはそのまま残る）
  for(const f of Object.keys(fr)){
    if(f===B)continue;
    u[`friends/${B}/${f}`]=true;u[`friends/${f}/${B}`]=true;u[`friends/${f}/${A}`]=null;
  }
  u[`friends/${B}/${A}`]=null;
  u['friends/'+A]=null;

  // 届いたカード：Bへ移す。mig印を付け、通知（push・メール）が出ないようにする（notify.js側で除外）
  const mv=(k,src,mark)=>{for(const [id,c] of Object.entries(src))u[`${k}/${B}/${id}`]=mark?{...c,mig:true}:c;u[`${k}/${A}`]=null};
  mv('wall',wall,true);mv('private',priv,true);mv('body',body);mv('privbody',pbody);

  // Aが友だちに送ったカード：送り主をBに書き換え（取り消しなどが引き続きできる）
  const others=Object.keys(profiles).filter(x=>x!==A&&x!==B);
  await Promise.all(others.flatMap(U=>['wall','private'].map(async k=>{
    const s=await D.ref(`${k}/${U}`).orderByChild('from').equalTo(A).get();
    s.forEach(ch=>{u[`${k}/${U}/${ch.key}/from`]=B});
  })));

  // Aの端末・通知設定などは片付ける（メール設定は、Bにまだ無いときだけ引き継ぐ）
  for(const p of ['tokens','mailLog','balloons'])u[`${p}/${A}`]=null;
  u['notify/'+A]=null;
  if(rh)u['recovery/'+rh]=null; // 引っ越し元の復元コードは使えなくする
  u['recoveryOwner/'+A]=null;
  if(nA.em&&!nB.em)u['notify/'+B]={em:nA.em,on:!!nA.on};

  await D.ref().update(u);
  return {ok:true,friends:Object.keys(fr).filter(f=>f!==B).length,cards:Object.keys(wall).length+Object.keys(priv).length};
}
