import type { LayoutMode, ViewportContext } from '@maya/contracts';
export const ADAPTIVE_CONFIG = Object.freeze({ mobileWidth: 768, compactHeight: 500, desktopWidth: 1200, coarseDesktopWidth: 1440, minControlTarget: 44,
  desktop: Object.freeze({ dprCap: 2, targetP95Ms: 16.7, anchorFraction: 0.29, rightGutter: 48 }), tablet: Object.freeze({ dprCap: 1.5, targetP95Ms: 20, anchorFraction: 0.24, rightGutter: 44 }), mobile: Object.freeze({ dprCap: 1.5, targetP95Ms: 33.3, anchorFraction: 0.18, rightGutter: 40 }) });
export function resolveLayout(view: ViewportContext): LayoutMode {
  if (!Number.isFinite(view.width) || !Number.isFinite(view.height) || view.width <= 0 || view.height <= 0) throw new RangeError('Invalid viewport dimensions');
  if (view.width < ADAPTIVE_CONFIG.mobileWidth || view.height < ADAPTIVE_CONFIG.compactHeight) return 'mobile';
  if (view.width < ADAPTIVE_CONFIG.desktopWidth || view.coarsePointer && view.width < ADAPTIVE_CONFIG.coarseDesktopWidth) return 'tablet';
  return 'desktop';
}
