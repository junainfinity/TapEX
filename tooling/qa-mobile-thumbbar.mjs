// Native Chromium touch input against the built app; diagnostics are read-only.
// node tooling/qa-mobile-thumbbar.mjs <owned-browser-CDP-url> <app-url> <round-name> [baseline-url]
import fs from 'node:fs/promises';
import path from 'node:path';
const [endpoint,url,round='round-1',baseline]=process.argv.slice(2);
if(!endpoint||!url||!/^[a-z0-9-]+$/.test(round))throw Error('Expected CDP URL, app URL and safe round name');
const out=path.resolve('artifacts/verification/mobile-thumbbar',round);await fs.mkdir(out,{recursive:true});
const ws=new WebSocket(endpoint);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
let serial=0,session;const pending=new Map(),checks=[],errors=[];
ws.onmessage=event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);};
const send=(method,params={},sid=session)=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,...(sid?{sessionId:sid}:{})}));});
const page=(await send('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&(t.url.startsWith(url)||/^http:\/\/127\.0\.0\.1:(4173|8080)\/$/.test(t.url)||t.url==='https://tapex.quantellics.com/'));
if(!page)throw Error('Owned QA page not found');
session=(await send('Target.attachToTarget',{targetId:page.targetId,flatten:true},null)).sessionId;
await send('Runtime.enable');await send('Page.enable');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const ev=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
const check=(name,pass,detail)=>{checks.push({name,pass,...(detail===undefined?{}:{detail})});if(!pass)throw Error('FAIL: '+name+' '+JSON.stringify(detail));};
const until=async(expression,timeout=30000)=>{const end=Date.now()+timeout;while(Date.now()<end){try{if(await ev(expression))return;}catch{}await pause(100);}throw Error('Timed out: '+expression);};
let touch=true,lastViewport={width:390,height:844,coarse:true};
const viewport=async(width,height,coarse=true)=>{touch=coarse;lastViewport={width,height,coarse};await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:coarse});await send('Emulation.setTouchEmulationEnabled',{enabled:coarse,maxTouchPoints:5});await pause(250);};
const navigate=async target=>{
 const previous=await ev('window.__mayaReadOnly?.snapshot().paperSession?.ledgerKey').catch(()=>null);
 await send('Page.navigate',{url:target});
 // Page.navigate acknowledges navigation before the old document is replaced.
 // Wait for the new ledger/document before installing probes or sending input.
 await until(`location.href===${JSON.stringify(new URL(target).href)}&&window.__mayaReadOnly?.snapshot().paper?.ready&&window.__mayaReadOnly.snapshot().paperSession.ledgerKey!==${JSON.stringify(previous??null)}`);
 await ev('document.fonts.ready.then(()=>true)');
 await send('Emulation.setTouchEmulationEnabled',{enabled:false});
 await viewport(lastViewport.width,lastViewport.height,lastViewport.coarse);
 await send('Page.bringToFront');await pause(200);
};
const ready=()=>until('document.querySelector(".status-line")?.dataset.state==="ready"&&document.querySelectorAll(".offer:not([hidden]):not(:disabled)").length>2',45000);
const rect=selector=>ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing element');const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}})()`);
const tap=async target=>{
 const p=typeof target==='string'?await rect(target):{...target,width:0,height:0};const x=p.x+p.width/2,y=p.y+p.height/2;
 if(touch){await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
 else for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:1});
 await pause(60);
};
const key=async key=>{for(const type of ['keyDown','keyUp'])await send('Input.dispatchKeyEvent',{type,key,code:key,windowsVirtualKeyCode:key==='Escape'?27:9});await pause(60);};
const snapshot=()=>ev('window.__mayaReadOnly.snapshot()');
const screen=async name=>fs.writeFile(path.join(out,name+'.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
const geometry=()=>ev(`(()=>{const r=s=>{const e=document.querySelector(s);if(!e?.getClientRects().length)return null;const b=e.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom}};return {phone:document.querySelector('.maya').dataset.phone,profile:document.querySelector('.maya').dataset.profile,scene:r('.scene'),header:r('.header'),pair:r('.pair-pill'),account:r('.phone-account'),footer:r('.bottom-bar'),thumb:r('.phone-thumb-bar'),nav:r('.navigation-row'),buttons:[...document.querySelectorAll('.phone-thumb-bar>button')].map(e=>{const b=e.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height}}),axes:[...document.querySelectorAll('.axis-time')].filter(e=>e.getClientRects().length).map(e=>({top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom})),overflow:document.documentElement.scrollWidth>innerWidth}})()`);
const menu=async mode=>{await tap('.phone-thumb-bar [data-action=phone-'+mode+']');await until('document.querySelector(".phone-controls-dialog").open');};
const close=async()=>{await key('Escape');await until('!document.querySelector(".phone-controls-dialog").open');};
const resetView=async()=>{await menu('menu');await tap('.phone-controls-dialog [data-action=live]');await ready();};
const pinch=async(startDistance,endDistance,{liftFirst=true,cancel=false}={})=>{
 const s=await rect('.scene');const cx=s.x+s.width*.53,cy=s.y+s.height*.52;
 const pts=d=>[{id:1,x:cx-d/2,y:cy},{id:2,x:cx+d/2,y:cy}];
 const before=await snapshot();
 await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:pts(startDistance)});
 for(let i=1;i<=12;i++){await send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:pts(startDistance+(endDistance-startDistance)*i/12)});await pause(16);}
 const active=await snapshot();
 if(cancel)await send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
 else {
   const remaining=pts(endDistance).filter(p=>p.id===(liftFirst?2:1));
   await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:remaining});
   remaining[0].y+=14;await send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:remaining});
   await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 }
 await pause(100);const after=await snapshot();
 check('pinch tracks both captured pointers',active.view.pinching&&active.view.activePointers===2,active.view);
 check('pinch release/cancel clears pointers',after.view.activePointers===0&&!after.view.pinching,after.view);
 check('pinch does not place a bet',before.allowance.acceptedCount===after.allowance.acceptedCount);
 check('pinch leaves browser scale at one',await ev('Math.abs(visualViewport.scale-1)<.001&&scrollX===0&&scrollY===0'));
 return {before,active,after};
};
const chooseFuture=async()=>{
 await ready();
 return ev(`(()=>{const s=window.__mayaReadOnly.snapshot(),items=[...document.querySelectorAll('.offer:not([hidden]):not(:disabled)')].filter(e=>Number(e.dataset.cellId.split(':')[2])>s.clock.nowMs+12000).sort((a,b)=>Number(b.dataset.cellId.split(':')[2])-Number(a.dataset.cellId.split(':')[2])||Math.abs(a.getBoundingClientRect().y-innerHeight/2)-Math.abs(b.getBoundingClientRect().y-innerHeight/2));if(!items[0])return null;return items[0].dataset.cellId})()`);
};
const placeAccepted=async(cell,expected)=>{
 for(let attempt=0;attempt<3;attempt++){
   await until(`(()=>{const e=document.querySelector('.offer[data-cell-id="${cell}"]');return e&&!e.disabled&&!e.hidden})()`);
   const before=await snapshot(),toastCount=await ev('window.__thumbToasts.length');
   await tap(`.offer[data-cell-id="${cell}"]`);
   await until(`window.__mayaReadOnly.snapshot().allowance.acceptedCount>=${expected}||window.__thumbToasts.slice(${toastCount}).includes('That square changed. Try another.')`,4000);
   const after=await snapshot();
   if(after.allowance.acceptedCount===expected)return;
   const messages=await ev(`window.__thumbToasts.slice(${toastCount})`);
   check('changed live quote rejected without adding a bet',after.allowance.acceptedCount===before.allowance.acceptedCount&&after.paper.positions.length===before.paper.positions.length&&messages.some(m=>m==='That square changed. Try another.'),messages);
   // Only a confirmed rejection can be retried. Never retry an ambiguous acceptance.
   await pause(250);
 }
 throw Error('Live quote changed on three consecutive attempts');
};
let failure;
try {
 if(baseline){
   const profiles=[[1440,900,false],[768,1024,true],[1024,768,true],[844,390,false]];
   for(const [w,h,coarse]of profiles){
     await viewport(w,h,coarse);await navigate(baseline);await ready();const before=await geometry();
     await navigate(url);await ready();const after=await geometry();
     for(const part of ['scene','header','footer','nav'])check(`unchanged ${w}x${h} ${part}`,Object.keys(before[part]).every(k=>Math.abs(before[part][k]-after[part][k])<.15),{before:before[part],after:after[part]});
     check(`no phone controls at ${w}x${h}`,after.phone==='false'&&after.thumb===null);
   }
 }
 await viewport(390,844);await navigate(url);await ready();
 await ev(`(()=>{window.__thumbInputLog=[];for(const name of ['pointerdown','pointerup','pointercancel','lostpointercapture'])document.addEventListener(name,e=>{window.__thumbInputLog.push({name,at:performance.now(),target:e.target.className,pointerId:e.pointerId,disabled:e.target.disabled,x:e.clientX,y:e.clientY,view:window.__mayaReadOnly.view()});if(window.__thumbInputLog.length>100)window.__thumbInputLog.shift();},true);})()`);
 for(const [w,h]of [[320,568],[360,640],[390,844],[430,932],[844,390],[932,430]]){
   await viewport(w,h);const g=await geometry();
   check(`${w}x${h} phone composition`,g.phone==='true'&&g.footer===null&&g.nav===null,g);
   check(`${w}x${h} single 58px thumb row`,Math.abs(g.thumb.height-58)<.1&&g.buttons.length===5&&g.buttons.every(b=>b.w>=44&&b.h>=44&&Math.abs(b.y-g.buttons[0].y)<1),g.buttons);
   check(`${w}x${h} full chart space`,g.scene.height>h-185&&g.scene.bottom<g.thumb.y&&g.scene.y>=g.header.bottom,g);
   check(`${w}x${h} header and axes fit`,!g.overflow&&g.pair.right<=g.account.x&&g.account.right<=w&&g.axes.every(a=>a.bottom<g.thumb.y),g);
   await menu('menu');const dialog=await rect('.phone-controls-dialog');
   check(`${w}x${h} menu stays inside viewport`,dialog.x>=0&&dialog.y>=0&&dialog.right<=w&&dialog.bottom<=h,dialog);
   check(`${w}x${h} menu does not resize chart`,Math.abs((await rect('.scene')).height-g.scene.height)<.1);
   check(`${w}x${h} menu takes focus and blocks offers`,await ev('document.querySelector(".phone-controls-dialog").contains(document.activeElement)&&document.querySelectorAll(".offer:not([hidden]):not(:disabled)").length===0'));
   if(w>h){
     const x=dialog.x+dialog.width/2,y=dialog.bottom-35;
     await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x,y}]});
     for(let i=1;i<=14;i++){await send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:1,x,y:y-i*14}]});await pause(16);}
     await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await pause(150);
     const scroll=await ev('(()=>{const d=document.querySelector(".phone-controls-dialog"),b=d.querySelector("[data-action=wallet]").getBoundingClientRect(),r=d.getBoundingClientRect();return {top:d.scrollTop,height:d.scrollHeight,client:d.clientHeight,walletTop:b.top,walletBottom:b.bottom,topEdge:r.top,bottomEdge:r.bottom}})()');
     check(`${w}x${h} lower menu actions reachable by touch scroll`,scroll.top>0&&scroll.walletTop>=scroll.topEdge&&scroll.walletBottom<=scroll.bottomEdge,scroll);
   }
   await screen(`${w}x${h}-menu`);await close();await screen(`${w}x${h}`);
 }
 await viewport(844,390);await resetView();
 const landscapePinch=await pinch(90,140);check('landscape pinch increases chart zoom',landscapePinch.after.view.zoom>landscapePinch.before.view.zoom);
 await viewport(390,844);await resetView();
 const beforeGesture=(await snapshot()).allowance.acceptedCount;
 const spread=await pinch(64,220);check('spread zooms smoothly to upper bound',spread.after.view.zoom===.9,spread.after.view.zoom);
 const shrink=await pinch(220,50,{liftFirst:false});check('pinch zooms smoothly to lower bound',shrink.after.view.zoom===.345,shrink.after.view.zoom);
 const middle=await pinch(80,120);check('pinch allows intermediate zoom',Math.abs(middle.after.view.zoom-.5175)<.00001,middle.after.view.zoom);
 await pinch(80,100,{cancel:true});
 check('all pinch sequences accept zero bets',(await snapshot()).allowance.acceptedCount===beforeGesture);
 await menu('zoom');
 for(let i=0;i<16;i++)await tap('.phone-controls-dialog [data-action=zoom-out]');
 check('zoom-out button clamps at minimum',(await snapshot()).view.zoom===.345);
 for(let i=0;i<16;i++)await tap('.phone-controls-dialog [data-action=zoom-in]');
 check('zoom-in button clamps at maximum',(await snapshot()).view.zoom===.9);
 await close();await resetView();
 await menu('stake');
 for(const [i,cents]of ['10','50','100','500','1000'].entries()){
   await tap(`.phone-controls-dialog [data-stake-index="${i}"]`);
   check('exact selected stake '+cents,(await snapshot()).view.stakeCents===cents);
 }
 await tap('.phone-controls-dialog [data-action=min]');check('MIN selects ten cents',(await snapshot()).view.stakeCents==='10');
 await tap('.phone-controls-dialog [data-action=max]');check('MAX selects ten dollars',(await snapshot()).view.stakeCents==='1000');
 await close();await tap('.phone-thumb-bar [data-action=lower]');check('thumb minus selects five dollars',(await snapshot()).view.stakeCents==='500');
 await tap('.phone-thumb-bar [data-action=raise]');check('thumb plus selects ten dollars',(await snapshot()).view.stakeCents==='1000');
 await tap('.phone-thumb-bar [data-action=lower]');
 const cell=await chooseFuture();check('future square available for repeat bet',!!cell);
 await ev(`(()=>{window.__thumbInputLog=[];window.__thumbToasts=[];new MutationObserver(records=>{for(const r of records)for(const n of r.addedNodes)if(n.nodeType===1)window.__thumbToasts.push(n.textContent);}).observe(document.querySelector('.toast-stack'),{childList:true});for(const name of ['pointerdown','pointerup','pointercancel','lostpointercapture'])document.querySelector('.scene').addEventListener(name,e=>{window.__thumbInputLog.push({name,at:performance.now(),target:e.target.className,disabled:e.target.disabled,id:e.target.dataset?.cellId,x:e.clientX,y:e.clientY,view:window.__mayaReadOnly.view()});if(window.__thumbInputLog.length>30)window.__thumbInputLog.shift();},true);})()`);
 for(let i=1;i<=4;i++){
   await placeAccepted(cell,i);
   const s=await snapshot(),legs=s.paper.positions.filter(p=>p.cellId===cell);
   check('tap '+i+' adds exactly chosen five dollars',legs.length===i&&legs.every(p=>p.stakeCents==='500')&&legs.reduce((sum,p)=>sum+Number(p.stakeCents),0)===i*500,legs.map(p=>({stake:p.stakeCents,status:p.status})));
   check('tap '+i+' visible aggregate',s.view.cardPhases.some(p=>p.count===i&&Number(p.stakeCents)===i*500),s.view.cardPhases);
 }
 await screen('four-five-dollar-legs');
 await viewport(844,390);check('rotation retains all four accepted stakes',(await snapshot()).allowance.acceptedCount===4&&(await snapshot()).paper.positions.every(p=>p.stakeCents==='500'));await viewport(390,844);
 await menu('menu');await tap('.phone-controls-dialog [data-action=wallet]');await until('document.querySelector(".wallet-dialog").open');
 check('wallet dialog retains consultant link',await ev('document.querySelector(".wallet-contact").href==="https://quantellics.com/"'));
 await key('Escape');check('wallet restores visible mobile focus',await ev('document.activeElement===document.querySelector(".phone-thumb-bar [data-action=phone-menu]")'));
 await menu('stake');await tap('.phone-controls-dialog [data-stake-index="2"]');await close();
 for(let i=5;i<=10;i++){
   const id=await chooseFuture();check('available square for play '+i,!!id);await placeAccepted(id,i);
 }
 await until('!!document.querySelector(".consultation")');
 check('consultation after tenth accepted bet',(await snapshot()).allowance.acceptedCount===10);
 check('consultation fits viewport',await ev('(()=>{const r=document.querySelector(".consultation").getBoundingClientRect();return r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()'));
 await screen('ten-play-consultation');await tap('.results-button');await until('!document.querySelector(".consultation")');
 check('history capped at five visible rows',await ev('document.querySelectorAll(".result-row").length<=5'));
 const beforeReload=await snapshot();await send('Page.reload');await until('window.__mayaReadOnly?.snapshot().paper?.ready');
 const fresh=await snapshot();check('refresh restores $1000 and ten plays',fresh.paper.balanceCents==='100000'&&fresh.allowance.acceptedCount===0&&fresh.paper.positions.length===0&&fresh.paperSession.ledgerKey!==beforeReload.paperSession.ledgerKey);
 await ready();
 await ev('(()=>{const s=document.querySelector("select");s.value="eth-usd";s.dispatchEvent(new Event("change",{bubbles:true}));})()');await ready();
 check('ETH supported with mobile controls',(await snapshot()).marketId==='eth-usd'&&(await snapshot()).view.phoneControls);
 await pinch(90,130);await screen('eth-after-pinch');
 await resetView();
 await ev(`(()=>{window.__thumbToasts=[];new MutationObserver(records=>{for(const r of records)for(const n of r.addedNodes)if(n.nodeType===1)window.__thumbToasts.push(n.textContent);}).observe(document.querySelector('.toast-stack'),{childList:true});})()`);
 const ethCell=await chooseFuture();check('ETH has a playable future square',!!ethCell);await placeAccepted(ethCell,1);
 check('ETH accepts exactly the selected paper stake',(await snapshot()).paper.positions.some(p=>p.marketId==='eth-usd'&&p.stakeCents==='100'));
 await ev('document.querySelector(".maya").style.setProperty("--maya-safe-top","24px");document.querySelector(".maya").style.setProperty("--maya-safe-bottom","34px")');await viewport(430,932);const inset=await geometry();
 check('safe areas retained',inset.header.y>=24&&inset.thumb.bottom<=932-34&&inset.scene.bottom<inset.thumb.y,inset);
 await ev('document.querySelector(".maya").style.removeProperty("--maya-safe-top");document.querySelector(".maya").style.removeProperty("--maya-safe-bottom")');
 await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await menu('menu');
 check('reduced motion removes panel animation',await ev('getComputedStyle(document.querySelector(".phone-controls-dialog")).animationName==="none"'));await close();
 check('no uncaught browser exceptions',errors.length===0,errors);
}catch(error){failure=String(error);await screen('failure').catch(()=>{});await fs.writeFile(path.join(out,'input-failure.json'),JSON.stringify(await ev('({events:window.__thumbInputLog,toasts:[...document.querySelectorAll(".toast")].map(e=>e.textContent)})').catch(()=>null),null,2));console.error(failure);}
finally{
 const report={at:new Date().toISOString(),url,baseline,round,checks,errors,failure,passed:!failure,final:await snapshot().catch(()=>null)};
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({round,passed:!failure,checks:checks.length,failure}));ws.close();
 if(failure)process.exitCode=1;
}
