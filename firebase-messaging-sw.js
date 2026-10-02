const ICON='icon-192.png';
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('push',e=>{
  let p={};
  try{p=e.data?e.data.json():{}}catch(_){try{p={data:{body:e.data.text()}}}catch(__){}}
  const d={...(p.notification||{}),...(p.data||{})};
  // 端末によっては通知を必ず表示しないと購読が失効するため、中身が空でも表示する
  e.waitUntil(self.registration.showNotification(d.title||'おたんじょうびカード',{
    body:d.body||'',icon:ICON,badge:ICON,tag:d.tag||undefined,data:{url:d.url||'./'}
  }));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const url=new URL((e.notification.data&&e.notification.data.url)||'./',self.registration.scope).href;
  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    for(const c of list){if('focus' in c)return c.focus()}
    return clients.openWindow(url);
  }));
});
