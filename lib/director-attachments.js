import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync,
  readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { extname, isAbsolute, posix, resolve, sep, win32 } from 'node:path';

const MIB = 1024 * 1024;
const MAX_FILES = 4;
const MAX_CONTEXT_FILES = 12;
const MAX_FILE_BYTES = 5 * MIB;
const MAX_TOTAL_BYTES = 12 * MIB;
const MAX_STORE_BYTES = 512 * MIB;
const MAX_REQUEST_BYTES = 17 * MIB;
const MAX_IMAGE_DIMENSION = 12000;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_STORE_ENTRIES = 20000;
const SAFE_STORAGE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ATTACHMENT_ID = /^attachment_[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_STORED_NAME = /^\d{2}-[a-f0-9]{8}-[a-f0-9]{3}\.(?:png|jpg|webp|gif)$/i;

const IMAGE_TYPES = new Map([
  ['image/png', { extensions: new Set(['.png']), storedExtension: '.png' }],
  ['image/jpeg', { extensions: new Set(['.jpg', '.jpeg']), storedExtension: '.jpg' }],
  ['image/webp', { extensions: new Set(['.webp']), storedExtension: '.webp' }],
  ['image/gif', { extensions: new Set(['.gif']), storedExtension: '.gif' }],
]);

export const DIRECTOR_ATTACHMENT_LIMITS = Object.freeze({
  maxFiles: MAX_FILES,
  maxContextFiles: MAX_CONTEXT_FILES,
  maxFileBytes: MAX_FILE_BYTES,
  maxTotalBytes: MAX_TOTAL_BYTES,
  maxStoreBytes: MAX_STORE_BYTES,
  maxRequestBytes: MAX_REQUEST_BYTES,
  allowedMimeTypes: Object.freeze([...IMAGE_TYPES.keys()]),
});

export function isDirectorAttachmentId(value) {
  return SAFE_ATTACHMENT_ID.test(String(value || ''));
}

function attachmentError(message, statusCode = 400, code = 'INVALID_ATTACHMENT') {
  return Object.assign(new Error(message), { statusCode, code });
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function cleanName(value) {
  const name = String(value || '').normalize('NFC').trim();
  if (!name || name.length > 120 || /[\\/\u0000-\u001f\u007f]/.test(name) || name === '.' || name === '..') {
    throw attachmentError('Attachment name must be a plain filename of 120 characters or fewer.');
  }
  return name;
}

function strictBase64(value, index) {
  if (typeof value !== 'string' || !value || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw attachmentError(`Attachment ${index + 1} has invalid base64 data.`);
  }
  if (Math.floor(value.length * 3 / 4) > MAX_FILE_BYTES + 2) {
    throw attachmentError(`Attachment ${index + 1} exceeds the 5 MiB limit.`, 413, 'ATTACHMENT_TOO_LARGE');
  }
  return Buffer.from(value, 'base64');
}

function sniffMime(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (buffer.length >= 10 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 10 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.length >= 30 && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function jpegDimensions(buffer) {
  let offset = 2;
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset++];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if (sofMarkers.has(marker) && length >= 7) {
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return null;
}

function imageDimensions(buffer, mimeType) {
  if (mimeType === 'image/png') return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  if (mimeType === 'image/gif') return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  if (mimeType === 'image/jpeg') return jpegDimensions(buffer);
  const chunk = buffer.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X' && buffer.length >= 30) {
    return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  }
  if (chunk === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    return {
      width: 1 + buffer[21] + ((buffer[22] & 0x3f) << 8),
      height: 1 + ((buffer[22] & 0xc0) >> 6) + (buffer[23] << 2) + ((buffer[24] & 0x0f) << 10),
    };
  }
  if (chunk === 'VP8 ' && buffer.length >= 30
    && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

function validateDimensions(buffer, mimeType, index) {
  const dimensions = imageDimensions(buffer, mimeType);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1
    || dimensions.width > MAX_IMAGE_DIMENSION || dimensions.height > MAX_IMAGE_DIMENSION
    || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
    throw attachmentError(
      `Attachment ${index + 1} has invalid or unsafe image dimensions.`,
      415,
      'UNSAFE_IMAGE_DIMENSIONS',
    );
  }
  return dimensions;
}

function validateInput(input, index) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw attachmentError(`Attachment ${index + 1} must be an object.`);
  }
  const name = cleanName(input.name);
  const mimeType = String(input.mimeType || '').trim().toLowerCase();
  const specification = IMAGE_TYPES.get(mimeType);
  if (!specification) {
    throw attachmentError(`Attachment ${index + 1} has an unsupported image MIME type.`, 415, 'UNSUPPORTED_IMAGE_TYPE');
  }
  if (!specification.extensions.has(extname(name).toLowerCase())) {
    throw attachmentError(`Attachment ${index + 1} filename extension does not match ${mimeType}.`, 415, 'IMAGE_EXTENSION_MISMATCH');
  }
  const buffer = strictBase64(input.dataBase64, index);
  if (!buffer.length || buffer.length > MAX_FILE_BYTES) {
    throw attachmentError(`Attachment ${index + 1} exceeds the 5 MiB limit.`, 413, 'ATTACHMENT_TOO_LARGE');
  }
  if (sniffMime(buffer) !== mimeType) {
    throw attachmentError(`Attachment ${index + 1} content does not match ${mimeType}.`, 415, 'IMAGE_CONTENT_MISMATCH');
  }
  const dimensions = validateDimensions(buffer, mimeType, index);
  return { name, mimeType, specification, buffer, dimensions };
}

function regularFile(path, label) {
  let info;
  try { info = lstatSync(path); }
  catch { throw attachmentError(`${label} is missing.`, 409, 'ATTACHMENT_MISSING'); }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw attachmentError(`${label} is not a regular local file.`, 409, 'ATTACHMENT_UNSAFE_PATH');
  }
  return info;
}

function portableStoredPathMatches(value, storageId, filename) {
  if (value == null || value === '') return false;
  const source = String(value);
  if (source.length > 4096 || /[\u0000-\u001f\u007f]/.test(source)
    || !(isAbsolute(source) || win32.isAbsolute(source) || posix.isAbsolute(source))) return false;
  const segments = source.replaceAll('\\', '/').split('/').filter(Boolean);
  if (segments.some(segment => segment === '.' || segment === '..') || segments.length < 2) return false;
  return segments.at(-2).toLowerCase() === String(storageId).toLowerCase()
    && segments.at(-1).toLowerCase() === String(filename).toLowerCase();
}

function readRegularFile(path, label) {
  const before = regularFile(path, label);
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== before.size) {
      throw attachmentError(`${label} changed while it was being opened.`, 409, 'ATTACHMENT_CHANGED');
    }
    return readFileSync(descriptor);
  } catch (error) {
    if (error?.statusCode) throw error;
    throw attachmentError(`${label} could not be opened safely.`, 409, 'ATTACHMENT_UNSAFE_PATH');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export class DirectorAttachmentStore {
  constructor({ root } = {}) {
    if (!root) throw new Error('DirectorAttachmentStore requires a root');
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const info = lstatSync(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Director attachment root must be a regular directory');
  }

  _insideRoot(path) {
    const candidate = resolve(path);
    return candidate.startsWith(`${this.root}${sep}`) ? candidate : null;
  }

  _storageDirectory(storageId) {
    if (!SAFE_STORAGE_ID.test(String(storageId || ''))) {
      throw attachmentError('Invalid attachment storage id.');
    }
    let rootInfo;
    try { rootInfo = lstatSync(this.root); }
    catch { throw attachmentError('Attachment root is missing.', 409, 'ATTACHMENT_MISSING'); }
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw attachmentError('Attachment root is not a safe local directory.', 409, 'ATTACHMENT_UNSAFE_PATH');
    }
    const directory = this._insideRoot(resolve(this.root, storageId));
    if (!directory) throw attachmentError('Attachment path escapes the local store.', 409, 'ATTACHMENT_UNSAFE_PATH');
    let info;
    try { info = lstatSync(directory); }
    catch { throw attachmentError('Attachment directory is missing.', 409, 'ATTACHMENT_MISSING'); }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw attachmentError('Attachment directory is not a regular local directory.', 409, 'ATTACHMENT_UNSAFE_PATH');
    }
    return directory;
  }

  _storeUsage() {
    let entries = 0;
    let bytes = 0;
    const pending = [this.root];
    while (pending.length) {
      const directory = pending.pop();
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        entries += 1;
        if (entries > MAX_STORE_ENTRIES) return MAX_STORE_BYTES + 1;
        const path = resolve(directory, entry.name);
        const info = lstatSync(path);
        if (info.isSymbolicLink()) throw attachmentError('Attachment store contains an unsafe symbolic link.', 409, 'ATTACHMENT_UNSAFE_PATH');
        if (info.isDirectory()) pending.push(path);
        else if (info.isFile()) bytes += info.size;
        else throw attachmentError('Attachment store contains an unsupported entry.', 409, 'ATTACHMENT_UNSAFE_PATH');
        if (bytes > MAX_STORE_BYTES) return bytes;
      }
    }
    return bytes;
  }

  store(storageId, inputs = []) {
    if (inputs == null) inputs = [];
    if (!Array.isArray(inputs)) throw attachmentError('attachments must be an array.');
    if (!inputs.length) return [];
    if (!SAFE_STORAGE_ID.test(String(storageId || ''))) throw attachmentError('Invalid attachment storage id.');
    if (inputs.length > MAX_FILES) {
      throw attachmentError(`A Director message accepts at most ${MAX_FILES} images.`, 413, 'TOO_MANY_ATTACHMENTS');
    }
    const validated = inputs.map(validateInput);
    const totalBytes = validated.reduce((sum, item) => sum + item.buffer.length, 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw attachmentError('Director message images exceed the 12 MiB total limit.', 413, 'ATTACHMENTS_TOO_LARGE');
    }
    if (this._storeUsage() + totalBytes + 64 * 1024 > MAX_STORE_BYTES) {
      throw attachmentError('The local Director attachment store reached its 512 MiB safety limit.', 507, 'ATTACHMENT_STORE_FULL');
    }

    const finalDirectory = this._insideRoot(resolve(this.root, storageId));
    const temporaryDirectory = this._insideRoot(resolve(this.root, `${storageId}.tmp-${randomUUID()}`));
    if (!finalDirectory || !temporaryDirectory || existsSync(finalDirectory)) {
      throw attachmentError('Attachment storage collision.', 409, 'ATTACHMENT_STORAGE_COLLISION');
    }
    mkdirSync(temporaryDirectory, { mode: 0o700 });
    const createdAt = new Date().toISOString();
    try {
      const manifestPath = resolve(finalDirectory, 'manifest.json');
      const metadata = validated.map((item, index) => {
        const id = `attachment_${randomUUID()}`;
        const storedName = `${String(index + 1).padStart(2, '0')}-${id.slice(11, 23)}${item.specification.storedExtension}`;
        const temporaryPath = resolve(temporaryDirectory, storedName);
        const path = resolve(finalDirectory, storedName);
        writeFileSync(temporaryPath, item.buffer, { flag: 'wx', mode: 0o600 });
        return {
          id,
          storageId,
          name: item.name,
          storedName,
          mimeType: item.mimeType,
          size: item.buffer.length,
          width: item.dimensions.width,
          height: item.dimensions.height,
          sha256: sha256(item.buffer),
          path,
          manifestPath,
          createdAt,
        };
      });
      const manifest = JSON.stringify({
        schema: 'director-attachments.v1', storageId, createdAt,
        files: metadata.map(({ manifestPath: _manifestPath, ...item }) => item),
      }, null, 2);
      const manifestSha256 = sha256(Buffer.from(manifest, 'utf8'));
      writeFileSync(resolve(temporaryDirectory, 'manifest.json'), manifest, { flag: 'wx', mode: 0o600 });
      renameSync(temporaryDirectory, finalDirectory);
      return metadata.map(item => ({ ...item, manifestSha256 }));
    } catch (error) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  normalizeMetadata(items) {
    if (!Array.isArray(items)) return [];
    if (items.length > MAX_STORE_ENTRIES) {
      throw attachmentError(
        'Persisted attachment metadata exceeds the local store safety limit.',
        413,
        'ATTACHMENT_METADATA_LIMIT',
      );
    }
    return items.map(item => {
      if (!item || typeof item !== 'object' || !SAFE_STORAGE_ID.test(String(item.storageId || ''))
        || !SAFE_ATTACHMENT_ID.test(String(item.id || '')) || !IMAGE_TYPES.has(item.mimeType)
        || !/^[a-f0-9]{64}$/i.test(String(item.sha256 || ''))
        || !/^[a-f0-9]{64}$/i.test(String(item.manifestSha256 || ''))) return null;
      let name;
      try { name = cleanName(item.name); } catch { return null; }
      const expectedDirectory = resolve(this.root, item.storageId);
      const storedName = String(item.storedName || '');
      const specification = IMAGE_TYPES.get(item.mimeType);
      const path = this._insideRoot(resolve(expectedDirectory, storedName));
      const manifestPath = this._insideRoot(resolve(expectedDirectory, 'manifest.json'));
      if (!SAFE_STORED_NAME.test(storedName) || !specification.extensions.has(extname(storedName).toLowerCase())
        || !path || !manifestPath
        || !portableStoredPathMatches(item.path, item.storageId, storedName)
        || !portableStoredPathMatches(item.manifestPath, item.storageId, 'manifest.json')) return null;
      const size = Number(item.size);
      const width = Number(item.width);
      const height = Number(item.height);
      if (!Number.isInteger(size) || size < 1 || size > MAX_FILE_BYTES
        || !Number.isInteger(width) || !Number.isInteger(height)
        || width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS) return null;
      return {
        id: item.id,
        storageId: item.storageId,
        name,
        storedName,
        mimeType: item.mimeType,
        size,
        width,
        height,
        sha256: String(item.sha256).toLowerCase(),
        manifestSha256: String(item.manifestSha256).toLowerCase(),
        path,
        manifestPath,
        createdAt: String(item.createdAt || ''),
      };
    }).filter(Boolean);
  }

  _verifiedEntries(items, { retainBodies = false } = {}) {
    const normalized = this.normalizeMetadata(items);
    if (normalized.length !== (Array.isArray(items) ? items.length : 0)) {
      throw attachmentError('Persisted attachment metadata is invalid.', 409, 'ATTACHMENT_METADATA_INVALID');
    }
    const verified = [];
    for (const [index, item] of normalized.entries()) {
      this._storageDirectory(item.storageId);
      const buffer = readRegularFile(item.path, `Attachment ${index + 1}`);
      if (buffer.length !== item.size) throw attachmentError(`Attachment ${index + 1} size changed.`, 409, 'ATTACHMENT_CHANGED');
      if (sniffMime(buffer) !== item.mimeType || sha256(buffer) !== item.sha256) {
        throw attachmentError(`Attachment ${index + 1} content changed.`, 409, 'ATTACHMENT_CHANGED');
      }
      validateDimensions(buffer, item.mimeType, index);
      const manifestBuffer = readRegularFile(item.manifestPath, 'Attachment manifest');
      if (sha256(manifestBuffer) !== item.manifestSha256) {
        throw attachmentError('Attachment manifest content changed.', 409, 'ATTACHMENT_CHANGED');
      }
      let manifest;
      try { manifest = JSON.parse(manifestBuffer.toString('utf8')); }
      catch { throw attachmentError('Attachment manifest is invalid.', 409, 'ATTACHMENT_METADATA_INVALID'); }
      const manifestItem = manifest?.schema === 'director-attachments.v1'
        && manifest.storageId === item.storageId && Array.isArray(manifest.files)
        ? manifest.files.find(file => file?.id === item.id) : null;
      if (!manifestItem || manifestItem.storedName !== item.storedName || manifestItem.mimeType !== item.mimeType
        || manifestItem.storageId !== item.storageId || manifestItem.name !== item.name
        || manifestItem.size !== item.size || manifestItem.width !== item.width || manifestItem.height !== item.height
        || manifestItem.sha256 !== item.sha256
        || !portableStoredPathMatches(manifestItem.path, item.storageId, item.storedName)) {
        throw attachmentError('Attachment metadata does not match its manifest.', 409, 'ATTACHMENT_METADATA_INVALID');
      }
      verified.push(retainBodies ? { metadata: item, body: buffer } : { metadata: item });
    }
    return verified;
  }

  verify(items) {
    return this._verifiedEntries(items).map(item => item.metadata);
  }

  readForPreview(item) {
    return this._verifiedEntries([item], { retainBodies: true })[0];
  }

  remove(storageId) {
    if (!SAFE_STORAGE_ID.test(String(storageId || ''))) return false;
    const directory = this._insideRoot(resolve(this.root, storageId));
    if (!directory || !existsSync(directory)) return false;
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    rmSync(directory, { recursive: true, force: true });
    return true;
  }

  pruneUnreferenced(referencedStorageIds) {
    const referenced = referencedStorageIds instanceof Set ? referencedStorageIds : new Set(referencedStorageIds || []);
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SAFE_STORAGE_ID.test(entry.name) || referenced.has(entry.name)) continue;
      this.remove(entry.name);
    }
  }
}

export const _test = { cleanName, sniffMime, imageDimensions, validateInput };
