// Explicit developer entry. Vite's production entry is index.html; this module is not imported there.
import { MayaGame } from '@maya/game-ui';
import { createCell, multiplyDecimalInteger, parseDecimal } from '@maya/contracts';
import type { MarketId, PriceSample, QuoteSnapshot, PositionSnapshot } from '@maya/contracts';
import { DEMO_CONFIG, getMarket } from '@maya/config';
const now=Date.now();
const shape=[2991.6,2991.5,2991.2,2991.1,2991.25,2991.3,2991.55,2991.65,2991.62,2991.57,2991.60,2991.70,2991.83,2992.01,2992.12,2992.05,2992.01,2992.11,2992.23,2992.40,2992.48,2992.53,2992.57];
let selected:MarketId='eth-usd';
let fixtureCount=0;
let fixtureReady=true;
let offsetMs=0;
let showCards=false;
let available=true;
let jumpCase=false;
const intents:{cellId:string;stakeCents:string}[]=[];
const ui=new MayaGame(document.querySelector('#app')!,{
  makeCell:(marketId,start,bucket)=>createCell(marketId,start,multiplyDecimalInteger(getMarket(marketId).bandHeight,BigInt(bucket)),multiplyDecimalInteger(getMarket(marketId).bandHeight,BigInt(bucket+1))),
  quoteFor:cell=>available?({...cell,quoteId:cell.cellId,revision:1,grossX100:'250',sourceTimeMs:now,generatedAtMs:now,validUntilMs:now+1000000,simulated:true,provenance:{modelId:'DEVELOPER-FIXTURE',configId:'fixture',tableId:'fixture',policyId:'fixture',sourceSampleId:'fixture'}} as QuoteSnapshot):undefined,
  onBet:(quote,stakeCents)=>{intents.push({cellId:quote.cellId,stakeCents});ui.toast('Developer visual fixture — no paper ledger connected.');},
  onMarket:market=>{selected=market;update();},onRefill:()=>ui.toast('Developer visual fixture.'),onReload:()=>location.reload()
});
function update(){const market=getMarket(selected);const samples:PriceSample[]=shape.map((value,i)=>{const p=jumpCase&&i>=shape.length-2?(i===shape.length-2?2992:2993.5):value;return {sampleId:'fixture:'+i,marketId:selected,pairId:market.pairId,feedId:market.feedId,sourceTimeMs:now+offsetMs-(shape.length-1-i)*1000,receivedAtMs:now,price:parseDecimal(String(selected==='eth-usd'?p:p*30))};});
const positions:PositionSnapshot[]=showCards?[0,1].map(i=>{const bucket=selected==='eth-usd'?5984+i:8976+i;return {...createCell(selected,jumpCase?Math.floor(now/5000)*5000:Math.ceil(now/5000)*5000+10000,multiplyDecimalInteger(market.bandHeight,BigInt(bucket)),multiplyDecimalInteger(market.bandHeight,BigInt(bucket+1))),positionId:'fixture-card-'+i,requestId:'fixture-'+i,pageLoadId:'fixture',quoteId:'fixture',stakeCents:'500',grossX100:i?'246':'251',grossReturnCents:i?'1230':'1255',acceptedAtMs:now,status:'open',provenance:{modelId:'DEVELOPER-FIXTURE',configId:'fixture',tableId:'fixture',policyId:'fixture',sourceSampleId:'fixture'}};}):[];
ui.update({marketId:selected,samples,positions,balanceCents:DEMO_CONFIG.startingBalanceCents,acceptedCount:fixtureCount,health:fixtureReady?'ready':'stale',healthMessage:'DEVELOPER VISUAL FIXTURE · sample values only',ready:fixtureReady,nowMs:now+offsetMs,maxHealthySourceAgeS:7,leadTimeS:3});}
update();
// Explicit fixture-only controls for browser QA. Never imported by index.html.
Object.assign(window,{__mayaFixture:{intents,diagnostics:()=>ui.diagnostics(),resetMeasurements:()=>ui.resetMeasurements(),setJump:(value:boolean)=>{jumpCase=value;showCards=true;update();},setCards:(value:boolean)=>{showCards=value;update();},setReady:(value:boolean)=>{fixtureReady=value;update();},setCount:(value:number)=>{fixtureCount=value;update();},advance:(value:number)=>{offsetMs+=value;update();},setAvailable:(value:boolean)=>{available=value;update();},dispose:()=>ui.dispose()}});
