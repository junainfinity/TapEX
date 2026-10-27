import type { ModelInputs, PreviewResult } from '@maya/pricing';

/** Pure numerical previews only. The main-thread quote registry and ledger own acceptance. */
export class BackgroundPricing {
  private readonly worker:Worker;
  private readonly cache=new Map<string,PreviewResult>();
  private readonly pending=new Set<string>();
  private jobs:{key:string;input:ModelInputs}[]=[];
  private flushTimer:ReturnType<typeof setTimeout>|undefined;
  private disposed=false;
  ready=false;
  failed=false;
  constructor(table:unknown){
    this.worker=new Worker(new URL('./pricing-worker.ts',import.meta.url),{type:'module'});
    this.worker.addEventListener('message',(event:MessageEvent)=>{
      if(this.disposed)return;
      if(event.data.kind==='ready'){this.ready=true;return;}
      if(event.data.kind==='failed'){this.fail();return;}
      if(event.data.kind!=='results')return;
      for(const {key,result}of event.data.results as {key:string;result:PreviewResult}[]){this.pending.delete(key);this.cache.set(key,result);}
      while(this.cache.size>2048)this.cache.delete(this.cache.keys().next().value!);
    });
    this.worker.addEventListener('error',()=>this.fail());
    this.worker.postMessage({kind:'initialize',table});
  }
  preview=(input:ModelInputs):PreviewResult|undefined=>{
    if(this.failed||this.disposed)return undefined;
    // Every numeric model input participates, so late responses cannot price a newer path/config.
    const key=JSON.stringify(input),cached=this.cache.get(key);
    if(cached)return cached;
    if(!this.pending.has(key)&&this.pending.size<1024){
      this.pending.add(key);this.jobs.push({key,input});
      this.flushTimer??=setTimeout(()=>{this.flushTimer=undefined;const jobs=this.jobs;this.jobs=[];if(!this.disposed&&!this.failed)this.worker.postMessage({kind:'calculate',jobs});},0);
    }
    return undefined;
  };
  private fail(){this.failed=true;this.ready=false;this.pending.clear();this.jobs=[];}
  dispose(){this.disposed=true;if(this.flushTimer!==undefined)clearTimeout(this.flushTimer);this.worker.terminate();this.pending.clear();this.cache.clear();this.jobs=[];}
}
