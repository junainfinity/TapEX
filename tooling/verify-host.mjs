import { mkdir,writeFile } from 'node:fs/promises';
const origin=process.argv[2]??'http://127.0.0.1:8080';
const results=[];
for(const path of ['/health','/','/api/config','/api/prices/1','/api/prices/2','/api/table']){
  const start=performance.now();
  try{const r=await fetch(origin+path,{cache:'no-store',signal:AbortSignal.timeout(20000)});const raw=await r.text();
    const body=path==='/'?undefined:JSON.parse(raw);
    results.push({path,status:r.status,bytes:Buffer.byteLength(raw),elapsedMs:Math.round(performance.now()-start),upstreamDate:r.headers.get('x-maya-upstream-date'),upstreamRtt:r.headers.get('x-maya-upstream-rtt-ms'),upstreamAge:r.headers.get('x-maya-upstream-age-ms'),json:!!body,pass:r.ok&&(path==='/'?raw.includes('<title>Maya'):!!body)});
  }catch(error){results.push({path,pass:false,error:String(error)});}
}
const forbidden=await fetch(origin+'/api/not-a-route');results.push({path:'/api/not-a-route',status:forbidden.status,pass:forbidden.status===404});
const method=await fetch(origin+'/api/config',{method:'POST'});results.push({path:'POST /api/config',status:method.status,pass:method.status===405});
const report={checkedUtc:new Date().toISOString(),kind:'actual HTTP container/source proof; not browser/model correctness',origin,results,pass:results.every(r=>r.pass)};
await mkdir('artifacts/verification/n6',{recursive:true});
await writeFile('artifacts/verification/n6/host-http-'+Date.now()+'.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));if(!report.pass)process.exitCode=1;
