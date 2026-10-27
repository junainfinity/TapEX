import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {linearBandProbability} from '../src/linear-probability.js';
import {sampledBandProbability} from '../src/sampled-probability.js';

describe('continuous connected-observation odds',()=>{
  it('counts a crossing between observations, even for a zero-width barrier',()=>{
    // Signs of X and X+Y differ in two 45-degree wedges for iid normal X,Y.
    expect(linearBandProbability({zLower:0,zUpper:0,timeToStartS:1,windowS:1,observationIntervalS:1}).probability).toBeCloseTo(.25,10);
  });
  const reference=JSON.parse(readFileSync(new URL('./fixtures/linear-probability-reference.json',import.meta.url),'utf8'));
  it.each(reference.cases)('agrees with independent million-path reference $zLower..$zUpper at $timeToStartS seconds',(input:any)=>{
    const result=linearBandProbability(input);
    expect(result.observationCount).toBe(6);
    expect(Math.abs(result.probability-input.referenceProbability)).toBeLessThan(6*input.standardError+1e-5);
    expect(Math.abs(result.probability-linearBandProbability({...input,order:384}).probability)).toBeLessThan(1e-7);
    expect(result.probability+1e-8).toBeGreaterThanOrEqual(sampledBandProbability(input).probability);
  });
  it('preserves symmetry and widening monotonicity',()=>{
    const p={timeToStartS:10,windowS:5,observationIntervalS:1};
    const a=linearBandProbability({...p,zLower:.5,zUpper:1.5}).probability;
    expect(linearBandProbability({...p,zLower:-1.5,zUpper:-.5}).probability).toBeCloseTo(a,12);
    expect(linearBandProbability({...p,zLower:.2,zUpper:1.8}).probability).toBeGreaterThan(a);
  });
  it('rejects invalid phases and unsafe model inputs',()=>{
    const p={zLower:0,zUpper:1,timeToStartS:5,windowS:5,observationIntervalS:1};
    for(const change of [{zLower:2},{timeToStartS:0},{observationIntervalS:.3},{order:15},{windowS:11}])expect(()=>linearBandProbability({...p,...change})).toThrow();
  });
});
