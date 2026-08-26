import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync, mkdtempSync, renameSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DirectorAttachmentStore, isDirectorAttachmentId } from '../../lib/director-attachments.js';

const ONE_PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'director-attachments-'));
  const store = new DirectorAttachmentStore({ root });
  const [attachment] = store.store(randomUUID(), [{
    name: 'screen.png', mimeType: 'image/png', dataBase64: ONE_PIXEL_PNG_BASE64,
  }]);
  return { root, store, attachment };
}

describe('DirectorAttachmentStore preview reads', () => {
  it('accepts only generated attachment ids and returns verified image bytes', () => {
    const { store, attachment } = fixture();
    assert.equal(isDirectorAttachmentId(attachment.id), true);
    assert.equal(isDirectorAttachmentId('attachment_../../secret.png'), false);
    const preview = store.readForPreview(attachment);
    assert.equal(preview.metadata.id, attachment.id);
    assert.equal(preview.metadata.mimeType, 'image/png');
    assert.deepEqual(preview.body, Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64'));
  });

  it('rejects a metadata path that is nested, traversed, or detached from its generated filename', () => {
    const { root, store, attachment } = fixture();
    const unsafe = {
      ...attachment,
      path: resolve(root, attachment.storageId, 'nested', attachment.storedName),
    };
    assert.throws(
      () => store.readForPreview(unsafe),
      error => error.code === 'ATTACHMENT_METADATA_INVALID' && error.statusCode === 409,
    );
  });

  it('rebinds transferred legacy absolute paths to the current safe store root', () => {
    const { root: oldRoot, attachment } = fixture();
    const newRoot = mkdtempSync(join(tmpdir(), 'director-attachments-transfer-'));
    cpSync(join(oldRoot, attachment.storageId), join(newRoot, attachment.storageId), { recursive: true });
    const transferredStore = new DirectorAttachmentStore({ root: newRoot });

    const [normalized] = transferredStore.normalizeMetadata([attachment]);
    assert.equal(normalized.path, join(newRoot, attachment.storageId, attachment.storedName));
    assert.equal(normalized.manifestPath, join(newRoot, attachment.storageId, 'manifest.json'));
    assert.notEqual(normalized.path, attachment.path);
    const preview = transferredStore.readForPreview(attachment);
    assert.deepEqual(preview.body, Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64'));

    assert.throws(
      () => transferredStore.readForPreview({
        ...attachment,
        path: `${oldRoot}\\..\\${attachment.storageId}\\${attachment.storedName}`,
      }),
      error => error.code === 'ATTACHMENT_METADATA_INVALID' && error.statusCode === 409,
    );
  });

  it('re-sniffs content and refuses a file changed after storage', () => {
    const { store, attachment } = fixture();
    writeFileSync(attachment.path, Buffer.from('not-an-image'));
    assert.throws(
      () => store.readForPreview(attachment),
      error => error.code === 'ATTACHMENT_CHANGED' && error.statusCode === 409,
    );
  });

  it('refuses a storage directory replaced by a symbolic link', t => {
    const { root, store, attachment } = fixture();
    const directory = dirname(attachment.path);
    const external = `${root}-external-${randomUUID()}`;
    renameSync(directory, external);
    try {
      symlinkSync(external, directory, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        t.skip(`symbolic links unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.throws(
      () => store.readForPreview(attachment),
      error => error.code === 'ATTACHMENT_UNSAFE_PATH' && error.statusCode === 409,
    );
  });
});
