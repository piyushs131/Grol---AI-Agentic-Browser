
const DEFAULT_COLOR = '#E11D48';

async function blobToDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return `data:${blob.type};base64,${btoa(bin)}`;
}

export function withImageSize(shot, width, height) {
  if (!(width > 0 && height > 0)) return shot;
  const cssW = shot.cssWidth || width;
  const cssH = shot.cssHeight || height;
  return { ...shot, imageWidth: width, imageHeight: height, scaleX: cssW / width, scaleY: cssH / height };
}

export async function drawMarks(shot, marks) {
  if (!shot || !shot.dataUrl || !Array.isArray(marks) || !marks.length) return shot;
  try {
    const bitmap = await createImageBitmap(await (await fetch(shot.dataUrl)).blob());
    const W = bitmap.width, H = bitmap.height;
    const sized = withImageSize(shot, W, H);
    const s = 1 / sized.scaleX;
    const sy = 1 / sized.scaleY;
    const cssW = W * sized.scaleX;
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close && bitmap.close();

    ctx.font = `700 ${Math.round(13 * s)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    marks.forEach((m) => {
      const r = m.rect || {};
      if (!(r.w > 0 && r.h > 0)) return;
      const color = m.color || DEFAULT_COLOR;
      ctx.globalAlpha = m.muted ? 0.55 : 1;

      ctx.strokeStyle = color;
      ctx.lineWidth = 2 * s;
      ctx.setLineDash(m.muted ? [5 * s, 3 * s] : []);
      ctx.strokeRect((r.x + 1) * s, (r.y + 1) * sy, (r.w - 2) * s, (r.h - 2) * sy);
      ctx.setLineDash([]);

      const text = String(m.mark);
      const top = r.y < 18 ? Math.max(0, r.y) : r.y - 17;
      const left = Math.max(0, Math.min(r.x, cssW - 32));
      const bw = Math.max(16, ctx.measureText(text).width / s + 10);
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.fillRect(left * s, top * sy, bw * s, 17 * sy);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, (left + bw / 2) * s, (top + 8.5) * sy);
    });

    const type = shot.mimeType || 'image/jpeg';
    const blob = await canvas.convertToBlob({ type, quality: 0.82 });
    return { ...sized, dataUrl: await blobToDataUrl(blob), mimeType: blob.type, bytes: blob.size };
  } catch (_) {
    return shot;
  }
}
