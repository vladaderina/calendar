// Turn a picked file into something small enough to keep (and upload).
//
// A phone photo is 3–8 MB; as a data URL that would blow both the localStorage
// budget and the request the app sends to the server. So anything bigger than
// a small screenshot is redrawn into a canvas at max `maxSide` px and encoded
// as JPEG. Small files (icons, tiny screenshots, GIFs) are kept untouched so
// transparency and animation survive.

const KEEP_AS_IS_BYTES = 350_000;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('не удалось прочитать файл'));
    reader.readAsDataURL(file);
  });
}

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      // some browsers refuse certain types here — fall back to <img>
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('не удалось открыть изображение'));
      img.src = url;
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export async function fileToDataUrl(file: File, maxSide = 1400, quality = 0.72): Promise<string> {
  if (file.size <= KEEP_AS_IS_BYTES) return readAsDataUrl(file);

  const source = await decode(file);
  const width = 'width' in source ? source.width : 0;
  const height = 'height' in source ? source.height : 0;
  if (!width || !height) return readAsDataUrl(file);

  const scale = Math.min(1, maxSide / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return readAsDataUrl(file);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source as CanvasImageSource, 0, 0, w, h);
  if ('close' in source && typeof source.close === 'function') source.close();

  const data = canvas.toDataURL('image/jpeg', quality);
  // A PNG screenshot can grow when re-encoded; keep whichever is smaller.
  if (!data || data.length > file.size * 1.4) return readAsDataUrl(file);
  return data;
}
