import type { PaperEnginePort } from '@maya/contracts';
import { DEMO_CONFIG } from '@maya/config';

export interface ConsultationView { overlayHost: HTMLElement; cancelGesture(): void; focusResults(): void }

/** One controller per document. Layout changes never create a new offer or allowance. */
export class ConsultationController {
  private presented = false;
  private presenting = false;
  private dismissed = false;
  private disposed = false;
  private acknowledging = false;
  private presentationId = crypto.randomUUID();
  private pageLoadId: string;
  private unsubscribe: () => void;
  private dialog?: HTMLElement;
  private ackTimer?: ReturnType<typeof setTimeout>;
  private presentationTimer?: ReturnType<typeof setTimeout>;
  constructor(private engine: PaperEnginePort, private view: ConsultationView) {
    this.pageLoadId = engine.getAllowance().pageLoadId;
    this.unsubscribe = engine.subscribe(()=>this.reconcile());
    this.reconcile();
  }
  private reconcile(){
    const allowance=this.engine.getAllowance();
    if(this.disposed||allowance.pageLoadId!==this.pageLoadId||allowance.acceptedCount!==DEMO_CONFIG.maxNewBetsPerPage||allowance.offerShown||this.presenting)return;
    if(this.presented){this.acknowledge();return;}
    this.presenting=true;
    queueMicrotask(()=>{
      try{
        if(this.disposed||this.dismissed||this.engine.getAllowance().offerShown)return;
        // A queued duplicate mount cannot open another offer while its owner acknowledges.
        if(Array.from(this.view.overlayHost.querySelectorAll<HTMLElement>('[data-maya-offer-page]')).some(element=>element.dataset.mayaOfferPage===this.pageLoadId))return;
        this.show();this.presented=true;this.acknowledge();
      }
      catch(error){console.warn('Consultation presentation deferred',error);this.dialog?.dispatchEvent(new Event('maya-close'));this.dialog?.remove();this.dialog=undefined;clearTimeout(this.presentationTimer);if(!this.disposed)this.presentationTimer=setTimeout(()=>this.reconcile(),250);}
      finally{this.presenting=false;}
    });
  }
  private acknowledge(){
    const allowance=this.engine.getAllowance();
    if(this.disposed||!this.presented||this.acknowledging||allowance.offerShown||allowance.pageLoadId!==this.pageLoadId)return;
    this.acknowledging=true;
    try{this.engine.acknowledgeOfferShown({pageLoadId:this.pageLoadId,presentationId:this.presentationId});clearTimeout(this.ackTimer);}
    catch(error){console.warn('Consultation acknowledgement deferred',error);clearTimeout(this.ackTimer);if(!this.disposed)this.ackTimer=setTimeout(()=>this.acknowledge(),500);}
    finally{this.acknowledging=false;}
  }
  private show(){
    if(this.dismissed||this.dialog)return;
    if(!this.view.overlayHost.isConnected)throw new Error('Consultation host is detached.');
    this.view.cancelGesture();
    const backdrop=document.createElement('div');backdrop.className='dialog-backdrop';backdrop.dataset.mayaOfferPage=this.pageLoadId;
    backdrop.innerHTML=`<section class="consultation" role="dialog" aria-modal="true" aria-labelledby="offer-title" aria-describedby="offer-description"><button class="dialog-close" aria-label="Close consultation offer" data-offer="close">×</button><div class="dialog-eyebrow">THE MAYA EXPERIENCE</div><h1 id="offer-title" tabindex="-1"></h1><p id="offer-description"></p><div class="offer-inclusions"><span>Your brand & experience</span><span>Custom integrations</span><span>Launch support</span><span>Full project source</span></div><a class="book-button" data-offer="book" target="_blank" rel="noopener noreferrer"><span></span><span aria-hidden="true">↗</span></a><button class="results-button" data-offer="close"></button><p class="dialog-footer"></p></section>`;
    backdrop.querySelector('h1')!.textContent=DEMO_CONFIG.consultationTitle;
    backdrop.querySelector('#offer-description')!.textContent=DEMO_CONFIG.consultationBody;
    const anchor=backdrop.querySelector<HTMLAnchorElement>('a')!;anchor.href=DEMO_CONFIG.consultationUrl;anchor.querySelector('span')!.textContent=DEMO_CONFIG.consultationAction;
    backdrop.querySelector('.results-button')!.textContent=DEMO_CONFIG.consultationSecondary;
    backdrop.querySelector('.dialog-footer')!.textContent=DEMO_CONFIG.consultationSupport;
    let pressedAction:HTMLElement|null=null;
    let pointerOrigin:{id:number;x:number;y:number}|undefined;
    const cancel=()=>{pressedAction=null;pointerOrigin=undefined;};
    backdrop.addEventListener('pointerdown',event=>{
      if(pointerOrigin){cancel();return;}
      pressedAction=(event.target as HTMLElement).closest<HTMLElement>('[data-offer]');
      pointerOrigin={id:event.pointerId,x:event.clientX,y:event.clientY};
    });
    backdrop.addEventListener('pointermove',event=>{if(pointerOrigin&&(event.pointerId!==pointerOrigin.id||Math.hypot(event.clientX-pointerOrigin.x,event.clientY-pointerOrigin.y)>8))cancel();});
    backdrop.addEventListener('pointercancel',cancel);
    backdrop.addEventListener('click',event=>{
      const action=(event.target as HTMLElement).closest<HTMLElement>('[data-offer]');if(!action)return;
      if(event.detail>0&&pressedAction!==action){cancel();event.preventDefault();event.stopImmediatePropagation();return;}
      cancel();
      if(action.dataset.offer==='close'){event.preventDefault();this.close();}
    },true);
    backdrop.addEventListener('keydown',event=>{
      if(event.repeat&&(event.key==='Enter'||event.key===' ')){event.preventDefault();event.stopImmediatePropagation();return;}
      if(event.key==='Escape'){event.preventDefault();this.close();return;}
      if(event.key==='Tab'){
        const controls=Array.from(backdrop.querySelectorAll<HTMLElement>('button,a[href]'));
        const index=controls.indexOf(document.activeElement as HTMLElement);
        if(event.shiftKey&&(index<=0)){event.preventDefault();controls.at(-1)?.focus();}
        else if(!event.shiftKey&&(index===controls.length-1||index<0)){event.preventDefault();controls[0]?.focus();}
      }
    });
    // Invalidate a pressed CTA if rotation or a viewport change moves it.
    const pointerCapability=matchMedia('(pointer: coarse)');
    window.addEventListener('resize',cancel);window.addEventListener('orientationchange',cancel);window.addEventListener('blur',cancel);
    visualViewport?.addEventListener('resize',cancel);pointerCapability.addEventListener('change',cancel);
    backdrop.addEventListener('maya-close',()=>{
      window.removeEventListener('resize',cancel);window.removeEventListener('orientationchange',cancel);window.removeEventListener('blur',cancel);
      visualViewport?.removeEventListener('resize',cancel);pointerCapability.removeEventListener('change',cancel);
    },{once:true});
    this.dialog=backdrop;this.view.overlayHost.append(backdrop);
    backdrop.querySelector<HTMLElement>('h1')!.focus({preventScroll:true});
    const heading=backdrop.querySelector<HTMLElement>('h1')!;
    if(!backdrop.getBoundingClientRect().width||!backdrop.getBoundingClientRect().height||document.activeElement!==heading)throw new Error('Consultation is not visible and focused.');
  }
  close(){this.dismissed=true;this.dialog?.dispatchEvent(new Event('maya-close'));this.dialog?.remove();this.dialog=undefined;this.view.focusResults();}
  dispose(){this.disposed=true;this.unsubscribe();clearTimeout(this.ackTimer);clearTimeout(this.presentationTimer);this.dialog?.dispatchEvent(new Event('maya-close'));this.dialog?.remove();this.dialog=undefined;}
}
