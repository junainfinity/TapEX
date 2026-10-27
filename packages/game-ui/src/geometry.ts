/** Logical CSS pixel bounds. DPR never participates in picking. */
export interface BoardClip { width: number; height: number; gutter: number; top: number; bottom: number }
/** Narrow app views plus touch-phone landscape, excluding short desktop windows/tablets. */
export function usesPhoneControls(width:number,height:number,coarsePointer:boolean):boolean {
  return width<768 || coarsePointer&&height<500&&width<=1000;
}
/** Reclaim vertical space without changing the square scale or the future time horizon. */
export function boardProjection(available:number,width:number,anchor:number,gutter:number,zoom:number,phone:boolean,horizonS?:number){
  const referenceHeight=chartHeight(available,width,anchor,gutter,horizonS);
  return {height:phone?Math.max(50,available):referenceHeight,cell:referenceHeight/6*zoom};
}
export function isWholeCellVisible(x: number, y: number, cell: number, clip: BoardClip): boolean {
  return Number.isFinite(x + y + cell) && cell > 0 && x >= 0 && y >= clip.top &&
    x + cell <= clip.width - clip.gutter && y + cell <= clip.height - clip.bottom;
}
export function containsPoint(x: number, y: number, cell: number, px: number, py: number): boolean {
  return px >= x && px < x + cell && py >= y && py < y + cell;
}
export function isTap(startX: number, startY: number, x: number, y: number, canceled: boolean): boolean {
  return !canceled && Math.hypot(x - startX, y - startY) <= 8;
}
export function chartHeight(available: number, width: number, anchor: number, gutter: number, horizonS?: number): number {
  // A fixed height for all zoom values preserves zoom. Fit two future windows at maximum zoom.
  const horizonHeight = horizonS ? Math.max(1, width * (1 - anchor) - gutter) * 30 / (.9 * horizonS) : available;
  return Math.max(50, Math.min(available, horizonHeight));
}
/** Fit the full label without changing its text or increasing its natural width. */
export function labelScale(naturalWidth: number, availableWidth: number): number {
  return naturalWidth > 0 ? Math.min(1, Math.max(0, availableWidth) / naturalWidth) : 1;
}
