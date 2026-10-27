// Development-only fixture entry, intentionally absent from index.html and Vite's production entry.
import '@maya/game-ui';
import { DEMO_CONFIG, resolveLayout } from '@maya/config';
import type { OfferPresentationAck, PageAllowanceSnapshot, PaperEnginePort, PaperSnapshot, PlacementIntent, PlacementResult } from '@maya/contracts';
import { ConsultationController } from '../src/sales-flow/ConsultationController.js';
if(!import.meta.env.DEV)throw new Error('Maya sales fixture is development-only.');

class FixturePort implements PaperEnginePort {
  pageLoadId=crypto.randomUUID(); count=0; offerShown=false; ackCalls=0; throwAck=0; notifyBeforeAck=false;
  listeners=new Set<()=>void>(); ackIds:string[]=[];
  getAllowance():PageAllowanceSnapshot{return {pageLoadId:this.pageLoadId,acceptedCount:this.count,remaining:10-this.count,offerShown:this.offerShown};}
  getSnapshot():PaperSnapshot{return {revision:0,balanceCents:'100000',positions:[],ready:true};}
  async placeBet(_intent:PlacementIntent):Promise<PlacementResult>{return {status:'rejected',reason:'UNSUPPORTED_CELL'};}
  async refill(){this.emit();}
  subscribe(fn:()=>void){this.listeners.add(fn);return ()=>{this.listeners.delete(fn);};}
  emit(){for(const fn of this.listeners)fn();}
  setCount(count:number,notify=true){this.count=count;if(notify)this.emit();}
  acknowledgeOfferShown(ack:OfferPresentationAck){
    this.ackCalls++;this.ackIds.push(ack.presentationId);
    if(ack.pageLoadId!==this.pageLoadId||this.count!==10)throw new Error('Fixture rejects early/foreign acknowledgement');
    if(this.throwAck-->0)throw new Error('Intentional one-shot acknowledgement failure');
    if(this.notifyBeforeAck)this.emit();
    this.offerShown=true;this.emit();return this.getAllowance();
  }
}
type Fixture={port:FixturePort;controller:ConsultationController;host:HTMLElement;root:HTMLElement;results:HTMLButtonElement;cancelCount:number};
let current:Fixture|undefined;
const sleep=(ms=0)=>new Promise(resolve=>setTimeout(resolve,ms));
function setup(count=0,attach=true):Fixture{
  current?.controller.dispose();document.querySelector('#app')!.replaceChildren();
  const root=document.createElement('div');root.className='maya';
  root.innerHTML='<div style="padding:24px;position:relative;z-index:1"><p>DEVELOPER FIXTURE — NO PROVIDER, PRICES OR PAPER LEDGER</p><button id="fixture-accept" style="height:44px">Simulate next accepted notification</button><button id="fixture-results" style="height:44px">Fixture results focus target</button><p id="fixture-status"></p></div>';
  document.querySelector('#app')!.append(root);
  const host=document.createElement('div');if(attach)root.append(host);
  const results=root.querySelector<HTMLButtonElement>('#fixture-results')!;
  const port=new FixturePort();port.count=count;
  const f:Fixture={port,host,root,results,cancelCount:0,controller:new ConsultationController(port,{overlayHost:host,cancelGesture(){f.cancelCount++;},focusResults(){results.focus();}})};
  root.querySelector('#fixture-accept')!.addEventListener('click',()=>{if(port.count<10)port.setCount(port.count+1);render();});
  current=f;render();return f;
}
function render(){if(!current)return;current.root.dataset.profile=resolveLayout({width:innerWidth,height:innerHeight,coarsePointer:matchMedia('(pointer: coarse)').matches});current.root.dataset.short=String(innerHeight<500);current.root.querySelector('#fixture-status')!.textContent=`Isolated fixture count: ${current.port.count}/10 · profile: ${current.root.dataset.profile}`;}
addEventListener('resize',render);
function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
function dialog(){return document.querySelector<HTMLElement>('[role=dialog]');}
const report:Record<string,unknown>[]=[];
async function test(id:string,fn:()=>void|Promise<void>){try{await fn();report.push({id,status:'PASS'});}catch(e){report.push({id,status:'FAIL',error:String(e)});}finally{current?.controller.dispose();}}
async function runRound1(){report.length=0;
  await test('N5-R1-01 early-and-missed-event',async()=>{const f=setup(9);await sleep();assert(!dialog(),'Nine opened offer');f.port.setCount(10,false);f.controller.dispose();f.controller=new ConsultationController(f.port,{overlayHost:f.host,cancelGesture(){},focusResults(){f.results.focus();}});await sleep();assert(dialog(),'Snapshot reconciliation failed');assert(f.port.offerShown&&f.port.ackCalls===1,'Acceptance acknowledgement incorrect');});
  await test('N5-R1-02 copy-dummy-link-focus',async()=>{const f=setup(10);await sleep();assert(dialog()?.textContent?.includes(DEMO_CONFIG.consultationBody),'Offer copy mismatch');const a=dialog()!.querySelector<HTMLAnchorElement>('a')!;assert(a.href==='https://quantellics.com'&&a.target==='_blank'&&a.rel.includes('noopener'),'Consultation link contract');assert(document.activeElement?.id==='offer-title','Initial heading not focused');assert(f.port.count===10,'UI mutated quota');});
  await test('N5-R1-03 dismissal-repeated-notification',async()=>{const f=setup(10);await sleep();f.controller.close();f.port.emit();await sleep();assert(!dialog(),'Dismissed modal reopened');assert(document.activeElement===f.results,'Focus not restored');assert(f.port.count===10,'Dismissal reset quota');});
  await test('N5-R1-04 detached-host-must-not-ack',async()=>{const f=setup(10,false);await sleep();assert(!f.port.offerShown&&f.port.ackCalls===0,'Detached invisible dialog acknowledged');});
  return {round:1,scope:'isolated real-controller + fixture port',at:new Date().toISOString(),results:[...report]};
}
async function runRound2(){report.length=0;
  await test('N5-R2-01 dispose-before-queued-show',async()=>{const f=setup(10);f.controller.dispose();await sleep();assert(!dialog()&&f.port.ackCalls===0,'Disposed controller opened or acknowledged');});
  await test('N5-R2-02 failed-mount-recovery',async()=>{const f=setup(10,false);await sleep();f.root.append(f.host);await sleep(800);assert(dialog()&&f.port.offerShown,'Attached view did not recover pending offer');});
  await test('N5-R2-03 ack-failure-dismissal-reentrant-notify',async()=>{const f=setup(9);f.port.throwAck=1;f.port.notifyBeforeAck=true;f.port.setCount(10);await sleep();assert(dialog(),'Offer not visible before failed acknowledgement');f.controller.close();await sleep(800);assert(f.port.offerShown,'Ack did not recover');assert(!dialog(),'Ack retry reopened dismissed offer');assert(new Set(f.port.ackIds).size===1,'Retry replaced presentation ID');assert(f.port.ackCalls<=3,'Reentrant acknowledgement loop');});
  await test('N5-R2-04 originating-click-repeat-enter-and-AT',async()=>{const f=setup(10);await sleep();const button=dialog()!.querySelector<HTMLElement>('.results-button')!;const click=new MouseEvent('click',{bubbles:true,cancelable:true,detail:1});button.dispatchEvent(click);assert(click.defaultPrevented&&dialog(),'Originating pointer click dismissed');const key=new KeyboardEvent('keydown',{key:'Enter',repeat:true,bubbles:true,cancelable:true});button.dispatchEvent(key);assert(key.defaultPrevented,'Held Enter not suppressed');button.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:0}));assert(!dialog()&&document.activeElement===f.results,'Assistive click failed');});
  await test('N5-R2-05 resize-pressed-control-no-clickthrough',async()=>{setup(10);await sleep();const button=dialog()!.querySelector<HTMLElement>('.results-button')!;button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1}));dispatchEvent(new Event('resize'));const click=new MouseEvent('click',{bubbles:true,cancelable:true,detail:1});button.dispatchEvent(click);assert(click.defaultPrevented&&dialog(),'Resize allowed moved-control clickthrough');});
  await test('N5-R2-06 throwing-mount-retries-without-ack',async()=>{const f=setup(9);const append=f.host.append.bind(f.host);let fail=true;f.host.append=(...nodes:(Node|string)[])=>{if(fail){fail=false;throw new Error('Intentional one-shot append failure');}append(...nodes);};f.port.setCount(10);await sleep();assert(f.port.ackCalls===0&&!dialog(),'Failed mount acknowledged');await sleep(600);assert(f.port.offerShown&&document.querySelectorAll('[role=dialog]').length===1,'Throwing mount did not recover once');});
  return {round:2,scope:'isolated real-controller + fixture port',at:new Date().toISOString(),results:[...report]};
}
async function runRound3(){report.length=0;
  await test('N5-R3-01 concurrent-controller-mount',async()=>{const f=setup(10);const second=new ConsultationController(f.port,{overlayHost:f.host,cancelGesture(){},focusResults(){}});try{await sleep();assert(document.querySelectorAll('[role=dialog]').length===1,'Concurrent mount duplicated offer');assert(f.port.ackCalls===1,'Concurrent mount duplicated acknowledgement');}finally{second.dispose();}});
  await test('N5-R3-02 pointer-must-start-on-same-action',async()=>{setup(10);await sleep();dialog()!.querySelector('.dialog-close')!.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:3}));const event=new MouseEvent('click',{bubbles:true,cancelable:true,detail:1});dialog()!.querySelector('.results-button')!.dispatchEvent(event);assert(event.defaultPrevented&&dialog(),'A pointer started on another action activated moved control');});
  await test('N5-R3-03 orientation-cancels-pressed-action',async()=>{setup(10);await sleep();const button=dialog()!.querySelector('.results-button')!;button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:3}));dispatchEvent(new Event('orientationchange'));const event=new MouseEvent('click',{bubbles:true,cancelable:true,detail:1});button.dispatchEvent(event);assert(event.defaultPrevented&&dialog(),'Orientation transition allowed clickthrough');});
  await test('N5-R3-04 keyboard-focus-loop',async()=>{const f=setup(10);await sleep();const section=dialog()!;section.querySelector('h1')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));assert(document.activeElement===section.querySelector('.results-button'),'Reverse tab did not wrap');section.querySelector('.results-button')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));assert(document.activeElement===section.querySelector('.dialog-close'),'Forward tab did not wrap');section.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert(!dialog()&&document.activeElement===f.results,'Escape did not restore results');});
  await test('N5-R3-05 dismissed-controller-remount',async()=>{const f=setup(10);await sleep();f.controller.close();f.controller.dispose();f.controller=new ConsultationController(f.port,{overlayHost:f.host,cancelGesture(){},focusResults(){f.results.focus();}});dispatchEvent(new Event('resize'));f.port.emit();await sleep();assert(!dialog()&&f.port.count===10&&f.port.ackCalls===1,'Remount reopened or changed allowance');});
  return {round:3,scope:'isolated real-controller + fixture port',at:new Date().toISOString(),results:[...report]};
}
function inspect(){const f=current!;const d=dialog();return {count:f.port.count,offerShown:f.port.offerShown,ackCalls:f.port.ackCalls,pageLoadId:f.port.pageLoadId,profile:f.root.dataset.profile,dialogCount:document.querySelectorAll('[role=dialog]').length,focus:document.activeElement?.id||document.activeElement?.className,controls:d?Array.from(d.querySelectorAll<HTMLElement>('a,button')).map(e=>({text:e.textContent,rect:{x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height},href:(e as HTMLAnchorElement).href})):[]};}
(window as any).mayaSalesTest={setup,runRound1,runRound2,runRound3,inspect,accept(){current!.port.setCount(Math.min(10,current!.port.count+1));render();},dismiss(){current!.controller.close();},emit(){current!.port.emit();},show(){setup(10);}};
setup();
