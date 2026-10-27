export interface LayoutBox { left:number; top:number; width:number; height:number }
type LayoutProfile = 'desktop' | 'tablet' | 'mobile';

/** Reserve measured chrome, keeping canonical board geometry independent of device pixels. */
export function measureLayout(root:HTMLElement, profile:LayoutProfile, outerWidth:number, outerHeight:number):LayoutBox {
  const put = (name:string, value:number) => {
    const cssValue = `${Math.round(value * 100) / 100}px`;
    if(root.style.getPropertyValue(name)!==cssValue)root.style.setProperty(name,cssValue);
  };
  root.dataset.profile=profile;
  root.dataset.short=String(outerHeight<500&&outerWidth>outerHeight);
  put('--viewport-height',outerHeight);
  put('--viewport-width',outerWidth);
  let probe=root.querySelector<HTMLElement>(':scope > .safe-area-probe');
  if(!probe){probe=document.createElement('div');probe.className='safe-area-probe';probe.setAttribute('aria-hidden','true');root.append(probe);}
  const padding=getComputedStyle(probe);
  const safe={top:parseFloat(padding.paddingTop)||0,right:parseFloat(padding.paddingRight)||0,bottom:parseFloat(padding.paddingBottom)||0,left:parseFloat(padding.paddingLeft)||0};
  const usableWidth=Math.max(1,outerWidth-safe.left-safe.right);
  root.dataset.narrow=String(usableWidth<366);
  root.dataset.compactWrap=String(usableWidth<546);
  root.dataset.exhausted=String(!!root.querySelector('.refresh-button'));
  const origin=root.getBoundingClientRect();
  const bounds=(selector:string)=>{
    const element=root.querySelector<HTMLElement>(selector);
    if(!element||!element.getClientRects().length)return undefined;
    const rect=element.getBoundingClientRect();
    return {top:rect.top-origin.top,bottom:rect.bottom-origin.top,height:rect.height};
  };
  const header=bounds('.header');
  put('--header-bottom',header?.bottom??safe.top+58);
  const status=bounds('.status-line');
  put('--status-bottom',status?.bottom??header?.bottom??58);
  const phone=root.dataset.phone==='true';
  const footer=bounds(phone?'.phone-thumb-bar':'.bottom-bar');
  const footerTop=footer?.top??outerHeight-safe.bottom;
  put('--footer-space',Math.max(safe.bottom,outerHeight-footerTop));
  put('--footer-top',footerTop);
  const navigation=bounds('.navigation-row');
  const hint=bounds('.board-hint');
  const help=bounds('.help-button');
  const short=root.dataset.short==='true';
  const headerBottom=Math.max(safe.top,header?.bottom??0,status?.bottom??0,hint?.bottom??0,help?.bottom??0,short?(navigation?.bottom??0):0);
  put('--results-top',headerBottom+12);
  if(profile==='desktop'){
    put('--chrome-top',headerBottom+10);
    return {left:safe.left,top:safe.top,width:usableWidth,height:Math.max(50,outerHeight-safe.top-safe.bottom)};
  }
  // Recent plays float over the chart; opening or adding rows never shrinks the board.
  const top=headerBottom+10;
  const bottom=Math.min(footerTop,short?footerTop:(navigation?.top??footerTop))-8;
  put('--chrome-top',top);
  return {left:safe.left,top,width:usableWidth,height:Math.max(50,bottom-top)};
}
