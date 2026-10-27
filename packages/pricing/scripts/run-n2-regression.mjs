import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const dir=resolve('artifacts/verification/n2');mkdirSync(dir,{recursive:true});
const commands=[
  'pnpm --filter @maya/market-data build',
  'pnpm --filter @maya/pricing build',
  'pnpm --filter @maya/market-data test:unit',
  'pnpm --filter @maya/pricing test:unit',
  'node --test apps/feed-relay/test/server.test.mjs',
  'node packages/pricing/scripts/check-sampled-event.mjs artifacts/verification/n2/live-capture',
  'node packages/pricing/scripts/replay-availability.mjs artifacts/verification/n2/live-capture',
];
const results=[];for(const command of commands){const startedAt=new Date().toISOString();const r=spawnSync('powershell.exe',['-NoProfile','-Command',command],{encoding:'utf8',timeout:120000});results.push({command,startedAt,completedAt:new Date().toISOString(),exitCode:r.status,error:r.error?.message,stdout:r.stdout,stderr:r.stderr});console.log(`${r.status===0?'PASS':'FAIL'} ${command}`);}
writeFileSync(resolve(dir,'round-3-results.json'),JSON.stringify({round:3,generatedAt:new Date().toISOString(),status:results.every(r=>r.exitCode===0)?'PASS':'FAIL',results},null,2));if(results.some(r=>r.exitCode!==0))process.exitCode=1;
