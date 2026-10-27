import { describe, expect, it } from 'vitest';
import { boardProjection, usesPhoneControls, chartHeight, containsPoint, isTap, isWholeCellVisible, labelScale } from '../src/geometry';
describe('visible offer safety', () => {
  const clip = { width: 390, height: 350, gutter: 40, top: 0, bottom: 24 };
  it('rejects cells crossing any clipped edge, including a camera shift between quote refreshes', () => {
    expect(isWholeCellVisible(300, 200, 50, clip)).toBe(true);
    for (const [x,y] of [[300.01,200],[-.01,100],[50,-.01],[50,276.01]])
      expect(isWholeCellVisible(x!,y!,50,clip)).toBe(false);
  });
  it('selects one of neighboring rectangles at the shared boundary', () => {
    expect(containsPoint(10,20,50,60,30)).toBe(false);
    expect(containsPoint(60,20,50,60,30)).toBe(true);
  });
  it('cannot resurrect a canceled drag when a finger returns to its start', () => {
    expect(isTap(10,10,10,10,true)).toBe(false);
    expect(isTap(10,10,15,15,false)).toBe(true);
    expect(isTap(10,10,18,18,false)).toBe(false);
  });
  it('keeps mobile height independent of zoom while preserving the source-age horizon', () => {
    const h=chartHeight(500,390,.18,40,25);
    expect(h).toBeLessThan(500);
    expect((390*(1-.18)-40)/(h/6*.9)*5).toBeGreaterThanOrEqual(25);
    expect(h/6*.9).toBeGreaterThan(h/6*.345);
  });
  it('fits complete numeric labels only when needed without upscaling short ones', () => {
    expect(labelScale(24.375,15.45)*24.375).toBeCloseTo(15.45);
    expect(labelScale(10,15.45)).toBe(1);
    expect(labelScale(0,15.45)).toBe(1);
  });
  it('expands the phone canvas without moving the future horizon or stretching squares',()=>{
    for(const zoom of [.345,.6,.9]){
      const old=boardProjection(683,390,.18,40,zoom,false,25);
      const phone=boardProjection(683,390,.18,40,zoom,true,25);
      expect(phone.height).toBe(683);
      expect(phone.height).toBeGreaterThan(old.height);
      expect(phone.cell).toBe(old.cell);
      expect((390*(1-.18)-40)/phone.cell*5).toBeGreaterThanOrEqual(25);
    }
  });
  it('keeps tablet and desktop projection unchanged, including short fine-pointer windows',()=>{
    for(const [width,height,touch,expected] of [[390,844,true,true],[320,568,false,true],[844,390,true,true],[932,430,true,true],[768,1024,true,false],[1024,768,true,false],[1440,900,false,false],[844,390,false,false],[1200,450,true,false]] as const)
      expect(usesPhoneControls(width,height,touch)).toBe(expected);
    const regular=boardProjection(700,768,.24,44,.6,false,25);
    expect(regular.height).toBe(chartHeight(700,768,.24,44,25));
    expect(regular.cell).toBeCloseTo(regular.height/6*.6);
  });
});
