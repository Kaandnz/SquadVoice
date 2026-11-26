const MAX_DATA_URL_LENGTH = 300_000;
const MAX_AVATAR_LENGTH = 55_000;

export async function compressImageToDataUrl(file: File): Promise<{ url: string; name: string }> {
  const dataUrl = await readFileAsDataUrl(file);
  if (dataUrl.length <= MAX_DATA_URL_LENGTH && file.type === 'image/gif') {
    return { url: dataUrl, name: file.name || 'image.gif' };
  }

  const img = await loadImage(dataUrl);
  const maxDim = 1280;
  let width = img.naturalWidth || img.width;
  let height = img.naturalHeight || img.height;

  if (width > maxDim || height > maxDim) {
    const scale = maxDim / Math.max(width, height);
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Görsel işleme bağlamı oluşturulamadı.');
  }
  ctx.drawImage(img, 0, 0, width, height);

  const qualities = [0.82, 0.68, 0.52, 0.38];
  for (const quality of qualities) {
    const webp = canvas.toDataURL('image/webp', quality);
    if (webp.length <= MAX_DATA_URL_LENGTH) {
      return { url: webp, name: file.name || 'image.webp' };
    }
    const jpeg = canvas.toDataURL('image/jpeg', quality);
    if (jpeg.length <= MAX_DATA_URL_LENGTH) {
      return { url: jpeg, name: file.name || 'image.jpg' };
    }
  }

  throw new Error('Görsel sıkıştırılsa bile çok büyük (en fazla ~220 KB).');
}

export async function compressAvatarToDataUrl(file: File): Promise<string> {
  const raw = await readFileAsDataUrl(file);
  const img = await loadImage(raw);
  const size = 160;
  const minSide = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height);
  const sx = Math.max(0, Math.floor(((img.naturalWidth || img.width) - minSide) / 2));
  const sy = Math.max(0, Math.floor(((img.naturalHeight || img.height) - minSide) / 2));

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Avatar işlenemedi.');
  ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);

  for (const q of [0.82, 0.68, 0.5]) {
    const webp = canvas.toDataURL('image/webp', q);
    if (webp.length <= MAX_AVATAR_LENGTH) return webp;
    const jpeg = canvas.toDataURL('image/jpeg', q);
    if (jpeg.length <= MAX_AVATAR_LENGTH) return jpeg;
  }

  throw new Error('Profil fotoğrafı çok büyük.');
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Görsel okunamadı.'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Geçersiz görsel dosyası.'));
    img.src = src;
  });
}
