export const IMAGE_ATTACHMENT_LIMITS = Object.freeze({
  count: 4,
  perFileBytes: 5 * 1024 * 1024,
  totalBytes: 12 * 1024 * 1024,
});

export const IMAGE_MIME_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function validateImageSelection(files, existing = []) {
  const incoming = Array.from(files || []);
  if (!incoming.length) return { ok: false, error: '선택한 이미지가 없습니다.' };
  if (existing.length + incoming.length > IMAGE_ATTACHMENT_LIMITS.count) {
    return { ok: false, error: `이미지는 최대 ${IMAGE_ATTACHMENT_LIMITS.count}개까지 첨부할 수 있습니다.` };
  }
  const unsupported = incoming.find(file => !IMAGE_MIME_TYPES.includes(String(file?.type || '').toLowerCase()));
  if (unsupported) return { ok: false, error: `${unsupported.name || '파일'}은 지원하지 않는 이미지 형식입니다.` };
  const oversized = incoming.find(file => Number(file?.size) > IMAGE_ATTACHMENT_LIMITS.perFileBytes);
  if (oversized) return { ok: false, error: `${oversized.name || '파일'}이 개별 제한 5 MB를 넘습니다.` };
  const total = [...existing, ...incoming].reduce((sum, file) => sum + (Number(file?.size) || 0), 0);
  if (total > IMAGE_ATTACHMENT_LIMITS.totalBytes) return { ok: false, error: '이미지 전체 용량은 12 MB까지 첨부할 수 있습니다.' };
  return { ok: true, files: incoming };
}

export function readImageBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const encoded = String(reader.result || '').split(',', 2)[1];
      if (!encoded) reject(new Error(`${file.name || '이미지'}를 읽지 못했습니다.`));
      else resolve(encoded);
    };
    reader.onerror = () => reject(new Error(`${file.name || '이미지'}를 읽지 못했습니다.`));
    reader.readAsDataURL(file);
  });
}
