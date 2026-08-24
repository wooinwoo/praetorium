#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`Hermes source layout changed: ${label} insertion count is ${count}.`);
  return source.replace(needle, replacement);
}

function managedExecutable(root) {
  const candidates = process.platform === 'win32'
    ? [join(root, 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'), join(root, 'hermes-agent', 'bin', 'hermes.exe')]
    : [join(root, 'hermes-agent', 'venv', 'bin', 'hermes'), join(root, 'hermes-agent', 'bin', 'hermes')];
  return candidates.find(existsSync) || null;
}

function patchFile(path, marker, transform) {
  const source = readFileSync(path, 'utf8');
  if (source.includes(marker)) return false;
  writeFileSync(path, transform(source), 'utf8');
  return true;
}

export function patchHermesRuntime(root = process.env.HERMES_HOME || join(homedir(), '.hermes')) {
  const hermes = managedExecutable(root);
  if (!hermes) throw new Error(`Hermes executable not found under ${root}.`);
  const version = execFileSync(hermes, ['--version'], { encoding: 'utf8' }).trim();
  if (!/Hermes Agent v0\.20\.5\b/.test(version)) throw new Error(`Expected Hermes Agent v0.20.5, got: ${version}`);

  const agentRoot = join(root, 'hermes-agent');
  const runtimeProvider = join(agentRoot, 'hermes_cli', 'runtime_provider.py');
  const appServerClient = join(agentRoot, 'agent', 'transports', 'codex_app_server.py');
  const codexRuntime = join(agentRoot, 'agent', 'codex_runtime.py');
  const kanbanDb = join(agentRoot, 'hermes_cli', 'kanban_db.py');
  for (const path of [runtimeProvider, appServerClient, codexRuntime, kanbanDb]) {
    if (!existsSync(path)) throw new Error(`Hermes source file not found: ${path}`);
  }

  patchFile(runtimeProvider, 'PRAETORIUM_CODEX_APP_SERVER_AUTH_BRIDGE_V1', source => replaceOnce(
    source,
    '    requested_provider = resolve_requested_provider(requested)',
    `    requested_provider = resolve_requested_provider(requested)\n\n    # PRAETORIUM_CODEX_APP_SERVER_AUTH_BRIDGE_V1\n    _praetorium_model_cfg = _get_model_config()\n    if (\n        requested_provider in {"openai", "openai-codex"}\n        and str(_praetorium_model_cfg.get("openai_runtime") or "").strip().lower()\n        == "codex_app_server"\n    ):\n        return {\n            "provider": "openai-codex",\n            "api_mode": "codex_app_server",\n            "base_url": DEFAULT_CODEX_BASE_URL,\n            "api_key": "praetorium-local-codex-app-server",\n            "source": "codex-cli-local-auth",\n            "requested_provider": requested_provider,\n        }`,
    'runtime provider',
  ));

  patchFile(appServerClient, 'PRAETORIUM_DIRECTOR_BOARD_ROOT_BRIDGE_V1', source => replaceOnce(
    source,
    '        if spawn_env.get("HERMES_KANBAN_TASK"):',
    '        # PRAETORIUM_DIRECTOR_BOARD_ROOT_BRIDGE_V1\n        if spawn_env.get("HERMES_KANBAN_TASK") or spawn_env.get("HERMES_KANBAN_BOARD"):',
    'Director board root',
  ));

  patchFile(appServerClient, 'PRAETORIUM_WINDOWS_TOML_ROOT_BRIDGE_V1', source => replaceOnce(
    source,
    '            app_server_args.extend(',
    '            # PRAETORIUM_WINDOWS_TOML_ROOT_BRIDGE_V1\n            kanban_root = str(kanban_root).replace("\\\\", "/")\n            app_server_args.extend(',
    'writable root',
  ));

  patchFile(appServerClient, 'PRAETORIUM_READ_ONLY_ROLE_BRIDGE_V1', source => {
    let patched = replaceOnce(
      source,
      '        app_server_args = list(extra_args or [])',
      `        app_server_args = list(extra_args or [])\n        # PRAETORIUM_READ_ONLY_ROLE_BRIDGE_V1\n        _praetorium_read_only = (\n            spawn_env.get("PRAETORIUM_DIRECTOR_MODE") == "true"\n            or spawn_env.get("PRAETORIUM_REVIEWER_MODE") == "true"\n        )\n        if _praetorium_read_only:\n            app_server_args.extend(["-c", 'sandbox_mode="read-only"'])`,
      'read-only args',
    );
    patched = replaceOnce(
      patched,
      '        if spawn_env.get("HERMES_KANBAN_TASK") or spawn_env.get("HERMES_KANBAN_BOARD"):',
      '        if not _praetorium_read_only and (spawn_env.get("HERMES_KANBAN_TASK") or spawn_env.get("HERMES_KANBAN_BOARD")):',
      'read-only board guard',
    );
    return patched;
  });

  patchFile(codexRuntime, 'PRAETORIUM_PROJECT_CWD_BRIDGE_V1', source => replaceOnce(
    source,
    '        cwd = getattr(agent, "session_cwd", None) or str(resolve_agent_cwd())',
    `        # PRAETORIUM_PROJECT_CWD_BRIDGE_V1\n        import os as _praetorium_os\n\n        cwd = (\n            _praetorium_os.environ.get("PRAETORIUM_PROJECT_CWD")\n            or getattr(agent, "session_cwd", None)\n            or str(resolve_agent_cwd())\n        )`,
    'project cwd',
  ));

  patchFile(kanbanDb, 'PRAETORIUM_WORKER_LIFECYCLE_BRIDGE_V1', source => {
    let patched = replaceOnce(
      source,
      '    profile_arg = normalize_profile_name(task.assignee)',
      '    profile_arg = normalize_profile_name(task.assignee)\n\n    # PRAETORIUM_WORKER_LIFECYCLE_BRIDGE_V1',
      'worker profile',
    );
    patched = replaceOnce(
      patched,
      '    prompt = f"work kanban task {task.id}"',
      `    prompt = (\n        f"Work Kanban task {task.id}. Read the full card before acting. "\n        "You must finish the durable board lifecycle before your final answer: "\n        "call the kanban_complete tool with evidence and artifacts on success, "\n        "or kanban_block with the concrete blocker. Plain text is not completion."\n    )`,
      'worker prompt',
    );
    return replaceOnce(
      patched,
      '    env["HERMES_KANBAN_TASK"] = task.id',
      '    if profile_arg.endswith("-reviewer"):\n        env["PRAETORIUM_REVIEWER_MODE"] = "true"\n    env["HERMES_KANBAN_TASK"] = task.id',
      'reviewer environment',
    );
  });

  return { root, hermes, version };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : undefined;
  const result = patchHermesRuntime(root);
  process.stdout.write(`Praetorium Hermes bridge ready: ${result.version}\n`);
}
