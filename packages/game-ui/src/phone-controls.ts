import { PAPER_PRESENTATION, phoneAccountMarkup, phoneBarMarkup, phoneDialogMarkup, type GamePresentation } from './presentation.js';

type Panel = 'menu' | 'stake' | 'zoom' | 'balance' | 'help';

/** Phone chrome shares the existing action/acceptance handlers; it owns no ledger or pricing state. */
export class PhoneControls {
  readonly dialog: HTMLDialogElement;
  private origin?: HTMLElement;
  private count = -1;
  constructor(private root: HTMLElement, private cancelGesture: () => void, private p: GamePresentation = PAPER_PRESENTATION) {
    const account = document.createElement('div');
    account.className = 'phone-account';
    account.innerHTML = phoneAccountMarkup(p);
    root.querySelector('.header')!.append(account);
    const allowance = document.createElement('div');
    allowance.className = 'phone-allowance';
    root.append(allowance);
    const bar = document.createElement('footer');
    bar.className = 'phone-thumb-bar';
    bar.setAttribute('aria-label', 'Trading controls');
    bar.innerHTML = phoneBarMarkup(p);
    root.append(bar);
    this.dialog = document.createElement('dialog');
    this.dialog.id = 'phone-controls';
    this.dialog.className = 'phone-controls-dialog';
    this.dialog.setAttribute('aria-labelledby', 'phone-controls-title');
    this.dialog.innerHTML = phoneDialogMarkup(p);
    root.append(this.dialog);
    this.dialog.addEventListener('close', () => {
      root.querySelectorAll('[data-action^="phone-"][aria-expanded]').forEach(button=>button.setAttribute('aria-expanded','false'));
      if (root.dataset.phone === 'true' && !root.querySelector('.overlay-host')?.childElementCount && this.origin?.isConnected) this.origin.focus({preventScroll:true});
    });
    this.dialog.addEventListener('click', event => {
      const rect=this.dialog.getBoundingClientRect();
      if(event.target===this.dialog&&(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom))this.close();
    });
  }
  get open(){return this.dialog.open;}
  close(){if(this.dialog.open)this.dialog.close();}
  handleAction(action:string, target:HTMLElement):boolean {
    if(action==='phone-close'){this.close();return true;}
    if(!action.startsWith('phone-'))return false;
    const panel=action.slice(6) as Panel;
    if(!['menu','stake','zoom','balance','help'].includes(panel))return false;
    if(this.root.dataset.phone!=='true')return true;
    this.cancelGesture();
    if(!this.dialog.contains(target))this.origin=target;
    this.dialog.querySelector('h2')!.textContent={menu:'Game controls',stake:'Choose your stake',zoom:'Adjust the chart',balance:this.p.phone.balanceTitle,help:'How to play'}[panel];
    for(const section of this.dialog.querySelectorAll<HTMLElement>('[data-phone-section]'))section.hidden=section.dataset.phoneSection!==panel&&!(panel==='menu'&&['stake','zoom'].includes(section.dataset.phoneSection!));
    this.dialog.querySelector<HTMLElement>('.phone-done')!.hidden=panel==='menu';
    if(!this.dialog.open)this.dialog.showModal();
    target.setAttribute('aria-expanded','true');
    this.dialog.querySelector<HTMLButtonElement>(panel==='stake'?'[data-stake-index][aria-pressed=true]':'[data-action=phone-close]')!.focus({preventScroll:true});
    return true;
  }
  update(stakeIndex:number, zoom:number, balance:string, acceptedCount:number){
    const setText=(selector:string,value:string)=>this.root.querySelectorAll<HTMLElement>(selector).forEach(el=>{if(el.textContent!==value)el.textContent=value;});
    setText('[data-phone-stake]',this.p.formatMoney(this.p.stakes[stakeIndex]!));
    setText('[data-phone-zoom]',zoom.toFixed(3).replace(/0+$/,'').replace(/\.$/,'')+'×');
    setText('.phone-balance',this.p.formatMoney(balance));
    for(const button of this.dialog.querySelectorAll<HTMLButtonElement>('[data-stake-index]'))button.setAttribute('aria-pressed',String(Number(button.dataset.stakeIndex)===stakeIndex));
    const limit=this.p.playLimit;
    if(limit!==null&&this.count!==acceptedCount){
      if(this.count<limit&&acceptedCount>=limit)this.close();
      this.count=acceptedCount;
      this.root.querySelector('.phone-allowance')!.textContent=acceptedCount>=limit?`${limit} plays complete`:`${limit-acceptedCount} plays left`;
      this.dialog.querySelector<HTMLElement>('[data-phone-reload]')!.hidden=acceptedCount<limit;
    }
  }
}
