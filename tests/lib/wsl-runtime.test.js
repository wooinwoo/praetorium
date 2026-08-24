import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeWslPath, WslRuntime, _test } from '../../lib/wsl-runtime.js';

describe('WSL runtime boundary', () => {
  it('normalizes Linux paths and rejects shell-shaped distro input', () => {
    assert.equal(normalizeWslPath('/home/owner/projects/../projects/app'), '/home/owner/projects/app');
    assert.throws(() => normalizeWslPath('/home/owner/app '), /앞뒤 공백/);
    assert.throws(() => normalizeWslPath('C:\\projects\\app'), /Linux 절대 경로/);
    assert.throws(() => _test.assertDistro('Ubuntu; rm -rf /'), /유효한 WSL 배포판/);
  });

  it('parses the UTF-16 output emitted by wsl.exe on Windows', () => {
    const output = Buffer.from('Ubuntu\r\ndocker-desktop\r\n', 'utf16le');
    assert.deepEqual(_test.parseWslList(output), ['Ubuntu', 'docker-desktop']);
  });

  it('builds a native WSL launch without interpolating project input into shell code', async () => {
    const runtime = new WslRuntime({ platform: 'win32' });
    runtime.inspect = async () => ({
      label: 'WSL · Ubuntu', ready: true, home: '/home/owner', user: 'owner',
      path: '/home/owner/.local/bin:/usr/bin', hermes: { path: '/home/owner/.local/bin/hermes' },
    });
    const launch = await runtime.launch({
      distro: 'Ubuntu', cwd: '/home/owner/My Project', board: 'app',
      args: ['-p', 'project-director-1', 'kanban', 'list'],
      env: { PRAETORIUM_PROJECT_CWD: '/home/owner/My Project' },
    });
    assert.equal(launch.executable, 'wsl.exe');
    assert.deepEqual(launch.args.slice(0, 7), ['--distribution', 'Ubuntu', '--cd', '/home/owner/My Project', '--exec', '/bin/bash', '-lc']);
    assert.equal(launch.args[7], 'exec /usr/bin/env -i "$@"');
    assert.ok(launch.args.includes('HERMES_KANBAN_DB=/home/owner/.hermes/kanban/boards/app/kanban.db'));
    assert.ok(launch.args.includes('/home/owner/My Project'));
  });

  it('does not allow launch callers to override managed WSL identity or roots', async () => {
    const runtime = new WslRuntime({ platform: 'win32' });
    runtime.inspect = async () => ({
      label: 'WSL · Ubuntu', ready: true, home: '/home/owner', user: 'owner',
      path: '/usr/bin', hermes: { path: '/home/owner/.local/bin/hermes' },
    });
    const launch = await runtime.launch({
      distro: 'Ubuntu', cwd: '/home/owner/app', board: 'alpha', args: ['--version'],
      env: { HOME: '/tmp/override', PATH: '/tmp/bin', HERMES_HOME: '/tmp/hermes' },
    });
    assert.ok(launch.args.includes('HOME=/home/owner'));
    assert.ok(launch.args.includes('PATH=/usr/bin'));
    assert.ok(launch.args.includes('HERMES_HOME=/home/owner/.hermes'));
    assert.ok(!launch.args.some(arg => arg.includes('/tmp/override') || arg.includes('/tmp/hermes')));
  });

  it('discovers direct and one-level grouped Git repositories', async () => {
    const runtime = new WslRuntime({ platform: 'win32' });
    runtime.inspect = async () => ({ home: '/home/owner' });
    const calls = [];
    runtime._run = async args => {
      calls.push(args);
      return { stdout: Buffer.from('/home/owner/projects/direct/.git\0/home/owner/projects/direct/vendor/.git\0/home/owner/projects/personal/nested/.git\0') };
    };

    assert.deepEqual(await runtime.discoverProjects({ distro: 'Ubuntu' }), [
      '/home/owner/projects/direct',
      '/home/owner/projects/personal/nested',
    ]);
    assert.deepEqual(calls[1].slice(-8), [
      '/home/owner/projects', '-mindepth', '2', '-maxdepth', '3', '-name', '.git', '-print0',
    ]);
  });

  it('captures WSL candidate metadata before and after hashing', async () => {
    const runtime = new WslRuntime({ platform: 'win32' });
    let command = null;
    runtime._run = async args => {
      command = args;
      return { stdout: Buffer.from(`revision-one\nsha256:${'a'.repeat(64)}\n1\n`) };
    };

    const snapshot = await runtime.candidateSnapshot({ distro: 'Ubuntu', path: '/home/owner/app' });
    const script = command[command.indexOf('-c') + 1];
    assert.equal(snapshot.digest, `sha256:${'a'.repeat(64)}`);
    assert.match(script, /before_metadata="\$\(git_metadata\)"/);
    assert.match(script, /after_metadata="\$\(git_metadata\)"/);
    assert.match(script, /candidate-metadata-changed/);
    assert.match(script, /dirty-submodule-candidate/);
    assert.ok(script.includes('status --porcelain=v2'));
    assert.ok(script.includes('fallback_manifest() { find . \\( -type f -o -type l \\)'));
  });
});
