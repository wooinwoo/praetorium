import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

  it('parses WSL2 version, state, default, and system metadata from the verbose list', () => {
    const output = Buffer.from('  NAME                   STATE           VERSION\r\n* Ubuntu                 Running         2\r\n  Docker Dev             Stopped         1\r\n  docker-desktop         Running         2\r\n', 'utf16le');
    assert.deepEqual(_test.parseWslVerbose(output), [
      { name: 'Ubuntu', state: 'Running', version: 2, default: true, system: false },
      { name: 'Docker Dev', state: 'Stopped', version: 1, default: false, system: false },
      { name: 'docker-desktop', state: 'Running', version: 2, default: false, system: true },
    ]);
  });

  it('falls back to the quiet list when verbose metadata is unavailable', async () => {
    const runtime = new WslRuntime({ platform: 'win32' });
    const calls = [];
    runtime._run = async args => {
      calls.push(args);
      if (args.includes('--verbose')) throw new Error('unsupported option');
      return { stdout: Buffer.from('Ubuntu\r\n', 'utf16le') };
    };
    assert.deepEqual(await runtime.listDistributions(), [
      { name: 'Ubuntu', state: null, version: null, default: false, system: false },
    ]);
    assert.deepEqual(calls, [['--list', '--verbose'], ['--list', '--quiet']]);
  });

  it('fails closed for WSL1 and does not execute commands inside system distributions', async () => {
    const runtime = new WslRuntime({ platform: 'win32' });
    let probes = 0;
    runtime.listDistributions = async () => [
      { name: 'Legacy', state: 'Stopped', version: 1, default: false, system: false },
      { name: 'docker-desktop', state: 'Running', version: 2, default: false, system: true },
    ];
    runtime._run = async () => { probes += 1; throw new Error('must not probe'); };
    const targets = await runtime.listTargets();
    assert.equal(probes, 0);
    assert.equal(targets[0].ready, false);
    assert.match(targets[0].error, /WSL2/);
    assert.equal(targets[1].system, true);
    assert.match(targets[1].error, /시스템 배포판/);
  });

  it('rejects WSL1 and system distributions before project API probes', async () => {
    const runtime = new WslRuntime({ platform: 'win32' });
    let probes = 0;
    runtime.listDistributions = async () => [
      { name: 'Legacy', state: 'Stopped', version: 1, default: false, system: false },
      { name: 'docker-desktop', state: 'Running', version: 2, default: false, system: true },
    ];
    runtime._run = async () => { probes += 1; throw new Error('must not probe'); };

    await assert.rejects(
      runtime.validateProject({ distro: 'Legacy', path: '/home/owner/app' }),
      /WSL1.*WSL2/,
    );
    await assert.rejects(
      runtime.discoverProjects({ distro: 'docker-desktop', root: '/home/owner/projects' }),
      /시스템 배포판/,
    );
    assert.equal(probes, 0);
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
    runtime.listDistributions = async () => [
      { name: 'Ubuntu', state: 'Running', version: 2, default: true, system: false },
    ];
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

  it('reports a missing WSL project path as invalid and the HTTP boundary rejects it', async () => {
    const runtime = new WslRuntime({ platform: 'win32' });
    runtime.listDistributions = async () => [
      { name: 'Ubuntu', state: 'Running', version: 2, default: true, system: false },
    ];
    runtime._run = async () => {
      throw Object.assign(new Error('test failed'), { result: { code: 1 } });
    };
    assert.deepEqual(await runtime.validateProject({ distro: 'Ubuntu', path: '/home/owner/missing' }), {
      valid: false, exists: false, git: false, path: '/home/owner/missing', distro: 'Ubuntu',
    });
    const server = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
    assert.match(server, /if \(!validated\.valid\)[\s\S]*선택한 WSL 배포판에 프로젝트 경로가 없습니다\.[\s\S]*}, 400\);/);
  });

  it('captures WSL candidate metadata before and after hashing', async () => {
    const runtime = new WslRuntime({ platform: 'win32' });
    let command = null;
    runtime._run = async args => {
      command = args;
      return { stdout: Buffer.from(`revision-one\nsha256:${'a'.repeat(64)}\n1\n0\n`) };
    };

    const snapshot = await runtime.candidateSnapshot({ distro: 'Ubuntu', path: '/home/owner/app' });
    const script = command[command.indexOf('-c') + 1];
    assert.equal(snapshot.digest, `sha256:${'a'.repeat(64)}`);
    assert.match(script, /before_metadata="\$\(git_metadata\)"/);
    assert.match(script, /after_metadata="\$\(git_metadata\)"/);
    assert.match(script, /candidate-metadata-changed/);
    assert.match(script, /dirty-submodule-candidate/);
    assert.ok(script.includes('status --porcelain=v2'));
    assert.ok(script.includes('fallback_manifest() { find . \\( -iname .git -o -iname node_modules \\) -prune'));
    assert.equal(
      script.match(/stat -c "%s:%y:%z:%i:%d"/g)?.length,
      4,
      'both Git and fallback snapshots must compare nanosecond mtime/ctime plus inode/device',
    );
    assert.ok(!script.includes('stat -c "%s:%Y:%Z:%i:%d"'));
  });

  it('preserves case-distinct WSL declarations instead of applying Windows deduplication', async () => {
    const runtime = new WslRuntime({ platform: 'win32' });
    let command = null;
    runtime._run = async args => {
      command = args;
      return { stdout: Buffer.from(`revision-case\nsha256:${'c'.repeat(64)}\n0\n2\n`) };
    };

    const snapshot = await runtime.candidateSnapshot({
      distro: 'Ubuntu', path: '/home/owner/app',
      declaredPaths: ['dist/Foo.bin', 'dist/foo.bin'],
    });
    assert.deepEqual(command.slice(-3), [
      '/home/owner/app', 'dist/Foo.bin', 'dist/foo.bin',
    ]);
    assert.deepEqual(snapshot.declaredPaths, ['dist/Foo.bin', 'dist/foo.bin']);
    assert.equal(snapshot.declaredPathCount, 2);
  });

  it('binds normalized declared paths as literal argv and fails closed on unsafe WSL symlinks', async () => {
    const runtime = new WslRuntime({ platform: 'win32' });
    let command = null;
    runtime._run = async args => {
      command = args;
      return { stdout: Buffer.from(`revision-two\nsha256:${'b'.repeat(64)}\n0\n2\n`) };
    };
    const literal = 'dist/artifact $(touch should-not-run).js';
    const snapshot = await runtime.candidateSnapshot({
      distro: 'Ubuntu', path: '/home/owner/app',
      declaredPaths: ['reports\\review.json', literal],
    });

    assert.deepEqual(command.slice(-3), [
      '/home/owner/app', literal, 'reports/review.json',
    ]);
    const script = command[command.indexOf('-c') + 1];
    assert.ok(!script.includes('should-not-run'), 'declared literals must never be interpolated into shell source');
    assert.match(script, /before_declared="\$\(declared_manifest "\$@"/);
    assert.match(script, /after_declared="\$\(declared_manifest "\$@"/);
    assert.match(script, /declared-path-outside-root/);
    assert.match(script, /declared-symlink-candidate/);
    assert.match(script, /sort -zu/);
    assert.deepEqual(snapshot.declaredPaths, [literal, 'reports/review.json']);
    assert.equal(snapshot.declaredPathCount, 2);
    assert.equal(snapshot.bindingMode, 'declared-paths.v1');
    assert.deepEqual(snapshot.declaredBindings, [
      { path: literal, state: 'bound' },
      { path: 'reports/review.json', state: 'bound' },
    ]);
  });

  it('rejects declared WSL traversal and protected paths before launching the distro', async () => {
    const runtime = new WslRuntime({ platform: 'win32' });
    let calls = 0;
    runtime._run = async () => { calls += 1; return { stdout: Buffer.alloc(0) }; };

    await assert.rejects(
      runtime.candidateSnapshot({ distro: 'Ubuntu', path: '/home/owner/app', declaredPaths: ['../outside.bin'] }),
      /must not traverse/,
    );
    await assert.rejects(
      runtime.candidateSnapshot({ distro: 'Ubuntu', path: '/home/owner/app', declaredPaths: ['node_modules/pkg'] }),
      /must not enter/,
    );
    assert.equal(calls, 0);
  });
});
