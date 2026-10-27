import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LynxMarketData, LIVE_POLICY } from '../../market-data/dist/index.js';
import { PaperQuoteBook } from '../dist/index.js';
const dir = resolve(process.argv[2] ?? 'artifacts/verification/n2/live-capture');
const records = readFileSync(resolve(dir, 'responses.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const events = records.filter(r => r.name === 'pair-1' || r.name === 'pair-2').sort((a,b)=>a.receivedAtMs-b.receivedAtMs);
const initial = new Map([1,2].map(pair=>[pair,events.find(r=>r.name===`pair-${pair}`&&r.status===200)]));
let mono=0, current=new Map(initial);
const headers = row => ({ 'x-maya-upstream-date':row.headers.date,'x-maya-upstream-rtt-ms':String(row.rttMs),'x-maya-upstream-age-ms':'0' });
const feed = new LynxMarketData({ monotonic:()=>mono, fetchImpl:async url=>{
  if(String(url).endsWith('/config')) return new Response(readFileSync(resolve(dir,'config.json'),'utf8'));
  if(String(url).endsWith('/table')) return new Response(readFileSync(resolve(dir,'table.json'),'utf8'));
  const row=current.get(Number(String(url).split('/').at(-1)));
  if(row.status!==200)throw new Error(row.error??`HTTP ${row.status}`);
  return new Response(row.body,{headers:headers(row)});
}});
await feed.start();feed.stop();await Promise.all(['btc-usd','eth-usd'].map(m=>feed.pollMarket(m)));
const book=new PaperQuoteBook({table:feed.getTable(),tableId:feed.getTableId(),getConfig:()=>feed.getConfig(),policyId:LIVE_POLICY.policyId,quoteTtlMs:LIVE_POLICY.quoteTtlMs});
const count = ()=>({instants:0,healthy:0,useful:0,oneOrMore:0,eligible:[],reasons:{},noQuoteBurstMs:0,longestNoQuoteBurstMs:0,healthyZeroBurstMs:0,longestHealthyZeroBurstMs:0,quoteCpuMs:[],maxQuoteCpuMs:0});
const stats={'btc-usd':count(),'eth-usd':count()};
const start=Math.max(...[...initial.values()].map(r=>r.receivedAtMs));
const end=events.at(-1).receivedAtMs;
let cursor=0;
const began=performance.now();
for(let now=start;now<=end;now+=100){
  while(cursor<events.length&&events[cursor].receivedAtMs<=now){
    const event=events[cursor++]; mono=event.receivedAtMs-start; const pair=Number(event.name.at(-1)); current.set(pair,event); await feed.pollMarket(pair===1?'btc-usd':'eth-usd');
  }
  mono=now-start;
  for(const market of ['btc-usd','eth-usd']){
    const s=stats[market],clock=feed.getClock(),health=feed.getHealth(market),samples=feed.getSamples(market);
    book.updateMarket(market,samples,health,clock);
    s.instants++; const healthy=health.status==='ready';if(healthy)s.healthy++;
    const cells=book.candidates(market,clock),windows=new Set();let eligible=0;const t=performance.now();
    for(const cell of cells){const q=book.quoteCell(cell,clock);if(q.available){eligible++;windows.add(cell.startMs);}else s.reasons[q.reason]=(s.reasons[q.reason]??0)+1;}
    const elapsed=performance.now()-t;s.quoteCpuMs.push(elapsed);s.maxQuoteCpuMs=Math.max(s.maxQuoteCpuMs,elapsed);
    if(healthy){s.eligible.push(eligible);if(eligible>=3&&windows.size>=2)s.useful++;if(eligible>0)s.oneOrMore++;}
    s.noQuoteBurstMs=eligible===0?s.noQuoteBurstMs+100:0;s.longestNoQuoteBurstMs=Math.max(s.longestNoQuoteBurstMs,s.noQuoteBurstMs);
    s.healthyZeroBurstMs=healthy&&eligible===0?s.healthyZeroBurstMs+100:0;s.longestHealthyZeroBurstMs=Math.max(s.longestHealthyZeroBurstMs,s.healthyZeroBurstMs);
  }
}
const percentile=(a,f)=>[...a].sort((a,b)=>a-b)[Math.min(a.length-1,Math.floor(a.length*f))]??null;
const markets={};for(const [market,s]of Object.entries(stats))markets[market]={instants:s.instants,healthy:s.healthy,healthyShare:s.healthy/s.instants,modelCandidateUseful:s.useful,modelCandidateCoverage:s.useful/s.healthy,oneOrMoreCandidates:s.oneOrMore,oneOrMoreShareHealthy:s.oneOrMore/s.healthy,oneOrMoreShareAll:s.oneOrMore/s.instants,medianEligible:percentile(s.eligible,.5),minimumEligible:Math.min(...s.eligible),longestZeroQuoteBurstMs:s.longestNoQuoteBurstMs,longestHealthyZeroQuoteBurstMs:s.longestHealthyZeroBurstMs,unavailableReasons:s.reasons,canonical42QuoteBatchCpuMs:{p50:percentile(s.quoteCpuMs,.5),p95:percentile(s.quoteCpuMs,.95),p99:percentile(s.quoteCpuMs,.99),max:s.maxQuoteCpuMs}};
const report={generatedAt:new Date().toISOString(),modelId:'maya-gaussian-discrete-five-v1',policy:LIVE_POLICY,method:'Replay original received successes AND transport failures at 100ms evaluation using production source clock, source parser, three-second stabilization, health, quote registry, TTL and domain/model. No synthetic prices. Mock transport adds zero browser/relay overhead; CPU is Node on this development machine, not mobile browser performance.',captureStartMs:start,captureEndMs:end,elapsedCpuMs:performance.now()-began,denominators:'ModelCandidateCoverage >=3 quotes across >=2 windows / healthy instants; one-or-more candidate is NOT ViewportPlayableCoverage. All captured failures enter health state and all-instants metric.',markets};
writeFileSync(resolve(dir,'analysis-sampled-production-replay.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
