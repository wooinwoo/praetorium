import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PROJECTS, _test } from '../../lib/praetorium-config.js';

describe('Praetorium project configuration', () => {
  it('caps the product at three project Directors', () => {
    assert.equal(MAX_PROJECTS, 3);
  });

  it('creates CLI-safe project identifiers', () => {
    assert.equal(_test.slug('Career App'), 'career-app');
    assert.equal(_test.slug('학교', 'project-1'), 'project-1');
    assert.equal(_test.projectIdentity('Career App', '12345678-aaaa'), 'career-app-12345678');
    const first = _test.projectIdentity('x'.repeat(80), '11111111');
    const second = _test.projectIdentity('x'.repeat(80), '22222222');
    assert.equal(first.length, 48);
    assert.equal(second.length, 48);
    assert.notEqual(first, second);
  });

  it('rejects missing directories from project assignment', () => {
    assert.equal(_test.cleanProject({ name: 'missing', path: 'Z:\\not-real\\praetorium' }), null);
  });

  it('preserves an offline WSL assignment as a distro plus Linux path', () => {
    assert.deepEqual(_test.cleanProject({ name: 'App', path: '/home/owner/projects/app', runtime: 'wsl', distro: 'Ubuntu' }), {
      id: 'app', name: 'App', path: '/home/owner/projects/app', runtime: 'wsl', distro: 'Ubuntu', slot: null,
    });
  });

  it('keeps explicit Director slots stable while filling legacy gaps', () => {
    assert.deepEqual(_test.assignProjectSlots([
      { id: 'a', slot: 2 }, { id: 'b' }, { id: 'c', slot: 2 },
    ]).map(project => [project.id, project.slot]), [['a', 2], ['b', 1], ['c', 3]]);
  });
});
