(async()=>{
  const read=()=>window.__mayaReadOnly.snapshot();
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const controls=[];const attempts=[];const before=read();
  const action=name=>document.querySelector(`[data-action="${name}"]`).click();
  action('max');controls.push(['max',document.querySelector('.stake-value b').textContent]);
  action('min');controls.push(['min',document.querySelector('.stake-value b').textContent]);
  for(let i=0;i<20;i++)action('zoom-in');controls.push(['zoom-max',document.querySelector('.zoom-readout').textContent]);
  for(let i=0;i<20;i++)action('zoom-out');controls.push(['zoom-min',document.querySelector('.zoom-readout').textContent]);
  action('live');
  const deadline=performance.now()+45000;
  let pair='';
  while(read().allowance.acceptedCount<10&&performance.now()<deadline){
    const count=read().allowance.acceptedCount;
    const nextPair=count<5?'btc-usd':'eth-usd';
    if(pair!==nextPair){pair=nextPair;const select=document.querySelector('select');select.value=pair;select.dispatchEvent(new Event('change',{bubbles:true}));await sleep(300);}
    action('min');for(let j=0;j<count%5;j++)action('raise');
    const cells=[...document.querySelectorAll('.offer:not([hidden]):not(:disabled)')];
    cells.sort((a,b)=>Number(a.dataset.cellId.split(':')[2])-Number(b.dataset.cellId.split(':')[2]) || parseFloat(a.getAttribute('aria-label').match(/([\d.]+) times/)[1])-parseFloat(b.getAttribute('aria-label').match(/([\d.]+) times/)[1]));
    const cell=cells[0];
    if(!cell){await sleep(250);continue;}
    const label=cell.getAttribute('aria-label');cell.click();await sleep(450);
    attempts.push({pair,label,countBefore:count,countAfter:read().allowance.acceptedCount});
  }
  await sleep(300);
  const after=read();const dialog=document.querySelector('[role=dialog]');
  const evidence={at:new Date().toISOString(),url:location.href,profile:document.querySelector('.maya').dataset.profile,inputMethod:'DOM button activation via UI handlers; native keyboard placement also checked separately',before,controls,attempts,after,dialog:dialog?{title:dialog.querySelector('h1').textContent,url:dialog.querySelector('a').href,count:document.querySelectorAll('[role=dialog]').length}:null};
  window.__journeyEvidence=evidence;
  return evidence;
})()
