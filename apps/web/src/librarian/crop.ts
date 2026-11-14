/**
 * Crop math for the cover editor. The image is shown "cover"-fitted in a 2:3 frame, then zoomed
 * and panned; this turns that view back into the rectangle of the original image to keep.
 */
export interface CropView {
  /** Natural image size. */
  imgW: number;
  imgH: number;
  /** Frame size on screen. */
  frameW: number;
  frameH: number;
  /** 1 = the image just covers the frame. */
  zoom: number;
  /** Pan in screen pixels, from the centered position. */
  dx: number;
  dy: number;
}

/** Scale from image pixels to screen pixels. */
export function viewScale(v: Pick<CropView, "imgW" | "imgH" | "frameW" | "frameH" | "zoom">): number {
  return Math.max(v.frameW / v.imgW, v.frameH / v.imgH) * v.zoom;
}

/** Keeps the pan inside the image so the frame never shows empty space. */
export function clampPan(v: CropView): { dx: number; dy: number } {
  const s = viewScale(v);
  const maxX = Math.max(0, (v.imgW * s - v.frameW) / 2);
  const maxY = Math.max(0, (v.imgH * s - v.frameH) / 2);
  return { dx: Math.min(maxX, Math.max(-maxX, v.dx)), dy: Math.min(maxY, Math.max(-maxY, v.dy)) };
}

/** The part of the original image inside the frame, in image pixels. */
export function sourceRect(v: CropView): { sx: number; sy: number; sw: number; sh: number } {
  const s = viewScale(v);
  const { dx, dy } = clampPan(v);
  const sw = v.frameW / s;
  const sh = v.frameH / s;
  const sx = v.imgW / 2 - sw / 2 - dx / s;
  const sy = v.imgH / 2 - sh / 2 - dy / s;
  return { sx, sy, sw, sh };
}
