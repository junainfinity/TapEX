import { gaussLegendre, type SampledProbabilityInput, type SampledProbabilityResult } from './sampled-probability.js';

const inverseRootTau=1/Math.sqrt(2*Math.PI);
const cache=new Map<string,number>();

/** Survival below a barrier at all six Gaussian observations. A linear path
 * cannot cross the band and return without one of its adjoining segments hitting. */
function below(barrier:number,delta:number,count:number,requestedOrder?:number):number {
  const key=`${barrier}:${delta}:${count}:${requestedOrder??0}`;
  const existing=cache.get(key);if(existing!==undefined)return existing;
  const radius=10*Math.sqrt(1+(count-1)*delta);
  if(barrier<=-radius)return 0;if(barrier>=radius)return 1;
  const width=barrier+radius,order=requestedOrder??Math.min(256,Math.max(64,Math.ceil(32+2*width/Math.sqrt(delta))));
  const {nodes,weights}=gaussLegendre(order),x=new Float64Array(order),w=new Float64Array(order);
  for(let i=0;i<order;i++){x[i]=-radius+width*(nodes[i]!+1)/2;w[i]=weights[i]!*width/2;}
  let density=Float64Array.from(x,v=>inverseRootTau*Math.exp(-v*v/2));
  const kernel=new Float64Array(order*order),factor=inverseRootTau/Math.sqrt(delta);
  for(let i=0;i<order;i++)for(let j=0;j<order;j++)kernel[i*order+j]=w[j]!*factor*Math.exp(-((x[i]!-x[j]!)**2)/(2*delta));
  for(let step=1;step<count;step++){
    const next=new Float64Array(order);
    for(let i=0;i<order;i++){let sum=0;for(let j=0;j<order;j++)sum+=kernel[i*order+j]!*density[j]!;next[i]=sum;}
    density=next;
  }
  let result=0;for(let i=0;i<order;i++)result+=density[i]!*w[i]!;
  if(!Number.isFinite(result)||result<0||result>1+1e-7)throw Error('Linear path quadrature did not converge');
  result=Math.min(1,result);if(cache.size>4096)cache.clear();cache.set(key,result);return result;
}

/** Probability of the same piecewise-linear path event used by the paper engine.
 * Includes the final segment ending at the deadline. A touch at exactly the
 * exclusive endpoint has probability zero under the continuous Gaussian model. */
export function linearBandProbability(p:SampledProbabilityInput):SampledProbabilityResult {
  if(![p.zLower,p.zUpper,p.timeToStartS,p.windowS,p.observationIntervalS].every(Number.isFinite)||p.zUpper<p.zLower||p.timeToStartS<=0||p.windowS<=0||p.observationIntervalS<=0)throw Error('Invalid linear path model input');
  const intervals=p.windowS/p.observationIntervalS;
  if(!Number.isInteger(intervals)||intervals<1||intervals>10)throw Error('Unsupported linear path interval count');
  if(p.order!==undefined&&(!Number.isInteger(p.order)||p.order<16||p.order>768))throw Error('Unsupported quadrature order');
  const observationCount=intervals+1,delta=p.observationIntervalS/p.timeToStartS;
  const probability=1-below(p.zLower,delta,observationCount,p.order)-below(-p.zUpper,delta,observationCount,p.order);
  if(probability < -1e-7 || probability > 1+1e-7 || !Number.isFinite(probability))throw Error('Invalid linear path probability');
  return {probability:Math.max(0,Math.min(1,probability)),observationCount,quadratureOrder:p.order??256,maxNegativeDensity:0};
}
