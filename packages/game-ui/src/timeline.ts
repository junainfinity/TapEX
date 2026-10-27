import { decimalToNumber, type PriceSample } from '@maya/contracts';

/** Presentation clock only. Never extrapolates beyond an observed source timestamp. */
export function advancePlayhead(current: number, latest: number, clock: number, elapsed: number): number {
  const target=Math.min(latest,clock-1500);
  if(!current||target-current>5000)return target;
  const headroom=Math.max(0,latest-current);
  if(headroom<.01)return latest;
  const frameMs=Math.min(100,Math.max(0,elapsed));
  const speed=Math.max(.85,Math.min(1.15,1+(target-current)/4000));
  // Polls can arrive more than a second apart. Ease through the final observed
  // 450 ms instead of consuming all headroom and freezing before each response.
  // This advances only inside known history; an actual outage still settles at
  // the final observation, and the clock never predicts the next source price.
  const bufferedStep=headroom*-Math.expm1(-frameMs/450);
  return Math.min(latest,Math.max(current,current+Math.min(frameMs*speed,bufferedStep)));
}

/** Monotone Hermite interpolation for drawing: passes through observations without price overshoot. */
export function curvePrice(samples: readonly PriceSample[], index: number, ratio: number): number {
  const a=samples[index]!,b=samples[index+1];if(!b)return decimalToNumber(a.price);
  const start=decimalToNumber(a.price),end=decimalToNumber(b.price),span=b.sourceTimeMs-a.sourceTimeMs;
  if(span<=0||span>1500)return ratio<1?start:end;
  const delta=(end-start)/span;if(delta===0)return start;
  const prev=samples[index-1],next=samples[index+2];
  const before=prev&&a.sourceTimeMs-prev.sourceTimeMs<=1500?(start-decimalToNumber(prev.price))/(a.sourceTimeMs-prev.sourceTimeMs):delta;
  const after=next&&next.sourceTimeMs-b.sourceTimeMs<=1500?(decimalToNumber(next.price)-end)/(next.sourceTimeMs-b.sourceTimeMs):delta;
  let m0=before*delta<=0?0:(before+delta)/2;
  let m1=after*delta<=0?0:(after+delta)/2;
  if(m0/delta<0)m0=0;if(m1/delta<0)m1=0;
  const norm=(m0/delta)**2+(m1/delta)**2;if(norm>9){const scale=3/Math.sqrt(norm);m0*=scale;m1*=scale;}
  const t=Math.max(0,Math.min(1,ratio)),t2=t*t,t3=t2*t;
  return (2*t3-3*t2+1)*start+(t3-2*t2+t)*span*m0+(-2*t3+3*t2)*end+(t3-t2)*span*m1;
}

export function displayPriceAt(samples: readonly PriceSample[], time: number): number {
  if(!samples.length)return 0;
  for(let i=samples.length-2;i>=0;i--){const a=samples[i]!,b=samples[i+1]!;if(time>=a.sourceTimeMs)return curvePrice(samples,i,(time-a.sourceTimeMs)/(b.sourceTimeMs-a.sourceTimeMs));}
  return decimalToNumber(samples[0]!.price);
}

/** The v2 game path is exactly the straight connector settled by the engine. */
export function linearPriceAt(samples:readonly PriceSample[], time:number):number {
  if(!samples.length)return 0;
  for(let i=samples.length-2;i>=0;i--){const a=samples[i]!,b=samples[i+1]!;if(time<a.sourceTimeMs)continue;
    const ratio=Math.max(0,Math.min(1,(time-a.sourceTimeMs)/(b.sourceTimeMs-a.sourceTimeMs)));
    if(b.sourceTimeMs-a.sourceTimeMs!==1000)return ratio<1?decimalToNumber(a.price):decimalToNumber(b.price);
    return decimalToNumber(a.price)+(decimalToNumber(b.price)-decimalToNumber(a.price))*ratio;
  }
  return decimalToNumber(samples[0]!.price);
}
