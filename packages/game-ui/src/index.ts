import * as THREE from 'three';
import type { CellTerms, MarketId, PositionSnapshot, PriceSample, QuoteSnapshot } from '@maya/contracts';
import { decimalToNumber, formatMultiplier } from '@maya/contracts';
import { DEMO_CONFIG, ADAPTIVE_CONFIG, resolveLayout, getMarket, clampZoom } from '@maya/config';
import { boardProjection, usesPhoneControls, containsPoint, isTap, isWholeCellVisible, labelScale } from './geometry.js';
import { measureLayout } from './layout.js';
import { PhoneControls } from './phone-controls.js';
import { FeedbackLayer } from './feedback.js';
import { groupPositions, type PositionGroup } from './position-groups.js';
import { advancePlayhead, curvePrice, displayPriceAt, linearPriceAt } from './timeline.js';
import { PAPER_PRESENTATION, rootMarkup, type GamePresentation } from './presentation.js';
export { PAPER_PRESENTATION, type GamePresentation } from './presentation.js';
import './styles.css';
import './adaptive.css';
import './motion.css';
import './controls.css';
import './phone.css';
export interface GameViewState {
  marketId: MarketId;
  pathMode?: 'linear'|'legacy';
  samples: readonly PriceSample[];
  positions: readonly PositionSnapshot[];
  balanceCents: string;
  acceptedCount: number;
  health: string;
  healthMessage: string;
  ready: boolean;
  nowMs: number;
  maxHealthySourceAgeS: number;
  leadTimeS: number;
  /** Live only: placements the house is still deciding (shown as "Confirming…" on their squares). */
  pending?: readonly PendingPlay[];
}
/** A placement sent to the house and not yet accepted or rejected (SPEC-10 acceptance hold, or a reconciling timeout). */
export interface PendingPlay extends CellTerms {
  readonly requestId: string;
  readonly stakeCents: string;
  readonly grossX100: string;
  /** 'confirming' while the house holds it; 'checking' while a lost answer is reconciled by requestId. */
  readonly phase: 'confirming' | 'checking';
}
export interface MayaUiOptions {
  quoteFor(cell: CellTerms): QuoteSnapshot | undefined;
  makeCell(marketId: MarketId, startMs: number, priceBucket: number): CellTerms;
  onBet(quote: QuoteSnapshot, stakeCents: string): void;
  onMarket(market: MarketId): void;
  onRefill(): void;
  onReload(): void;
  /** Paper and live presentation (defaults to the paper demo). */
  presentation?: GamePresentation;
  /** Live: the wallet button opens the host's account panel instead of the integrations dialog. */
  onWallet?(): void;
  /** Live: the withdraw action. */
  onWithdraw?(): void;
  /** Live: host dialogs that must block squares (checked with the built-in overlays). */
  inputBlocked?(): boolean;
}
type Profile = 'desktop' | 'tablet' | 'mobile';
type VisibilityGeometry = { top:number;bottom:number;panel?:{left:number;top:number;right:number;bottom:number} };
const priceOf = decimalToNumber;
/** Presentation only. The injected acceptance port owns all financial state. */
export class MayaGame {
  readonly root: HTMLDivElement;
  readonly overlayHost: HTMLDivElement;
  private state?: GameViewState;
  private options: MayaUiOptions;
  private p: GamePresentation;
  private stakes: readonly string[];
  private money: (value: string) => string;
  private pendingCards = new Map<string, {element:HTMLDivElement;play:PendingPlay}>();
  private surface: HTMLDivElement;
  private offers: HTMLDivElement;
  private cards: HTMLDivElement;
  private axes: HTMLDivElement;
  private renderer: THREE.WebGLRenderer;
  private walletDialog: HTMLDialogElement;
  private phoneControls: PhoneControls;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(0,1,0,1,-10,10);
  private gridGeometry = new THREE.BufferGeometry();
  private traceGeometry = new THREE.BufferGeometry();
  private dotsGeometry = new THREE.BufferGeometry();
  private intersectionsGeometry = new THREE.BufferGeometry();
  private trace: THREE.Mesh;
  private glowGeometry = new THREE.BufferGeometry();
  private glowBuffer = new Float32Array(32768 * 3);
  private feedback: FeedbackLayer;
  private cardById = new Map<string, {element:HTMLDivElement;group:PositionGroup;born:number;terminalAt?:number}>();
  private groups = new Map<string,PositionGroup>();
  private winStreak = 0;
  private pendingResults = new Map<string,PositionGroup>();
  private seenGroups = new Map<string,{status:PositionGroup['status'];count:number}>();
  private retiredCards = new Set<string>();
  private hydrated = false;
  private stateReceivedAt = 0;
  private allowanceCount = -1;
  private displayedPrice = 0;
  private gridBuffer = new Float32Array(2048 * 3);
  private traceBuffer = new Float32Array(32768 * 3);
  private dotsBuffer = new Float32Array(2048 * 3);
  private intersectionsBuffer = new Float32Array(4096 * 3);
  private traceColors = new Float32Array(32768 * 3);
  private tip: THREE.Mesh;
  private tipGlow: THREE.Mesh;
  private profile: Profile = 'desktop';
  private width = 1;
  private height = 1;
  private cell = 1;
  private anchor = .29;
  private gutter = 48;
  private zoom: number = DEMO_CONFIG.zoom.initial;
  private stakeIndex = 0;
  private cameraTime = 0;
  private cameraPrice = 0;
  private timePan = 0;
  private pricePan = 0;
  private lastFrame = 0;
  private lastOffers = 0;
  private animation = 0;
  private viewRevision = 0;
  private resizeObserver: ResizeObserver;
  private media = matchMedia('(pointer:coarse)');
  private quoteByCell = new Map<string,QuoteSnapshot>();
  private buttonByCell = new Map<string,HTMLButtonElement>();
  private unavailableCells = new Set<string>();
  private pointers = new Map<number,{x:number;y:number}>();
  private gesture?: {id:number;x:number;y:number;lastX:number;lastY:number;quote?:QuoteSnapshot;touchedOffer:boolean;stake:string;revision:number;canceled:boolean};
  private pinchDistance = 0;
  private pinching = false;
  private focusedCell?: string;
  private disposeCallbacks: (()=>void)[] = [];
  private shapeKey = '';
  private htmlKey = '\0';
  private axesKey = '';
  private keyboardActivation = { cellId: '', at: 0 };
  private frameTimes: number[] = [];
  private disposed = false;
  private suppressedConnectors = 0;
  private reducedMotion = matchMedia('(prefers-reduced-motion:reduce)').matches;
  constructor(host: HTMLElement, options: MayaUiOptions) {
    this.options = options;
    this.p = options.presentation ?? PAPER_PRESENTATION;
    this.stakes = this.p.stakes;
    this.money = this.p.formatMoney;
    this.stakeIndex = this.stakes.indexOf(this.p.initialStake);
    this.root = document.createElement('div');
    this.root.className = 'maya';
    this.root.innerHTML = rootMarkup(this.p);
    host.append(this.root);
    this.surface = this.el('.scene'); this.offers = this.el('.offers'); this.cards = this.el('.positions'); this.axes = this.el('.axes'); this.overlayHost = this.el('.overlay-host');
    this.walletDialog = this.el<HTMLDialogElement>('.wallet-dialog');
    this.phoneControls = new PhoneControls(this.root,()=>this.cancelGesture(),this.p);
    this.listen(this.walletDialog,'close',()=>{
      this.el('.wallet-button').setAttribute('aria-expanded','false');
      if(this.root.isConnected)this.el(this.root.dataset.phone==='true'?'.phone-thumb-bar [data-action=phone-menu]':'.wallet-button').focus({preventScroll:true});
    });
    this.listen(this.walletDialog,'click',(event:Event)=>{
      const e=event as MouseEvent,rect=this.walletDialog.getBoundingClientRect();
      if(e.target===this.walletDialog&&(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom))this.walletDialog.close();
    });
    this.renderer = new THREE.WebGLRenderer({alpha:true,antialias:true,powerPreference:'high-performance'});
    this.renderer.setClearColor(0x000000,0);
    this.surface.prepend(this.renderer.domElement);
    const grid = new THREE.LineSegments(this.gridGeometry,new THREE.LineBasicMaterial({color:0x91506e,transparent:true,opacity:.24}));
    this.trace = new THREE.Mesh(this.traceGeometry,new THREE.MeshBasicMaterial({vertexColors:true,transparent:true,opacity:.96,side:THREE.DoubleSide,depthTest:false}));
    const glow = new THREE.Mesh(this.glowGeometry,new THREE.MeshBasicMaterial({color:0xf6a0d1,transparent:true,opacity:.12,side:THREE.DoubleSide,depthTest:false}));
    const dots = new THREE.Points(this.dotsGeometry,new THREE.PointsMaterial({color:0xf5d6e9,size:2.4,sizeAttenuation:false,transparent:true,opacity:.85}));
    const intersections = new THREE.Points(this.intersectionsGeometry,new THREE.PointsMaterial({color:0xb65d8b,size:3.3,sizeAttenuation:false,transparent:true,opacity:.46}));
    this.tip = new THREE.Mesh(new THREE.CircleGeometry(4,20),new THREE.MeshBasicMaterial({color:0xfff2fa,side:THREE.DoubleSide,depthTest:false}));
    this.gridGeometry.setAttribute('position',new THREE.BufferAttribute(this.gridBuffer,3).setUsage(THREE.DynamicDrawUsage));
    this.traceGeometry.setAttribute('position',new THREE.BufferAttribute(this.traceBuffer,3).setUsage(THREE.DynamicDrawUsage));
    this.glowGeometry.setAttribute('position',new THREE.BufferAttribute(this.glowBuffer,3).setUsage(THREE.DynamicDrawUsage));
    this.traceGeometry.setAttribute('color',new THREE.BufferAttribute(this.traceColors,3).setUsage(THREE.DynamicDrawUsage));
    this.dotsGeometry.setAttribute('position',new THREE.BufferAttribute(this.dotsBuffer,3).setUsage(THREE.DynamicDrawUsage));
    this.intersectionsGeometry.setAttribute('position',new THREE.BufferAttribute(this.intersectionsBuffer,3).setUsage(THREE.DynamicDrawUsage));
    grid.frustumCulled=false;this.trace.frustumCulled=false;dots.frustumCulled=false;
    intersections.frustumCulled=false;
    glow.frustumCulled=false;
    this.tipGlow=new THREE.Mesh(new THREE.CircleGeometry(10,24),new THREE.MeshBasicMaterial({color:0xffcfe9,transparent:true,opacity:.13,side:THREE.DoubleSide,depthTest:false}));
    this.scene.add(grid,intersections,glow,this.trace,this.tipGlow,this.tip);
    this.feedback=new FeedbackLayer(this.surface,this.p.mode==='paper'?{reducedMotion:this.reducedMotion}:{reducedMotion:this.reducedMotion,formatMoney:this.money});
    this.listen(this.root.querySelector('select')!, 'change', () => {
      this.cancelGesture(); this.cameraTime=0; this.shapeKey=''; this.lastOffers=0; this.timePan=0;this.pricePan=0;
      this.quoteByCell.clear();this.buttonByCell.clear();this.unavailableCells.clear();this.offers.replaceChildren();
      options.onMarket((this.root.querySelector('select') as HTMLSelectElement).value as MarketId);
    });
    this.listen(this.root,'click',(event:Event)=>this.controlClick(event));
    this.listen(this.root,'pointerdown',(event:Event)=>{
      const e=event as PointerEvent;
      if(e.pointerType==='touch'&&this.pointers.size&&!this.surface.contains(e.target as Node))this.cancelGesture();
    },{capture:true});
    this.listen(this.surface,'pointerdown',(event:Event)=>this.pointerDown(event as PointerEvent));
    this.listen(this.surface,'pointermove',(event:Event)=>this.pointerMove(event as PointerEvent));
    this.listen(this.surface,'pointerup',(event:Event)=>this.pointerUp(event as PointerEvent));
    this.listen(this.surface,'pointercancel',()=>this.cancelGesture());
    this.listen(this.surface,'lostpointercapture',(event:Event)=>{if(this.pointers.has((event as PointerEvent).pointerId))this.cancelGesture();});
    this.listen(window,'blur',()=>this.cancelGesture());
    this.listen(document,'visibilitychange',()=>this.cancelGesture());
    this.listen(this.surface,'wheel',(event:Event)=>{const e=event as WheelEvent;e.preventDefault();this.setZoom(this.zoom*(e.deltaY<0?DEMO_CONFIG.zoom.inFactor:DEMO_CONFIG.zoom.outFactor));},{passive:false});
    this.listen(this.offers,'keydown',(event:Event)=>this.cellKey(event as KeyboardEvent));
    const fitFocused=(event:Event)=>{const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button.offer');if(button)this.fitOfferLabels(button);};
    this.listen(this.offers,'pointerover',fitFocused);
    this.listen(this.offers,'focusin',fitFocused);
    this.listen(document.fonts,'loadingdone',()=>{for(const button of this.buttonByCell.values())this.fitOfferLabels(button);});
    this.listen(this.offers,'keyup',(event:Event)=>{const e=event as KeyboardEvent;if(e.key==='Enter'||e.key===' ')e.preventDefault();});
    this.listen(this.offers,'click',(event:Event)=>{const e=event as MouseEvent;e.preventDefault();if(e.detail!==0)return;const button=(e.target as HTMLElement).closest<HTMLButtonElement>('button[data-cell-id]');const quote=button && this.quoteByCell.get(button.dataset.cellId!);if(quote && this.canBet(quote) && !(this.keyboardActivation.cellId===quote.cellId&&performance.now()-this.keyboardActivation.at<300))this.options.onBet(quote,this.stakes[this.stakeIndex]!);});
    this.resizeObserver = new ResizeObserver(()=>this.resize());this.resizeObserver.observe(this.root);
    this.listen(this.media,'change',()=>this.resize());
    this.listen(window.visualViewport ?? window,'resize',()=>this.resize());
    this.resize();this.animation=requestAnimationFrame(t=>this.frame(t));
  }
  private el<T extends HTMLElement = HTMLDivElement>(selector:string):T {return this.root.querySelector<T>(selector)!;}
  private listen(target:EventTarget,event:string,handler:EventListener,options?:AddEventListenerOptions){target.addEventListener(event,handler,options);this.disposeCallbacks.push(()=>target.removeEventListener(event,handler,options));}
  update(state: GameViewState){
    if(this.state&&this.state.marketId!==state.marketId){this.feedback.clear();this.cameraTime=0;this.axesKey='';}
    const initialHydration=!this.hydrated && state.ready;
    if(initialHydration){for(const g of groupPositions(state.positions)){this.seenGroups.set(g.groupId,{status:g.status,count:g.count});if(g.status!=='open')this.retiredCards.add(g.groupId);}this.hydrated=true;}
    this.state=state;this.stateReceivedAt=performance.now();
    const current = state.samples.at(-1);
    this.el('.pair-price').textContent=current?'$'+priceOf(current.price).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
    this.el('.coin-symbol').textContent=state.marketId==='btc-usd'?'₿':'♦';
    (this.root.querySelector('select') as HTMLSelectElement).value=state.marketId;
    const balance=this.el('.balance');if(balance.textContent!==this.money(state.balanceCents)){const old=balance.textContent;balance.textContent=this.money(state.balanceCents);if(old&&!this.reducedMotion)balance.animate([{color:'#eeffab',filter:'brightness(1.6)'},{color:'inherit',filter:'brightness(1)'}],{duration:550});}
    const limit=this.p.playLimit;
    if(limit!==null&&this.allowanceCount!==state.acceptedCount){this.allowanceCount=state.acceptedCount;this.el('.allowance').innerHTML=state.acceptedCount<limit?`<b>${limit-state.acceptedCount}</b> plays left`:`<button class="refresh-button" data-action="reload">Refresh · ${limit} more plays</button>`;}
    this.phoneControls.update(this.stakeIndex,this.zoom,state.balanceCents,state.acceptedCount);
    this.el('.status-line').dataset.state=state.ready?'ready':state.health;
    this.el('.connection-text').textContent=state.healthMessage;
    const empty=this.el('.empty-state');empty.hidden=!!current && state.ready;
    if(!state.ready){empty.querySelector('b')!.textContent=current?'Waiting for available squares':'Connecting to the market';empty.querySelector('span')!.textContent=state.healthMessage;}
    this.el('.board-hint').innerHTML=this.exhausted(state)?`Your plays are still running. <strong>Refresh for ${limit} more.</strong>`:this.p.boardHint;
    const key=state.positions.map(p=>p.positionId+':'+p.status).join('|');
    if(key!==this.htmlKey){this.htmlKey=key;this.renderResults();}
    this.renderPending();
    if(current && !this.cameraTime){this.cameraTime=Math.min(current.sourceTimeMs,state.nowMs-1500);this.cameraPrice=(state.pathMode==='linear'?linearPriceAt:displayPriceAt)(state.samples,this.cameraTime);this.displayedPrice=this.cameraPrice;}
    this.resize();this.renderCards();
  }
  toast(text:string,win=false){const t=document.createElement('div');t.className='toast'+(win?' win':'');t.textContent=text;this.el('.toast-stack').append(t);while(this.el('.toast-stack').children.length>3)this.el('.toast-stack').firstElementChild?.remove();setTimeout(()=>t.remove(),4500);this.el('.screen-reader').textContent=text;}
  focusResults(){this.root.dataset.resultsOpen='true';this.el('.results-panel').setAttribute('tabindex','-1');this.el('.results-panel').focus();}
  cancelGesture(){this.gesture=undefined;this.pointers.clear();this.pinchDistance=0;this.pinching=false;}
  /** Paper: ten accepted plays lock the board until refresh. Live: no play limit. */
  private exhausted(state:GameViewState|undefined=this.state){const limit=this.p.playLimit;return limit!==null&&!!state&&state.acceptedCount>=limit;}
  /** Live: forget every position card and result (the signed-in account changed). */
  resetPositions(){
    for(const {element} of this.cardById.values())element.remove();
    for(const {element} of this.pendingCards.values())element.remove();
    this.cardById.clear();this.pendingCards.clear();this.groups.clear();this.pendingResults.clear();this.seenGroups.clear();this.retiredCards.clear();
    this.hydrated=false;this.htmlKey='\0';this.winStreak=0;this.feedback.clear();
  }
  /** Live: the house refused a placement; mark its square with a short caption (the toast carries the reason). */
  rejectAt(cell:CellTerms,label?:string){
    if(!this.state||cell.marketId!==this.state.marketId)return;
    this.feedback.emit({id:'reject:'+cell.cellId,kind:'reject',...(label?{label}:{}),x:this.x(cell.startMs)+this.cell/2,y:this.y(priceOf(cell.upperPrice))+this.cell/2,size:this.cell});
  }
  /** Live: "Confirming…" cards for placements the house is still deciding. */
  private renderPending(){
    const s=this.state;if(!s)return;
    const wanted=new Map((s.pending??[]).filter(p=>p.marketId===s.marketId).map(p=>[p.requestId,p]));
    for(const [id,entry] of this.pendingCards)if(!wanted.has(id)){entry.element.remove();this.pendingCards.delete(id);}
    for(const [id,play] of wanted){
      let entry=this.pendingCards.get(id);
      if(!entry){
        const element=document.createElement('div');element.className='position-card pending-play';element.dataset.requestId=id;element.dataset.cellId=play.cellId;element.setAttribute('role','img');
        element.innerHTML='<b></b><span></span>';entry={element,play};this.pendingCards.set(id,entry);this.cards.append(element);
      }
      entry.play=play;entry.element.dataset.phase=play.phase;
      entry.element.querySelector('b')!.textContent=this.money(play.stakeCents);
      entry.element.querySelector('span')!.textContent=play.phase==='checking'?'Checking…':'Confirming…';
      entry.element.setAttribute('aria-label',`${play.phase==='checking'?'Checking':'Confirming'} your play: stake ${this.money(play.stakeCents)} at ${formatMultiplier(play.grossX100).slice(0,-1)} times`);
    }
  }
  getProfile(){return this.profile;}
  /** Read-only diagnostic evidence; never an alternate gameplay mutation API. */
  diagnostics(){const times=[...this.frameTimes].sort((a,b)=>a-b);return {profile:this.profile,phoneControls:this.root.dataset.phone==='true',activePointers:this.pointers.size,pinching:this.pinching,zoom:this.zoom,stakeCents:this.stakes[this.stakeIndex],cellPixels:this.cell,sceneHeight:this.height,frameSamples:times.length,p95FrameMs:times[Math.floor(times.length*.95)]??0,geometries:this.renderer.info.memory.geometries,textures:this.renderer.info.memory.textures,drawCalls:this.renderer.info.render.calls,playheadMs:this.cameraTime,displayedPrice:this.displayedPrice,displayLagMs:this.state?this.state.nowMs-this.cameraTime:0,nearestOfferGapCells:Math.min(...[...this.quoteByCell.values()].map(q=>(q.startMs-this.cameraTime)/5000)),activeEffects:this.feedback.activeIds().length,winStreak:this.winStreak,cardPhases:[...this.cardById.values()].map(e=>({id:e.group.groupId,phase:e.element.dataset.phase,count:e.group.count,stakeCents:e.group.totalStakeCents})),offerCount:this.buttonByCell.size,cardCount:this.cards.children.length,suppressedConnectors:this.suppressedConnectors,disposed:this.disposed};}
  resetMeasurements(){this.frameTimes.length=0;}
  private controlClick(e:Event){
    const target=(e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if(target){
      const a=target.dataset.action;
      const previousStakeIndex=this.stakeIndex;
      if(a&&this.phoneControls.handleAction(a,target)){this.syncControls();return;}
      this.cancelGesture();
      if(['live','next','results','wallet','reload'].includes(a??'')||(this.p.mode==='live'&&(a==='refill'||a==='withdraw')))this.phoneControls.close();
      if(a==='zoom-in')this.setZoom(this.zoom*DEMO_CONFIG.zoom.inFactor);
      if(a==='zoom-out')this.setZoom(this.zoom*DEMO_CONFIG.zoom.outFactor);
      if(a==='min')this.stakeIndex=0;
      if(a==='max')this.stakeIndex=this.stakes.length-1;
      if(a==='lower')this.stakeIndex=Math.max(0,this.stakeIndex-1);
      if(a==='raise')this.stakeIndex=Math.min(this.stakes.length-1,this.stakeIndex+1);
      if(a==='set-stake'){
        const index=Number(target.dataset.stakeIndex);
        if(Number.isInteger(index)&&index>=0&&index<this.stakes.length)this.stakeIndex=index;
      }
      if(a==='refill')this.options.onRefill();
      if(a==='withdraw')this.options.onWithdraw?.();
      if(a==='reload')this.options.onReload();
      if(a==='live'){this.timePan=0;this.pricePan=0;this.setZoom(DEMO_CONFIG.zoom.initial);this.lastOffers=0;this.viewRevision++;}
      if(a==='next')this.focusNext();
      if(a==='results'){this.renderResults();this.focusResults();}
      if(a==='results-close'){this.root.dataset.resultsOpen='false';this.el<HTMLButtonElement>(this.root.dataset.phone==='true'?'.phone-history':'[data-action=results]').focus();}
      if(a==='wallet'){
        this.root.querySelector('.help-panel')?.remove();this.el('.help-button').setAttribute('aria-expanded','false');
        if(this.options.onWallet)this.options.onWallet();
        else{this.walletDialog.showModal();this.el('.wallet-button').setAttribute('aria-expanded','true');}
      }
      if(a==='wallet-close')this.walletDialog.close();
      this.syncControls();
      // Show the next click's exact stake immediately, independently of quote refreshes.
      // Accepted cards retain the sum of their immutable individual stakes.
      if(previousStakeIndex!==this.stakeIndex){
        for(const[id,button]of this.buttonByCell){const quote=this.quoteByCell.get(id);if(quote)this.updateOfferLabel(button,quote);}
        this.positionElements();
      }
    }
    if((e.target as HTMLElement).closest('.help-button')){const existing=this.root.querySelector('.help-panel');this.el('.help-button').setAttribute('aria-expanded',String(!existing));if(existing)existing.remove();else{const panel=document.createElement('div');panel.className='help-panel';panel.innerHTML=this.p.helpHtml;this.root.append(panel);}}
  }
  private syncControls(){
    this.el('.stake-value b').textContent=this.p.formatStake(this.stakes[this.stakeIndex]!);
    this.el('.zoom-readout').textContent=this.zoom.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    for(const [action,disabled] of [['lower',this.stakeIndex===0],['raise',this.stakeIndex===this.stakes.length-1],['zoom-in',this.zoom>=DEMO_CONFIG.zoom.max],['zoom-out',this.zoom<=DEMO_CONFIG.zoom.min]] as const)
      this.root.querySelectorAll<HTMLButtonElement>(`[data-action=${action}]`).forEach(button=>button.disabled=disabled);
    this.phoneControls.dialog.querySelector<HTMLButtonElement>('[data-action=min]')!.disabled=this.stakeIndex===0;
    this.phoneControls.dialog.querySelector<HTMLButtonElement>('[data-action=max]')!.disabled=this.stakeIndex===this.stakes.length-1;
    this.phoneControls.update(this.stakeIndex,this.zoom,this.state?.balanceCents??(this.p.mode==='paper'?DEMO_CONFIG.startingBalanceCents:'0'),this.state?.acceptedCount??0);
  }
  private setZoom(value:number,preservePinch=false){
    if(!preservePinch)this.cancelGesture();
    const next=clampZoom(value);if(next===this.zoom)return;
    this.zoom=next;this.syncControls();this.lastOffers=0;this.viewRevision++;this.resize(preservePinch);
  }
  private resize(preservePinch=false){
    const rect=this.root.getBoundingClientRect();const outerH=Math.min(rect.height,window.visualViewport?.height??rect.height);const w=rect.width;
    const profile=resolveLayout({width:Math.max(1,w),height:Math.max(1,outerH),coarsePointer:this.media.matches});
    const phone=usesPhoneControls(w,outerH,this.media.matches);
    this.root.dataset.phone=String(phone);
    if(!phone)this.phoneControls.close();
    const box=measureLayout(this.root,profile,w,outerH);
    const anchor=ADAPTIVE_CONFIG[profile].anchorFraction;const gutter=ADAPTIVE_CONFIG[profile].rightGutter;
    const maxAge=this.state?.maxHealthySourceAgeS;const lead=this.state?.leadTimeS;
    const horizon=maxAge!==undefined&&lead!==undefined?maxAge+lead+15:undefined;
    const {height:h,cell}=boardProjection(box.height,box.width,anchor,gutter,this.zoom,phone,horizon);
    const sceneTop=box.top+(!phone&&profile==='mobile'&&this.root.dataset.short!=='true'?Math.max(0,(box.height-h)/2):0);
    const key=[box.width,h,cell,profile,phone,sceneTop,box.left].join(':');if(key===this.shapeKey)return;this.shapeKey=key;
    if(!preservePinch)this.cancelGesture();
    this.viewRevision++;this.profile=profile;this.width=box.width;this.height=h;this.cell=cell;this.anchor=anchor;this.gutter=gutter;
    this.root.style.setProperty('--cell-pixels',this.cell+'px');
    this.surface.style.left=box.left+'px';this.surface.style.width=box.width+'px';this.surface.style.top=sceneTop+'px';this.surface.style.height=h+'px';
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,ADAPTIVE_CONFIG[profile].dprCap));this.renderer.setSize(box.width,h,false);this.camera.right=box.width;this.camera.bottom=h;this.camera.updateProjectionMatrix();this.lastOffers=0;
  }
  private pointerDown(e:PointerEvent){
    if(this.overlayHost.childElementCount||this.walletDialog.open||this.phoneControls.open||this.options.inputBlocked?.()||e.button!==0)return;
    this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    this.surface.setPointerCapture(e.pointerId);
    if(this.pointers.size>1){this.gesture=undefined;this.pinching=true;const p=[...this.pointers.values()];this.pinchDistance=Math.hypot(p[0]!.x-p[1]!.x,p[0]!.y-p[1]!.y);return;}
    const button=(e.target as HTMLElement).closest<HTMLButtonElement>('button[data-cell-id]');
    const candidate=button?this.quoteByCell.get(button.dataset.cellId!):undefined;
    const quote=candidate&&this.canBet(candidate)?candidate:undefined;
    this.gesture={id:e.pointerId,x:e.clientX,y:e.clientY,lastX:e.clientX,lastY:e.clientY,quote,touchedOffer:!!button,stake:this.stakes[this.stakeIndex]!,revision:this.viewRevision,canceled:false};
  }
  private pointerMove(e:PointerEvent){
    if(!this.pointers.has(e.pointerId))return;this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(this.pointers.size>1){const p=[...this.pointers.values()];const d=Math.hypot(p[0]!.x-p[1]!.x,p[0]!.y-p[1]!.y);if(this.pinchDistance>0&&d>0)this.setZoom(this.zoom*d/this.pinchDistance,true);this.pinchDistance=d;return;}
    if(this.pinching)return; // A remaining finger cannot turn the pinch into a pan or bet.
    const g=this.gesture;if(!g||g.id!==e.pointerId)return;
    if(Math.hypot(e.clientX-g.x,e.clientY-g.y)>8)g.canceled=true;
    if(g.canceled){this.timePan-=(e.clientX-g.lastX)*5000/this.cell;this.pricePan+=(e.clientY-g.lastY)*(priceOf(getMarket(this.state?.marketId??DEMO_CONFIG.initialMarketId).bandHeight))/this.cell;this.timePan=Math.max(-60000,Math.min(60000,this.timePan));this.lastOffers=0;}
    g.lastX=e.clientX;g.lastY=e.clientY;
  }
  private pointerUp(e:PointerEvent){
    const g=this.gesture;this.pointers.delete(e.pointerId);
    const rect=this.surface.getBoundingClientRect();
    if(g&&g.id===e.pointerId&&isTap(g.x,g.y,e.clientX,e.clientY,g.canceled)&&g.revision===this.viewRevision){
      if(g.quote&&this.canBet(g.quote)&&containsPoint(this.x(g.quote.startMs),this.y(priceOf(g.quote.upperPrice)),this.cell,e.clientX-rect.left,e.clientY-rect.top))this.options.onBet(g.quote,g.stake);
      // A quote can disappear between touch-down and release. Give phone players an
      // explicit rejection instead of a silent tap; never substitute new odds or retry a bet.
      else if(g.touchedOffer&&this.root.dataset.phone==='true')this.toast('That square changed. Try another.');
    }
    this.gesture=undefined;if(this.pointers.size<2)this.pinchDistance=0;if(!this.pointers.size)this.pinching=false;
  }
  private cellKey(e:KeyboardEvent){
    const target=(e.target as HTMLElement).closest<HTMLButtonElement>('[data-cell-id]');if(!target)return;
    if(e.key==='Enter'||e.key===' '){e.preventDefault();const q=this.quoteByCell.get(target.dataset.cellId!);if(!e.repeat&&q&&this.canBet(q)){this.keyboardActivation={cellId:q.cellId,at:performance.now()};this.options.onBet(q,this.stakes[this.stakeIndex]!);}return;}
    if(!e.key.startsWith('Arrow'))return;e.preventDefault();const current=this.quoteByCell.get(target.dataset.cellId!);if(!current)return;
    const candidates=[...this.quoteByCell.values()].filter(q=>this.canBet(q)).filter(q=>e.key==='ArrowRight'?q.startMs>current.startMs:e.key==='ArrowLeft'?q.startMs<current.startMs:e.key==='ArrowUp'?priceOf(q.lowerPrice)>priceOf(current.lowerPrice):priceOf(q.lowerPrice)<priceOf(current.lowerPrice));
    candidates.sort((a,b)=>Math.abs(a.startMs-current.startMs)/5000+Math.abs(priceOf(a.lowerPrice)-priceOf(current.lowerPrice))/(priceOf(getMarket(this.state?.marketId??DEMO_CONFIG.initialMarketId).bandHeight))-Math.abs(b.startMs-current.startMs)/5000-Math.abs(priceOf(b.lowerPrice)-priceOf(current.lowerPrice))/(priceOf(getMarket(this.state?.marketId??DEMO_CONFIG.initialMarketId).bandHeight)));
    if(candidates[0])this.focusCell(candidates[0].cellId);
  }
  private focusCell(id:string){this.focusedCell=id;for(const [cell,button]of this.buttonByCell){button.tabIndex=cell===id?0:-1;button.classList.toggle('focused',cell===id);}this.buttonByCell.get(id)?.focus({preventScroll:true});}
  private focusNext(){
    const candidates=[...this.quoteByCell.values()].filter(q=>this.canBet(q)).sort((a,b)=>a.startMs-b.startMs||Math.abs(priceOf(a.lowerPrice)-this.cameraPrice)-Math.abs(priceOf(b.lowerPrice)-this.cameraPrice));
    if(candidates.length){const index=candidates.findIndex(q=>q.cellId===this.focusedCell);this.focusCell(candidates[(index+1)%candidates.length]!.cellId);return;}
    const s=this.state;const latest=s?.samples.at(-1);if(!s?.ready||!latest||this.exhausted(s)){this.toast('Waiting for an available square.');return;}
    const band=priceOf(getMarket(s.marketId).bandHeight), center=Math.floor(priceOf(latest.price)/band);
    const first=Math.ceil((s.nowMs+s.leadTimeS*1000+1)/5000)*5000;
    for(let window=0;window<4;window++)for(const offset of [0,-1,1,-2,2,-3,3,-4,4]){
      const q=this.options.quoteFor(this.options.makeCell(s.marketId,first+window*5000,center+offset));if(!q)continue;
      this.timePan=q.startMs-this.cameraTime-(this.width*.42-this.width*this.anchor)*5000/this.cell;
      this.pricePan=(priceOf(q.lowerPrice)+priceOf(q.upperPrice))/2-this.cameraPrice;
      this.viewRevision++;this.refreshOffers();this.positionElements();if(this.buttonByCell.has(q.cellId)){this.focusCell(q.cellId);return;}
    }
    this.toast('No available square yet. Prices are still updating.');
  }
  private measureVisibilityGeometry():VisibilityGeometry{
    const footer=Number.parseFloat(this.root.style.getPropertyValue('--footer-space'))||76;
    const geometry:VisibilityGeometry={top:this.profile==='desktop'?76:0,bottom:this.profile==='desktop'?footer+86:32};
    const panel=this.el('.results-panel').getBoundingClientRect();
    if(panel.width&&panel.height){const scene=this.surface.getBoundingClientRect();geometry.panel={left:panel.left-scene.left,top:panel.top-scene.top,right:panel.right-scene.left,bottom:panel.bottom-scene.top};}
    return geometry;
  }
  private fullyVisible(q:QuoteSnapshot,geometry:VisibilityGeometry=this.measureVisibilityGeometry()){
    const x=this.x(q.startMs),y=this.y(priceOf(q.upperPrice));
    if(!isWholeCellVisible(x,y,this.cell,{width:this.width,height:this.height,gutter:this.gutter,top:geometry.top,bottom:geometry.bottom}))return false;
    const panel=geometry.panel;if(panel&&x<panel.right&&x+this.cell>panel.left&&y<panel.bottom&&y+this.cell>panel.top)return false;
    return true;
  }
  // Input calls omit geometry and therefore measure fresh bounds; a render pass supplies its own snapshot.
  private canBet(q:QuoteSnapshot,geometry?:VisibilityGeometry){return !this.unavailableCells.has(q.cellId)&&!!this.state?.ready&&!this.exhausted(this.state)&&!this.overlayHost.childElementCount&&!this.walletDialog.open&&!this.phoneControls.open&&!this.options.inputBlocked?.()&&q.marketId===this.state.marketId&&q.validUntilMs>this.state.nowMs&&this.fullyVisible(q,geometry);}
  private fitOfferLabels(button:HTMLButtonElement){
    if(button.hidden)return;
    const available=Math.max(1,this.cell-6);
    for(const span of button.querySelectorAll<HTMLSpanElement>(':scope > span')){
      if(!span.getClientRects().length)continue;
      const previous=Number(span.dataset.fitScale)||1;
      const natural=span.getBoundingClientRect().width/previous;
      const scale=labelScale(natural,available);
      span.dataset.fitScale=String(scale);
      span.style.transform=scale<1?`scaleX(${scale})`:'none';
    }
    button.dataset.fitKey=this.cell+':'+button.dataset.textKey;
  }
  private x(time:number){return this.width*this.anchor+(time-this.cameraTime-this.timePan)/5000*this.cell;}
  private y(price:number){return this.height/2-(price-this.cameraPrice-this.pricePan)/(priceOf(getMarket(this.state?.marketId??DEMO_CONFIG.initialMarketId).bandHeight))*this.cell;}
  private frame(t:number){
    const elapsed=this.lastFrame?t-this.lastFrame:16;const dt=Math.min(100,elapsed);this.lastFrame=t;if(document.visibilityState==='visible'){this.frameTimes.push(elapsed);if(this.frameTimes.length>1800)this.frameTimes.shift();}
    const s=this.state;const latest=s?.samples.at(-1);
    if(latest&&s){this.cameraTime=advancePlayhead(this.cameraTime,latest.sourceTimeMs,s.nowMs+Math.max(0,t-this.stateReceivedAt),dt);this.displayedPrice=(s.pathMode==='linear'?linearPriceAt:displayPriceAt)(s.samples,this.cameraTime);const blend=1-Math.exp(-dt/320);this.cameraPrice+=(this.displayedPrice-this.cameraPrice)*blend;this.draw();if(t-this.lastOffers>160){this.refreshOffers();this.lastOffers=t;}this.positionElements();}
    this.renderer.render(this.scene,this.camera);this.animation=requestAnimationFrame(time=>this.frame(time));
  }
  private draw(){
    const s=this.state!;const band=priceOf(getMarket(s.marketId).bandHeight);const grid:number[]=[];const intersections:number[]=[];const vertical:number[]=[];const horizontal:number[]=[];
    const firstTime=Math.floor((this.cameraTime+this.timePan-this.width*this.anchor*5000/this.cell)/5000)*5000;
    for(let time=firstTime;this.x(time)<=this.width;time+=5000){const x=this.x(time);grid.push(x,0,0,x,this.height,0);vertical.push(x);}
    const low=Math.floor((this.cameraPrice+this.pricePan-this.height*.5/this.cell*band)/band)*band;
    for(let price=low;this.y(price)>=0;price+=band){const y=this.y(price);grid.push(0,y,0,this.width,y,0);horizontal.push(y);}
    this.updateBuffer(this.gridGeometry,this.gridBuffer,grid);
    for(const x of vertical)for(const y of horizontal)intersections.push(x,y,.2);
    this.updateBuffer(this.intersectionsGeometry,this.intersectionsBuffer,intersections);
    const trace:number[]=[],glow:number[]=[];
    const tipX=this.x(this.cameraTime);this.suppressedConnectors=0;
    const ribbon=(out:number[],ax:number,ay:number,bx:number,by:number,thickness:number,z:number)=>{
      const length=Math.hypot(bx-ax,by-ay);if(length<.001)return;
      const nx=-(by-ay)/length*thickness/2,ny=(bx-ax)/length*thickness/2;
      out.push(ax+nx,ay+ny,z,ax-nx,ay-ny,z,bx+nx,by+ny,z,bx+nx,by+ny,z,ax-nx,ay-ny,z,bx-nx,by-ny,z);
    };
    for(let i=0;i<s.samples.length-1;i++){
      const a=s.samples[i]!,b=s.samples[i+1]!;if(a.sourceTimeMs>=this.cameraTime)break;
      if(this.x(b.sourceTimeMs)<-20||this.x(a.sourceTimeMs)>this.width)continue;
      const span=b.sourceTimeMs-a.sourceTimeMs;if(span<=0||span>1500||(s.pathMode==='linear'&&span!==1000)){this.suppressedConnectors++;continue;}
      const end=Math.min(1,(this.cameraTime-a.sourceTimeMs)/span),steps=Math.max(1,Math.ceil(Math.abs(this.x(b.sourceTimeMs)-this.x(a.sourceTimeMs))*end/3));
      let ax=this.x(a.sourceTimeMs),ay=this.y(priceOf(a.price));
      for(let step=1;step<=steps;step++){const ratio=end*step/steps,bx=this.x(a.sourceTimeMs+span*ratio),by=this.y(s.pathMode==='linear'?priceOf(a.price)+(priceOf(b.price)-priceOf(a.price))*ratio:curvePrice(s.samples,i,ratio));ribbon(trace,ax,ay,bx,by,1.8,1);ribbon(glow,ax,ay,bx,by,6,0.8);ax=bx;ay=by;}
    }
    this.updateBuffer(this.traceGeometry,this.traceBuffer,trace);this.updateBuffer(this.glowGeometry,this.glowBuffer,glow);
    for(let i=0;i<Math.min(trace.length/3,this.traceColors.length/3);i++){const hot=Math.max(0,Math.min(1,1-(tipX-trace[i*3]!)/(this.cell*1.2)));this.traceColors[i*3]=.80+hot*.2;this.traceColors[i*3+1]=.32+hot*.62;this.traceColors[i*3+2]=.56+hot*.42;}
    this.traceGeometry.getAttribute('color').needsUpdate=true;
    this.tip.position.set(tipX,this.y(this.displayedPrice),2);this.tipGlow.position.copy(this.tip.position);
    const badge=this.axes.querySelector<HTMLElement>('.price-badge');if(badge){badge.style.top=this.y(this.displayedPrice)+'px';badge.textContent='$'+this.displayedPrice.toLocaleString('en-US',{minimumFractionDigits:1,maximumFractionDigits:1});}
  }
  private updateBuffer(geometry:THREE.BufferGeometry,buffer:Float32Array,values:number[]){const count=Math.min(buffer.length,values.length);buffer.set(values.slice(0,count));geometry.setDrawRange(0,count/3);geometry.getAttribute('position').needsUpdate=true;}
  private updateOfferLabel(button:HTMLButtonElement,quote:QuoteSnapshot){
    const multiplier=formatMultiplier(quote.grossX100).slice(0,-1);
    const stake=this.money(this.stakes[this.stakeIndex]!);
    const textKey=multiplier+':'+this.stakes[this.stakeIndex];
    if(button.dataset.textKey===textKey)return;
    button.dataset.textKey=textKey;
    if(!button.firstElementChild)button.innerHTML='<span class="quote-stake"></span><span></span>';
    button.firstElementChild!.textContent=stake;
    button.lastElementChild!.textContent=multiplier+'X';
    const digits=quote.marketId==='btc-usd'?0:2;
    button.setAttribute('aria-label',`${quote.marketId==='btc-usd'?'BTC':'ETH'} $${priceOf(quote.lowerPrice).toFixed(digits)} to $${priceOf(quote.upperPrice).toFixed(digits)}, ${new Date(quote.startMs).toLocaleTimeString()}, ${multiplier} times total return, stake ${stake}`);
  }
  private refreshOffers(){
    const s=this.state;if(!s)return;const band=priceOf(getMarket(s.marketId).bandHeight);const visible=new Set<string>();const now=s.nowMs;
    const visibility=this.measureVisibilityGeometry();
    const first=Math.floor((this.cameraTime+this.timePan-this.width*this.anchor*5000/this.cell)/5000)*5000;
    const low=Math.floor((this.cameraPrice+this.pricePan-this.height*.5/this.cell*band)/band);
    const high=Math.ceil((this.cameraPrice+this.pricePan+this.height*.5/this.cell*band)/band);
    if(s.ready&&!this.exhausted(s)){for(let start=first;this.x(start)+this.cell<=this.width-this.gutter;start+=5000){if(start<=now||this.x(start)<0)continue;for(let bucket=low;bucket<=high;bucket++){const y=this.y((bucket+1)*band);if(y<(this.profile==='desktop'?76:0)||y+this.cell>this.height-(this.profile==='desktop'?96:24))continue;const terms=this.options.makeCell(s.marketId,start,bucket);const quote=this.options.quoteFor(terms);if(!quote)continue;visible.add(quote.cellId);this.quoteByCell.set(quote.cellId,quote);let button=this.buttonByCell.get(quote.cellId);if(!button){button=document.createElement('button');button.className='offer';button.dataset.cellId=quote.cellId;button.tabIndex=this.buttonByCell.size===0?0:-1;this.buttonByCell.set(quote.cellId,button);this.offers.append(button);}this.unavailableCells.delete(quote.cellId);button.dataset.quoteState='ready';button.dataset.lastQuotedAt=String(performance.now());this.updateOfferLabel(button,quote);}}}
    for(const[id,button]of this.buttonByCell)if(!visible.has(id)){
      const previous=this.quoteByCell.get(id);
      // Keep a brief, disabled visual remnant through routine quote refresh gaps.
      // Its old quote is never selectable; closing windows disappear immediately.
      if(previous&&s.ready&&!this.exhausted(s)&&previous.startMs>s.nowMs+s.leadTimeS*1000&&this.fullyVisible(previous,visibility)&&performance.now()-Number(button.dataset.lastQuotedAt)<450){this.unavailableCells.add(id);button.dataset.quoteState='waiting';button.disabled=true;continue;}
      button.remove();this.buttonByCell.delete(id);this.quoteByCell.delete(id);this.unavailableCells.delete(id);
    }
    this.root.dataset.visibleQuotes=String(visible.size);
    this.renderCards();this.renderAxes();
  }
  private positionElements(){
    // Read shared geometry before any offer/card positions are written. Never reuse it across frames or input events.
    const visibility=this.measureVisibilityGeometry();
    const timeLabels=Array.from(this.axes.querySelectorAll<HTMLElement>('[data-time]'),label=>({label,half:Math.max(34,label.getBoundingClientRect().width/2)}));
    let visible=0;const labelsToFit:HTMLButtonElement[]=[];const cardLabelsToFit:{element:HTMLElement;key:string;texts:HTMLElement[]}[]=[];
    for(const[id,b]of this.buttonByCell){const q=this.quoteByCell.get(id)!;b.style.left=this.x(q.startMs)+'px';b.style.top=this.y(priceOf(q.upperPrice))+'px';b.style.width=this.cell+'px';b.style.height=this.cell+'px';b.hidden=!this.fullyVisible(q,visibility);b.disabled=!this.canBet(q,visibility);if(!b.hidden&&!b.disabled)visible++;if(!b.hidden&&b.dataset.fitKey!==this.cell+':'+b.dataset.textKey)labelsToFit.push(b);}
    this.root.dataset.visibleQuotes=String(visible);
    for(const [id,entry] of this.cardById){const p=entry.group,el=entry.element;el.style.left=this.x(p.startMs)+2+'px';el.style.top=this.y(priceOf(p.upperPrice))+2+'px';el.style.width=Math.max(1,this.cell-4)+'px';el.style.height=Math.max(1,this.cell-4)+'px';const fitKey=this.cell+':'+p.totalStakeCents+':'+p.totalPotentialReturnCents;if(el.dataset.fitKey!==fitKey)cardLabelsToFit.push({element:el,key:fitKey,texts:Array.from(el.querySelectorAll<HTMLElement>('b,span'))});if(entry.terminalAt===undefined){const phase=performance.now()-entry.born<430?'enter':this.cameraTime>=p.endMs?'recovering':this.cameraTime>=p.startMs?'active':'open';if(el.dataset.phase!==phase)el.dataset.phase=phase;}if(entry.terminalAt!==undefined&&performance.now()-entry.terminalAt>(p.status==='lost'?1200:1500)){el.remove();this.cardById.delete(id);this.retiredCards.add(id);}}
    for(const {element,play} of this.pendingCards.values()){element.style.left=this.x(play.startMs)+2+'px';element.style.top=this.y(priceOf(play.upperPrice))+2+'px';element.style.width=Math.max(1,this.cell-4)+'px';element.style.height=Math.max(1,this.cell-4)+'px';}
    this.presentResults();
    for(const id of this.feedback.activeIds()){const p=this.groups.get(id);if(p)this.feedback.reposition(id,this.x(p.startMs)+this.cell/2,this.y(priceOf(p.upperPrice))+this.cell/2,this.cell);}
    for(const label of this.axes.querySelectorAll<HTMLElement>('[data-price]:not(.price-badge)')){const y=this.y(Number(label.dataset.price));label.style.top=y+'px';label.hidden=y<(this.profile==='desktop'?76:12)||y>this.height-visibility.bottom;}
    for(const {label,half}of timeLabels){const x=this.x(Number(label.dataset.time));label.style.left=x+'px';label.hidden=x<half||x>this.width-half;}
    // New/changed text is measured in one batch after geometry writes, then transforms are applied together.
    const fits:{element:HTMLElement;scale:number;offer:boolean}[]=[];
    for(const button of labelsToFit)for(const span of button.querySelectorAll<HTMLSpanElement>(':scope > span')){if(!span.getClientRects().length)continue;const natural=span.getBoundingClientRect().width/(Number(span.dataset.fitScale)||1);fits.push({element:span,scale:labelScale(natural,Math.max(1,this.cell-6)),offer:true});}
    for(const entry of cardLabelsToFit)for(const text of entry.texts)fits.push({element:text,scale:Math.min(1,Math.max(1,this.cell-10)/Math.max(1,text.offsetWidth)),offer:false});
    for(const {element,scale,offer}of fits){if(offer)element.dataset.fitScale=String(scale);element.style.transform=offer&&scale>=1?'none':`scaleX(${scale})`;}
    for(const button of labelsToFit)button.dataset.fitKey=this.cell+':'+button.dataset.textKey;
    for(const entry of cardLabelsToFit)entry.element.dataset.fitKey=entry.key;
  }
  private resultTime(group:PositionGroup){
    if(group.status==='won')return Math.max(...group.positions.map(p=>(p as PositionSnapshot&{touchTimeMs?:number}).touchTimeMs??(Number(p.evidenceSampleIds?.[0]?.split(':').at(-1))||group.endMs)));
    return group.endMs;
  }
  private renderCards(){
    const s=this.state;if(!s)return;const now=performance.now();const groups=groupPositions(s.positions);this.groups=new Map(groups.map(g=>[g.groupId,g]));
    for(const [id,entry] of this.cardById)if(entry.group.marketId!==s.marketId){entry.element.remove();this.cardById.delete(id);}
    for(const group of groups){
      const id=group.groupId,previous=this.seenGroups.get(id);this.seenGroups.set(id,{status:group.status,count:group.count});
      if(previous?.status==='open'&&group.status!=='open')this.pendingResults.set(id,group);
      if(group.marketId!==s.marketId)continue;
      let entry=this.cardById.get(id);const added=group.status==='open'&&group.count>(previous?.count??0);
      if(this.retiredCards.has(id))continue;
      if(!entry&&(group.status==='open'||this.pendingResults.has(id))){
        const element=document.createElement('div');element.className='position-card';element.dataset.positionId=group.positions[0]!.positionId;element.dataset.cellId=id;
        element.innerHTML='<b></b><span></span>';element.setAttribute('role','img');
        entry={element,group,born:added?now:now-500};this.cardById.set(id,entry);this.cards.append(element);
      }
      if(entry){
        entry.group=group;const el=entry.element;el.dataset.betCount=String(group.count);
        el.querySelector('b')!.textContent=this.money(group.totalStakeCents);
        el.querySelector('span')!.textContent=group.count===1?formatMultiplier(group.positions[0]!.grossX100).slice(0,-1)+'X':this.money(group.totalPotentialReturnCents)+' return';
        el.setAttribute('aria-label',`${group.count} ${group.count===1?'bet':'bets'}, total stake ${this.money(group.totalStakeCents)}, locked total return ${this.money(group.totalPotentialReturnCents)}`);
        el.title=el.getAttribute('aria-label')!;
        if(added&&previous&&group.count>previous.count&&!this.reducedMotion){el.querySelector('b')!.animate([{transform:'scale(1)'},{transform:'scale(1.28)',color:'#fff'},{transform:'scale(1)',color:'#25300b'}],{duration:360,easing:'cubic-bezier(.2,.75,.2,1)'});el.animate([{filter:'brightness(1)'},{filter:'brightness(1.35)'},{filter:'brightness(1)'}],{duration:320});}
      }
      if(added)this.feedback.emit({id,kind:'place',x:this.x(group.startMs)+this.cell/2,y:this.y(priceOf(group.upperPrice))+this.cell/2,size:this.cell});
    }
  }
  private presentResults(){
    const ordered=[...this.pendingResults.values()].sort((a,b)=>this.resultTime(a)-this.resultTime(b)||a.startMs-b.startMs);
    for(const group of ordered){
      const selected=group.marketId===this.state?.marketId;
      if(selected&&(group.status==='won'||group.status==='lost')&&this.cameraTime<this.resultTime(group))continue;
      this.pendingResults.delete(group.groupId);
      if(group.status==='won')this.winStreak++;else if(group.status==='lost'||group.status==='mixed')this.winStreak=0;
      const kind=group.status==='won'?'win':group.status==='lost'?'loss':'refund';
      const entry=this.cardById.get(group.groupId);
      if(entry){entry.terminalAt=performance.now();entry.element.dataset.status=group.status;entry.element.dataset.phase=group.status==='mixed'?'refunded':group.status;}
      else this.retiredCards.add(group.groupId);
      if(selected)this.feedback.emit({id:group.groupId,kind,amountCents:group.totalActualReturnCents,streak:this.winStreak,x:this.x(group.startMs)+this.cell/2,y:this.y(priceOf(group.upperPrice))+this.cell/2,size:this.cell});
      const pair=group.marketId==='btc-usd'?'BTC/USD':'ETH/USD';this.toast(kind==='win'?`${pair} · You won ${this.money(group.totalActualReturnCents)}${this.winStreak>1?' · '+this.winStreak+' win streak':''}`:kind==='loss'?`${pair} · The price missed your square.`:`${pair} · ${this.money(group.totalActualReturnCents)} returned.`,kind==='win');
    }
  }
  private renderAxes(){
    const s=this.state!, band=priceOf(getMarket(s.marketId).bandHeight);
    const priceStep=band*Math.max(1,Math.ceil((this.profile==='desktop'?26:22)/this.cell));
    const timeStep=15000*Math.max(1,Math.ceil(68/(this.cell*3)));
    const low=Math.floor((this.cameraPrice+this.pricePan-this.height*.5/this.cell*band)/priceStep)*priceStep;
    const first=Math.floor((this.cameraTime+this.timePan-this.width*this.anchor*5000/this.cell)/timeStep)*timeStep;
    const latest=s.samples.at(-1);
    const key=[s.marketId,low,first,this.width,this.height,this.zoom,latest?.sampleId,latest?.price.coefficient,latest?.price.exponent].join(':');
    if(key===this.axesKey)return;this.axesKey=key;
    const fragment=document.createDocumentFragment();
    for(let price=low;this.y(price)>=0;price+=priceStep){const label=document.createElement('span');label.className='axis-price';label.dataset.price=String(price);label.textContent='$'+price.toLocaleString('en-US',{minimumFractionDigits:s.marketId==='btc-usd'?0:1,maximumFractionDigits:s.marketId==='btc-usd'?0:1});fragment.append(label);}
    for(let time=first;this.x(time)<=this.width;time+=timeStep){const label=document.createElement('span');label.className='axis-time';label.dataset.time=String(time);label.textContent=new Date(time).toLocaleTimeString('en-US',{hour12:false});fragment.append(label);}
    if(latest){const badge=document.createElement('span');badge.className='price-badge';badge.dataset.price=String(this.displayedPrice);badge.style.top=this.y(this.displayedPrice)+'px';badge.textContent='$'+this.displayedPrice.toLocaleString('en-US',{minimumFractionDigits:1,maximumFractionDigits:1});fragment.append(badge);}this.axes.replaceChildren(fragment);
  }
  private renderResults(){const rows=this.state?.positions.slice(0,5)??[];const container=this.el('.result-items');container.replaceChildren();if(!rows.length){const p=document.createElement('div');p.className='result-row';p.textContent='Your first play starts with a square.';container.append(p);}for(const p of rows){const row=document.createElement('div');row.className='result-row';row.dataset.status=p.status;const name=document.createElement('span');name.textContent=`${p.marketId==='btc-usd'?'BTC':'ETH'} · ${this.money(p.stakeCents)} · ${p.status==='open'?'in play':p.status}`;const result=document.createElement('b');result.textContent=p.status==='won'?'+'+this.money(p.grossReturnCents):p.status==='refunded'?this.money(p.stakeCents):p.status==='lost'?this.money('0'):formatMultiplier(p.grossX100).slice(0,-1)+'X';row.append(name,result);container.append(row);}}
  dispose(){this.disposed=true;cancelAnimationFrame(this.animation);this.resizeObserver.disconnect();for(const dispose of this.disposeCallbacks)dispose();this.feedback.dispose();this.cardById.clear();this.pendingCards.clear();this.gridGeometry.dispose();this.traceGeometry.dispose();this.glowGeometry.dispose();this.tipGlow.geometry.dispose();this.dotsGeometry.dispose();this.intersectionsGeometry.dispose();this.tip.geometry.dispose();this.scene.traverse(o=>{if(o instanceof THREE.Mesh||o instanceof THREE.LineSegments||o instanceof THREE.Points){const m=o.material;if(Array.isArray(m))m.forEach(x=>x.dispose());else m.dispose();}});this.renderer.dispose();this.root.remove();}
}
