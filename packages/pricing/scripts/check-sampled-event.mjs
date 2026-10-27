import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TouchProbabilityModel } from '../dist/model.js';
import { sampledBandProbability } from '../dist/sampled-probability.js';
const dir = resolve(process.argv[2] ?? 'artifacts/verification/n2/live-capture');
const model = new TouchProbabilityModel(JSON.parse(readFileSync(resolve(dir, 'table.json'), 'utf8')));
// Reproducible developer-only model validation. No random outcome generator exists in the game.
let state = 0x6d617961;
const uniform = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return ((state >>> 0) + 1) / 4294967297; };
const normal = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
const paths = 100_000;
const rows = [];
for (const [zc, zh, timeToStart] of [[0,.25,5],[1,.5,5],[2,.5,5],[0,1,10],[1,.25,15],[-1,.5,5],[0,.05,5],[3,.25,30]]) {
  const width = 5, dt = 1;
  const tableProbability = model.lookup([zc, zh, (timeToStart + width) / timeToStart, Math.sqrt(dt / width)]);
  const adaptedProbability = model.lookup([zc, zh, (timeToStart + width - dt) / timeToStart, Math.sqrt(dt / (width-dt))]);
  const quadrature = sampledBandProbability({ zLower:zc-zh,zUpper:zc+zh,timeToStartS:timeToStart,windowS:5,observationIntervalS:1 });
  let halfOpenHits = 0, inclusiveEndHits = 0;
  for (let path = 0; path < paths; path++) {
    let y = normal(), hit = y >= zc - zh && y <= zc + zh;
    for (let observation = 1; observation < width; observation++) { y += normal() * Math.sqrt(dt / timeToStart); hit ||= y >= zc - zh && y <= zc + zh; }
    if (hit) halfOpenHits++;
    y += normal() * Math.sqrt(dt / timeToStart);
    if (hit || (y >= zc - zh && y <= zc + zh)) inclusiveEndHits++;
  }
  const halfOpenProbability = halfOpenHits / paths;
  const standardError=Math.sqrt(halfOpenProbability * (1-halfOpenProbability) / paths);
  rows.push({ zc, zh, timeToStart, tableProbability, adaptedProbability, quadrature, halfOpenProbability, inclusiveEndProbability: inclusiveEndHits / paths, absoluteHalfOpenError: Math.abs(tableProbability - halfOpenProbability), adaptedHalfOpenError:Math.abs(adaptedProbability-halfOpenProbability), quadratureError:Math.abs(quadrature.probability-halfOpenProbability), monteCarloStandardError:standardError, referencePass:Math.abs(quadrature.probability-halfOpenProbability)<=5*standardError+0.0005 });
}
const convergence=[];
for(const zc of [-4,-2,0,2,4])for(const zh of [.05,.25,.5,1,4])for(const T of [6,15,40,120,400]){
  const input={zLower:zc-zh,zUpper:zc+zh,timeToStartS:T,windowS:5,observationIntervalS:1};
  const a=sampledBandProbability(input),b=sampledBandProbability({...input,order:Math.min(768,a.quadratureOrder*2)});
  convergence.push({zc,zh,T,error:Math.abs(a.probability-b.probability),order:a.quadratureOrder});
}
const report = { generatedAt: new Date().toISOString(), kind: 'offline seeded normalized Brownian sampled-event reference; not actual market calibration or real price generation', seed: '0x6d617961', pathsPerCase: paths, observations: '[start,start+1s,start+2s,start+3s,start+4s]', acceptanceCriteria:{independentReference:'error <= 5 Monte Carlo standard errors + .0005',quadratureConvergence:'absolute difference <= .000001 on declared 125-case domain grid; not full-market calibration'}, rows, convergence:{cases:convergence.length,maxError:Math.max(...convergence.map(r=>r.error)),failures:convergence.filter(r=>r.error>1e-6)} };
writeFileSync(resolve(dir, 'sampled-quadrature-reference.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({referenceCases:rows.length,referenceFailures:rows.filter(r=>!r.referencePass),maxReferenceError:Math.max(...rows.map(r=>r.quadratureError)),convergence:report.convergence},null,2));
