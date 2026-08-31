#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import {
  existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

function replaceOnce(source, needle, replacement, label) {
  const normalizedSource = source.replace(/\r\n/g, '\n');
  const normalizedNeedle = needle.replace(/\r\n/g, '\n');
  const normalizedReplacement = replacement.replace(/\r\n/g, '\n');
  const count = normalizedSource.split(normalizedNeedle).length - 1;
  if (count !== 1) throw new Error(`Hermes source layout changed: ${label} insertion count is ${count}.`);
  return normalizedSource.replace(normalizedNeedle, normalizedReplacement);
}

function managedExecutable(root) {
  const candidates = process.platform === 'win32'
    ? [join(root, 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'), join(root, 'hermes-agent', 'bin', 'hermes.exe')]
    : [join(root, 'hermes-agent', 'venv', 'bin', 'hermes'), join(root, 'hermes-agent', 'bin', 'hermes')];
  return candidates.find(existsSync) || null;
}

function patchFile(staged, path, marker, transform) {
  const source = staged.get(path) ?? readFileSync(path, 'utf8');
  if (source.includes(marker)) return false;
  staged.set(path, transform(source));
  return true;
}

function commitPatches(staged, replaceFile = renameSync) {
  const prepared = [];
  try {
    for (const [path, source] of staged) {
      const original = readFileSync(path);
      if (original.toString('utf8') === source) continue;
      const suffix = `${process.pid}-${randomUUID()}`;
      const temporary = `${path}.praetorium-${suffix}.tmp`;
      const backup = `${path}.praetorium-${suffix}.bak`;
      const entry = { path, temporary, backup, committed: false, preserveBackup: false };
      prepared.push(entry);
      writeFileSync(temporary, source, { encoding: 'utf8', mode: statSync(path).mode });
      writeFileSync(backup, original, { mode: statSync(path).mode });
    }
    for (const entry of prepared) {
      replaceFile(entry.temporary, entry.path);
      entry.committed = true;
    }
  } catch (error) {
    const rollbackFailures = [];
    for (const entry of [...prepared].reverse()) {
      if (!entry.committed) continue;
      try { replaceFile(entry.backup, entry.path); }
      catch (rollbackError) {
        entry.preserveBackup = true;
        rollbackFailures.push(`${entry.path}: ${rollbackError.message}`);
      }
    }
    const detail = rollbackFailures.length ? ` Rollback failed for ${rollbackFailures.join('; ')}` : ' Applied files were rolled back.';
    throw new Error(`Hermes patch commit failed.${detail}`, { cause: error });
  } finally {
    for (const entry of prepared) {
      rmSync(entry.temporary, { force: true });
      if (!entry.preserveBackup) rmSync(entry.backup, { force: true });
    }
  }
  return prepared.length;
}

export const _test = { commitPatches, replaceOnce };

export function patchHermesRuntime(
  root = process.env.HERMES_HOME || join(homedir(), '.hermes'),
  getVersion = hermes => execFileSync(hermes, ['--version'], { encoding: 'utf8' }),
) {
  const hermes = managedExecutable(root);
  if (!hermes) throw new Error(`Hermes executable not found under ${root}.`);
  const version = String(getVersion(hermes)).trim();
  if (!/Hermes Agent v0\.20\.5\b/.test(version)) throw new Error(`Expected Hermes Agent v0.20.5, got: ${version}`);

  const agentRoot = join(root, 'hermes-agent');
  const runtimeProvider = join(agentRoot, 'hermes_cli', 'runtime_provider.py');
  const appServerClient = join(agentRoot, 'agent', 'transports', 'codex_app_server.py');
  const codexRuntime = join(agentRoot, 'agent', 'codex_runtime.py');
  const codexPluginMigration = join(agentRoot, 'hermes_cli', 'codex_runtime_plugin_migration.py');
  const kanbanDb = join(agentRoot, 'hermes_cli', 'kanban_db.py');
  const kanbanTools = join(agentRoot, 'tools', 'kanban_tools.py');
  for (const path of [runtimeProvider, appServerClient, codexRuntime, codexPluginMigration, kanbanDb, kanbanTools]) {
    if (!existsSync(path)) throw new Error(`Hermes source file not found: ${path}`);
  }
  const staged = new Map();

  patchFile(staged, runtimeProvider, 'PRAETORIUM_CODEX_APP_SERVER_AUTH_BRIDGE_V1', source => replaceOnce(
    source,
    '    requested_provider = resolve_requested_provider(requested)',
    `    requested_provider = resolve_requested_provider(requested)\n\n    # PRAETORIUM_CODEX_APP_SERVER_AUTH_BRIDGE_V1\n    _praetorium_model_cfg = _get_model_config()\n    if (\n        requested_provider in {"openai", "openai-codex"}\n        and str(_praetorium_model_cfg.get("openai_runtime") or "").strip().lower()\n        == "codex_app_server"\n    ):\n        return {\n            "provider": "openai-codex",\n            "api_mode": "codex_app_server",\n            "base_url": DEFAULT_CODEX_BASE_URL,\n            "api_key": "praetorium-local-codex-app-server",\n            "source": "codex-cli-local-auth",\n            "requested_provider": requested_provider,\n        }`,
    'runtime provider',
  ));

  patchFile(staged, appServerClient, 'PRAETORIUM_DIRECTOR_BOARD_ROOT_BRIDGE_V1', source => replaceOnce(
    source,
    '        if spawn_env.get("HERMES_KANBAN_TASK"):',
    '        # PRAETORIUM_DIRECTOR_BOARD_ROOT_BRIDGE_V1\n        if spawn_env.get("HERMES_KANBAN_TASK") or spawn_env.get("HERMES_KANBAN_BOARD"):',
    'Director board root',
  ));

  patchFile(staged, appServerClient, 'PRAETORIUM_WINDOWS_TOML_ROOT_BRIDGE_V1', source => replaceOnce(
    source,
    '            app_server_args.extend(',
    '            # PRAETORIUM_WINDOWS_TOML_ROOT_BRIDGE_V1\n            kanban_root = str(kanban_root).replace("\\\\", "/")\n            app_server_args.extend(',
    'writable root',
  ));

  patchFile(staged, appServerClient, 'PRAETORIUM_READ_ONLY_ROLE_BRIDGE_V1', source => {
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

  patchFile(staged, codexRuntime, 'PRAETORIUM_PROJECT_CWD_BRIDGE_V1', source => replaceOnce(
    source,
    '        cwd = getattr(agent, "session_cwd", None) or str(resolve_agent_cwd())',
    `        # PRAETORIUM_PROJECT_CWD_BRIDGE_V1\n        import os as _praetorium_os\n\n        cwd = (\n            _praetorium_os.environ.get("PRAETORIUM_PROJECT_CWD")\n            or getattr(agent, "session_cwd", None)\n            or str(resolve_agent_cwd())\n        )`,
    'project cwd',
  ));

  patchFile(staged, kanbanDb, 'PRAETORIUM_WORKER_LIFECYCLE_BRIDGE_V1', source => {
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

  patchFile(staged, kanbanDb, 'PRAETORIUM_CODEX_WORKER_CONSOLE_ENV_V1', source => replaceOnce(
    source,
    '    env["HERMES_KANBAN_TASK"] = task.id',
    '    # PRAETORIUM_CODEX_WORKER_CONSOLE_ENV_V1\n    env["PRAETORIUM_WORKER_CONSOLE"] = "true"\n    env["HERMES_KANBAN_TASK"] = task.id',
    'Codex Worker console environment',
  ));

  patchFile(staged, kanbanDb, 'PRAETORIUM_WORKER_CONTEXT_PROMPT_V2', source => replaceOnce(
    source,
    `    prompt = (
        f"Work Kanban task {task.id}. Read the full card before acting. "
        "You must finish the durable board lifecycle before your final answer: "
        "call the kanban_complete tool with evidence and artifacts on success, "
        "or kanban_block with the concrete blocker. Plain text is not completion."
    )`,
    `    # PRAETORIUM_WORKER_CONTEXT_PROMPT_V2
    # Put the authoritative card directly into Codex's first user message.
    # Making the model rediscover its own task through tools caused needless
    # board exploration and could violate a narrow command allowlist.
    try:
        with connect_closing(board=board) as _praetorium_context_conn:
            _praetorium_worker_context = build_worker_context(
                _praetorium_context_conn, task.id
            )
    except Exception as _praetorium_context_error:
        _log.warning(
            "kanban worker: full context render failed for %s: %s",
            task.id, _praetorium_context_error,
        )
        _praetorium_worker_context = (
            f"# Kanban task {task.id}: {task.title}\\n\\n"
            f"## Body\\n{task.body or '(no body)'}"
        )
    prompt = (
        f"{_praetorium_worker_context}\\n\\n"
        "## Execution contract\\n"
        "The card above is the complete authoritative Director instruction. "
        "Do not inspect the board database or search for the card; it is already included. "
        "Respect every command, read, write, and delegation restriction literally. "
        "Publish the requested public checkpoints as task comments. "
        # PRAETORIUM_WORKER_NATIVE_LIFECYCLE_V3
        "Use the native kanban_complete or kanban_block tool; never invoke "
        "hermes kanban through the shell. "
        "Finish the durable board lifecycle before your final answer: call the "
        "kanban_complete tool with evidence and artifacts on success, or "
        "kanban_block with the concrete blocker. Plain text is not completion."
    )`,
    'authoritative Worker context prompt',
  ));

  patchFile(staged, codexPluginMigration, 'PRAETORIUM_CODEX_MCP_LIFECYCLE_ENV_V1', source => replaceOnce(
    source,
    `    if env:
        out["env"] = env
    # Generous timeouts`,
    `    if env:
        out["env"] = env
    # PRAETORIUM_CODEX_MCP_LIFECYCLE_ENV_V1
    # Codex intentionally forwards only explicitly allowlisted parent variables
    # into stdio MCP children. Kanban tools are registered from this per-run
    # context, so omitting it makes a successful Worker unable to comment,
    # complete, block, or heartbeat its durable task.
    out["env_vars"] = [
        "HERMES_HOME",
        "HERMES_KANBAN_TASK",
        "HERMES_KANBAN_DB",
        "HERMES_KANBAN_BOARD",
        "HERMES_KANBAN_WORKSPACES_ROOT",
        "HERMES_KANBAN_WORKSPACE",
        "HERMES_KANBAN_RUN_ID",
        "HERMES_KANBAN_CLAIM_LOCK",
        "HERMES_PROFILE",
        "PRAETORIUM_PROJECT_CWD",
        "PRAETORIUM_WORKER_CONSOLE",
    ]
    out["required"] = True
    # Generous timeouts`,
    'Codex MCP lifecycle environment',
  ));

  patchFile(staged, kanbanDb, 'PRAETORIUM_WORKER_ROLE_BOUNDARY_V1', source => replaceOnce(
    source,
    '        f"{_praetorium_worker_context}\\n\\n"',
    `        # PRAETORIUM_WORKER_ROLE_BOUNDARY_V1
        f"{_praetorium_worker_context}\\n\\n"
        "## Worker identity\\n"
        f"You are the already-created assigned Worker running profile {profile_arg}. "
        "Owner-objective language about creating, assigning, managing, or monitoring Workers is Director context only. "
        "Execute only the card's assigned [ACTION] yourself. Do not impersonate the Director. "
        "Never spawn, delegate to, or manage subagents, child Workers, or additional sessions; "
        "the Praetorium Director exclusively owns the visible Worker graph. "`,
    'explicit Worker identity and delegation boundary',
  ));

  patchFile(staged, kanbanDb, 'PRAETORIUM_WORKER_NATIVE_LIFECYCLE_V3', source => replaceOnce(
    source,
    `        "Publish the requested public checkpoints as task comments. "
        "Finish the durable board lifecycle before your final answer: call the "`,
    `        "Publish the requested public checkpoints as task comments. "
        # PRAETORIUM_WORKER_NATIVE_LIFECYCLE_V3
        "Use the native kanban_complete or kanban_block tool; never invoke "
        "hermes kanban through the shell. "
        "Finish the durable board lifecycle before your final answer: call the "`,
    'native Worker lifecycle tool instruction',
  ));

  patchFile(staged, kanbanTools, 'PRAETORIUM_CODEX_NATIVE_STEER_BRIDGE_V1', source => replaceOnce(
    source,
    '        return bool(agent.steer(note))',
    `        # PRAETORIUM_CODEX_NATIVE_STEER_BRIDGE_V1
        # A Codex app-server turn owns its internal tool loop. Deliver live
        # operator guidance through turn/steer instead of Hermes' next-tool
        # result queue, while preserving the legacy path for other runtimes.
        if getattr(agent, "api_mode", None) == "codex_app_server":
            redirect = getattr(agent, "redirect", None)
            accepted = bool(redirect(note)) if callable(redirect) else False
        else:
            accepted = bool(agent.steer(note))
        # PRAETORIUM_CODEX_NATIVE_STEER_ASCII_V2
        if accepted and os.environ.get("PRAETORIUM_WORKER_CONSOLE") == "true":
            print(f"\\n\\033[96m[DIRECTOR -> WORKER]\\033[0m\\n{note}\\n", flush=True)
        return accepted`,
    'native Codex Worker steer',
  ));

  patchFile(staged, kanbanTools, 'PRAETORIUM_CODEX_NATIVE_STEER_ASCII_V2', source => {
    const pattern = /        if accepted and os\.environ\.get\("PRAETORIUM_WORKER_CONSOLE"\) == "true":\r?\n            print\(f"[^\r\n]*\r?\n/;
    const matches = source.match(new RegExp(pattern.source, 'g')) || [];
    if (matches.length !== 1) throw new Error(`Hermes source layout changed: native steer console repair count is ${matches.length}.`);
    return source.replace(
      pattern,
      '        # PRAETORIUM_CODEX_NATIVE_STEER_ASCII_V2\n        if accepted and os.environ.get("PRAETORIUM_WORKER_CONSOLE") == "true":\n            print(f"\\n\\033[96m[DIRECTOR -> WORKER]\\033[0m\\n{note}\\n", flush=True)\n',
    );
  });

  patchFile(staged, codexRuntime, 'PRAETORIUM_CODEX_WORKER_TRACE_BRIDGE_V1', source => {
    let patched = replaceOnce(
      source,
      '    started: dict[str, tuple[str, dict, float]] = {}',
      `    started: dict[str, tuple[str, dict, float]] = {}

    # PRAETORIUM_CODEX_WORKER_TRACE_BRIDGE_V1
    # The Kanban process already owns a real Codex app-server thread. Mirror
    # its public operational event stream to stdout so the per-task log is the
    # same session transcript an interactive Codex client would render.
    import os as _praetorium_os
    _praetorium_trace_enabled = (
        _praetorium_os.environ.get("PRAETORIUM_WORKER_CONSOLE") == "true"
    )
    _praetorium_streamed_items: set[str] = set()
    _praetorium_open_sections: set[str] = set()

    def _praetorium_console(text: Any = "", *, end: str = "\\n") -> None:
        if not _praetorium_trace_enabled:
            return
        print(str(text), end=end, flush=True)

    def _praetorium_item_text(item: dict) -> str:
        parts = []
        for content in item.get("content") or []:
            if isinstance(content, dict) and content.get("type") in {
                "text", "input_text", "output_text"
            }:
                value = content.get("text") or ""
                if value:
                    parts.append(str(value))
        return "\\n".join(parts)

    def _praetorium_trace_event(method: str, params: dict) -> None:
        if not _praetorium_trace_enabled:
            return
        if method == "turn/started":
            turn = params.get("turn") or {}
            _praetorium_console(
                f"\\n\\033[90m-- Codex turn {str(turn.get('id') or '')[:12]} --\\033[0m"
            )
            return
        if method == "turn/completed":
            turn = params.get("turn") or {}
            _praetorium_console(
                f"\\n\\033[90m-- turn {turn.get('status') or 'completed'} --\\033[0m"
            )
            return
        if method == "turn/plan/updated":
            _praetorium_console("\\n\\033[94mPLAN\\033[0m")
            for entry in params.get("plan") or []:
                if not isinstance(entry, dict):
                    continue
                state = entry.get("status") or "pending"
                mark = "[x]" if state in {"completed", "complete"} else "[>]" if state in {"inProgress", "in_progress"} else "[ ]"
                _praetorium_console(f"  {mark} {entry.get('step') or ''}")
            return
        if method == "item/reasoning/summaryTextDelta":
            key = f"reasoning:{params.get('itemId') or ''}"
            if key not in _praetorium_open_sections:
                _praetorium_open_sections.add(key)
                _praetorium_console("\\n\\033[95mREASONING SUMMARY\\033[0m")
            _praetorium_console(params.get("delta") or "", end="")
            return
        if method == "item/reasoning/textDelta":
            # Raw hidden reasoning is deliberately not exposed. Codex's
            # readable summary stream above is the public reasoning surface.
            return
        if method == "item/agentMessage/delta":
            item_id = str(params.get("itemId") or "")
            key = f"agent:{item_id}"
            if key not in _praetorium_open_sections:
                _praetorium_open_sections.add(key)
                _praetorium_console("\\n\\033[92mCodex\\033[0m")
            _praetorium_streamed_items.add(item_id)
            _praetorium_console(params.get("delta") or params.get("text") or "", end="")
            return
        if method == "item/commandExecution/outputDelta":
            _praetorium_console(params.get("delta") or "", end="")
            return
        if method in {"warning", "error", "configWarning"}:
            error = params.get("error") or {}
            message = params.get("message") or params.get("summary") or error.get("message") or "Codex runtime warning"
            _praetorium_console(f"\\n\\033[91m! {message}\\033[0m")
            return

        item = params.get("item")
        if not isinstance(item, dict):
            return
        item_type = item.get("type") or ""
        item_id = str(item.get("id") or "")
        if method == "item/started" and item_type == "userMessage":
            text = _praetorium_item_text(item)
            if text:
                _praetorium_console(f"\\n\\033[96mDirector -> Worker\\033[0m\\n{text}")
        elif method == "item/started" and item_type == "commandExecution":
            command = item.get("command") or ""
            if isinstance(command, list):
                command = " ".join(str(part) for part in command)
            cwd = item.get("cwd") or ""
            _praetorium_console(f"\\n\\033[93m$ {command}\\033[0m")
            if cwd:
                _praetorium_console(f"\\033[90m  cwd: {cwd}\\033[0m")
        elif method == "item/completed" and item_type == "commandExecution":
            code = item.get("exitCode")
            duration = item.get("durationMs")
            suffix = f" / {duration}ms" if duration is not None else ""
            _praetorium_console(f"\\n\\033[90m[exit {code if code is not None else '?'}{suffix}]\\033[0m")
        elif method in {"item/started", "item/completed"} and item_type == "fileChange":
            verb = "editing" if method == "item/started" else "files changed"
            paths = [str(change.get("path") or "") for change in item.get("changes") or [] if isinstance(change, dict)]
            _praetorium_console(f"\\n\\033[94m{verb}: {', '.join(path for path in paths if path) or 'file change'}\\033[0m")
        elif method == "item/started" and item_type in {"mcpToolCall", "dynamicToolCall", "webSearch", "collabToolCall", "imageView"}:
            name = item.get("tool") or item.get("query") or item_type
            server = item.get("server")
            label = f"{server}/{name}" if server else name
            _praetorium_console(f"\\n\\033[94m> {label}\\033[0m")
        elif method == "item/completed" and item_type == "agentMessage" and item_id not in _praetorium_streamed_items:
            text = item.get("text") or ""
            if text:
                _praetorium_console(f"\\n\\033[92mCodex\\033[0m\\n{text}")
        elif method == "item/completed" and item_type == "contextCompaction":
            _praetorium_console("\\n\\033[90m[context compacted]\\033[0m")`,
      'Codex event bridge state',
    );
    patched = replaceOnce(
      patched,
      `        if not isinstance(params, dict):
            params = {}`,
      `        if not isinstance(params, dict):
            params = {}
        try:
            _praetorium_trace_event(method, params)
        except Exception:
            logger.debug("Praetorium Codex trace bridge raised", exc_info=True)`,
      'Codex event trace dispatch',
    );
    return patched;
  });

  patchFile(staged, codexRuntime, 'PRAETORIUM_CODEX_EVENT_STEER_POLL_V1', source => replaceOnce(
    source,
    `        try:
            _praetorium_trace_event(method, params)
        except Exception:
            logger.debug("Praetorium Codex trace bridge raised", exc_info=True)`,
    `        try:
            _praetorium_trace_event(method, params)
        except Exception:
            logger.debug("Praetorium Codex trace bridge raised", exc_info=True)
        # PRAETORIUM_CODEX_EVENT_STEER_POLL_V1
        # App-server owns the long-running inner loop, so normal Hermes
        # activity callbacks may not fire while a turn is busy. Poll the
        # durable comment bridge from the Codex notification stream itself.
        if _praetorium_trace_enabled:
            try:
                from tools.kanban_tools import inject_new_comments_from_env
                inject_new_comments_from_env(agent)
            except Exception:
                logger.debug("Praetorium Codex steer poll raised", exc_info=True)`,
    'Codex event-driven steer poll',
  ));

  const changedFiles = commitPatches(staged);
  return { root, hermes, version, changedFiles };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : undefined;
  const result = patchHermesRuntime(root);
  process.stdout.write(`Praetorium Hermes bridge ready: ${result.version}\n`);
}
