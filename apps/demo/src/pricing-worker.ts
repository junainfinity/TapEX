import { TouchProbabilityModel, type ModelInputs, type PreviewResult } from '@maya/pricing';

type Request = { kind:'initialize'; table:unknown } | { kind:'calculate'; jobs:{key:string;input:ModelInputs}[] };
let model:TouchProbabilityModel|undefined;
self.addEventListener('message',(event:MessageEvent<Request>)=>{
  const message=event.data;
  if(message.kind==='initialize'){
    try{model=new TouchProbabilityModel(message.table);self.postMessage({kind:'ready'});}
    catch{self.postMessage({kind:'failed'});}
    return;
  }
  if(!model){self.postMessage({kind:'failed'});return;}
  const results=message.jobs.map(({key,input})=>{
    let result:PreviewResult;
    try{result=model!.previewLinear(input);}catch{result={available:false,reason:'unsafe-numeric-range'};}
    return {key,result};
  });
  self.postMessage({kind:'results',results});
});
