import { createCell, multiplyDecimalInteger, OBSERVED_PATH_POLICY } from '@maya/contracts';
import type { MarketId, PaperSnapshot } from '@maya/contracts';
import { DEMO_CONFIG, getMarket, MARKETS } from '@maya/config';
import { LynxMarketData, LIVE_POLICY } from '@maya/market-data';
import { PaperQuoteBook } from '@maya/pricing';
import { PaperEngine } from '@maya/engine';
import { MayaGame } from '@maya/game-ui';
import { ConsultationController } from './sales-flow/ConsultationController.js';
import { BackgroundPricing } from './background-pricing.js';

const source = new LynxMarketData({baseUrl:'/api',fetchImpl:(input,init)=>globalThis.fetch(input,init)});
// A document is one demo session. Refresh starts at $1,000 without deleting past audit records
// or letting old positions/tabs spend from the new session's balance.
const pageLoadId=crypto.randomUUID();
const ledgerKey=`session:${pageLoadId}`;
let book: PaperQuoteBook | undefined;
let backgroundPricing:BackgroundPricing|undefined;
let engine: PaperEngine | undefined;
let sales: ConsultationController | undefined;
let selected: MarketId = DEMO_CONFIG.initialMarketId;
let disposed = false;
let startupError = '';
let startInFlight = false;
const inspectMode=new URLSearchParams(location.search).has('inspect');
let inspectRevision=-1;
const auditView=inspectMode?document.createElement('pre'):undefined;
if(auditView){auditView.dataset.mayaAudit='true';auditView.style.cssText='position:fixed;inset:0;z-index:100;background:#190d18;color:#eee;overflow:auto;margin:0;padding:20px;font:12px monospace';auditView.textContent='Loading saved paper records';document.body.append(auditView);}
const ui = new MayaGame(document.querySelector('#app')!,{
  makeCell:(marketId,start,bucket)=>{const market=getMarket(marketId);return createCell(marketId,start,multiplyDecimalInteger(market.bandHeight,BigInt(bucket)),multiplyDecimalInteger(market.bandHeight,BigInt(bucket+1)),DEMO_CONFIG.ruleVersion);},
  quoteFor:cell=>{const result=book?.quoteCell(cell,source.getClock());return result?.available?result.quote:undefined;},
  onMarket:market=>{selected=market;refresh();},
  onBet:async(quote,stakeCents)=>{
    if(!engine)return;
    const result=await engine.placeBet({requestId:crypto.randomUUID(),pageLoadId:engine.getAllowance().pageLoadId,quoteId:quote.quoteId,revision:quote.revision,cellId:quote.cellId,stakeCents});
    if(result.status==='rejected'){
      const messages:Record<string,string>={ALLOWANCE_EXHAUSTED:'Refresh to play 10 more.',INSUFFICIENT_BALANCE:'Not enough paper balance. Add paper funds.',CELL_CAP_EXCEEDED:'That square has reached its $50 limit.',QUOTE_EXPIRED:'That square changed. Try another.',QUOTE_CHANGED:'That square changed. Try another.',TOO_LATE:'That square is too close. Try another.',INPUT_NOT_READY:'Waiting for fresh price data.',STATE_NOT_READY:'Your paper balance is reconnecting.',STORAGE_UNAVAILABLE:'Paper storage is unavailable. Your bets have not been reset.'};
      ui.toast(messages[result.reason]??'That square is unavailable. Try another.');
    }
    refresh();
  },
  onRefill:async()=>{if(engine){await engine.refill(crypto.randomUUID());refresh();ui.toast(engine.getSnapshot().ready?'$1,000 in paper funds added.':'Paper funds could not be added. Check browser storage.');}},
  onReload:()=>location.reload()
});

function refresh(){
  if(disposed)return;
  const clock=source.getClock();
  for(const market of MARKETS)book?.updateMarket(market.id,(engine?.getGameSamples(market.id)??[]),source.getHealth(market.id),clock);
  const health=source.getHealth(selected);
  const paper:PaperSnapshot=engine?.getSnapshot()??{revision:0,balanceCents:DEMO_CONFIG.startingBalanceCents,positions:[],ready:false};
  const allowance=engine?.getAllowance();
  const samples=engine?.getGameSamples(selected)??[];
  const latest=samples.at(-1);
  const age=latest&&clock.ready?Math.max(0,(clock.nowMs-latest.sourceTimeMs)/1000):0;
  const ready=!!book&&!!backgroundPricing?.ready&&paper.ready&&health.status==='ready'&&clock.ready&&samples.length>=30;
  const message=startupError||paper.error||(backgroundPricing?.failed?'Paper odds are unavailable. Refresh to reconnect.':ready?`Live prices · ${Math.round(age)}s game path · Paper odds`:(health.reason??'Connecting to live prices'));
  ui.update({marketId:selected,pathMode:'linear',samples,positions:paper.positions,balanceCents:paper.balanceCents,acceptedCount:allowance?.acceptedCount??0,health:health.status,healthMessage:message,ready,nowMs:clock.nowMs,maxHealthySourceAgeS:LIVE_POLICY.maxHealthySourceAgeS,leadTimeS:book?source.getMinLeadMs()/1000:3});
  if(auditView&&engine&&inspectRevision!==paper.revision){inspectRevision=paper.revision;auditView.textContent=JSON.stringify(engine.getAuditSnapshot());}
  source.retainWindows(paper.positions.filter(p=>p.status==='open'));

}
async function start(){
  if(startInFlight||disposed||engine)return;startInFlight=true;
  try{
    await source.start();
    backgroundPricing=new BackgroundPricing(source.getTable());
    book=new PaperQuoteBook({table:source.getTable(),tableId:source.getTableId(),getConfig:()=>source.getConfig(),policyId:OBSERVED_PATH_POLICY.policyId,quoteTtlMs:LIVE_POLICY.quoteTtlMs,preview:backgroundPricing.preview});
    refresh();
    engine=new PaperEngine({pageLoadId,ledgerKey,broadcast:false,clock:source,quotes:book,marketData:source,observedSamples:()=>MARKETS.flatMap(m=>[...source.getDisplaySamples(m.id)]),settlementPolicy:OBSERVED_PATH_POLICY,minLeadMs:()=>source.getMinLeadMs()});
    await engine.initialize();
    engine.subscribe(refresh);sales=new ConsultationController(engine,ui);
    await engine.tick();startupError='';refresh();
  }catch(error){startupError='Live market inputs are reconnecting. No bets can be placed yet.';console.error('Maya startup failed',error);refresh();}
  finally{startInFlight=false;}
}
source.subscribe(refresh);
refresh();void start();
const tick=setInterval(()=>{if(engine)void engine.tick();else void start();},1000);
const paint=setInterval(refresh,250);
window.addEventListener('pageshow',()=>{ui.cancelGesture();void source.revalidate();if(engine)void engine.tick();refresh();});
window.addEventListener('pagehide',event=>{ui.cancelGesture();if(event.persisted)return;disposed=true;clearInterval(tick);clearInterval(paint);sales?.dispose();engine?.dispose();backgroundPricing?.dispose();source.stop();ui.dispose();});
// Diagnostic reads only; no test placement, money mutation or fixture entry is exposed.
Object.defineProperty(window,'__mayaReadOnly',{value:Object.freeze({view:()=>ui.diagnostics(),snapshot:()=>structuredClone({marketId:selected,paperSession:{ledgerKey,resetsOnReload:true},paper:engine?.getSnapshot(),allowance:engine?.getAllowance(),clock:source.getClock(),health:MARKETS.map(m=>source.getHealth(m.id)),feedPolicy:LIVE_POLICY,settlementPolicy:OBSERVED_PATH_POLICY,view:ui.diagnostics(),visibleQuotes:Number(ui.root.dataset.visibleQuotes??0)})})});
