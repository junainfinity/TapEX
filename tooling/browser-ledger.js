(async()=>{
  const snapshot=window.__mayaReadOnly.snapshot();
  const request=indexedDB.open('maya-paper-v1');
  const db=await new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
  const get=db.transaction('paper','readonly').objectStore('paper').get(snapshot.paperSession?.ledgerKey??'ledger');
  const ledger=await new Promise((resolve,reject)=>{get.onsuccess=()=>resolve(get.result);get.onerror=()=>reject(get.error)});
  db.close();
  return {at:new Date().toISOString(),url:location.href,snapshot,ledger,dialogCount:document.querySelectorAll('[role=dialog]').length,visibleOffers:document.querySelectorAll('.offer:not([hidden]):not(:disabled)').length};
})()
