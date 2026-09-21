# Backends

20 backends ship with the framework, and every one of them is **supported on every machine**.
Whether a CLI is installed here is a separate question — run `fleet.js discover`. What the installed
version really does is a third — run `fleet.js doctor`.

The table below is generated from the adapters themselves, so it cannot drift from the code.
`verified` means proven against a real CLI during this project's verification runs; `documented`
means sourced from vendor docs or a cross-referenced upstream project but not proven here; `—` means
the CLI genuinely cannot do it; `unknown` means not established, which is never treated as support.

| Backend | CLI | edit | readOnly | resumeById | modelSelection | effort | structuredOutput | Brief via |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `claude` | `claude` | verified | verified | verified | verified | verified | verified | argv |
| `codex` | `codex` | verified | verified | verified | verified | verified | verified | argv |
| `cursor` | `cursor-agent` | verified | verified | verified | verified | — | verified | argv |
| `opencode` | `opencode` | verified | verified | verified | verified | verified | verified | argv |
| `gemini` | `gemini` | verified | verified | — | verified | — | verified | argv |
| `agy` | `agy` | verified | verified | verified | verified | verified | verified | argv |
| `copilot` | `copilot` | documented | unknown | unknown | documented | unknown | unknown | argv |
| `aider` | `aider` | documented | documented | — | documented | — | — | argv |
| `crush` | `crush` | documented | unknown | unknown | unknown | — | unknown | argv |
| `qwen` | `qwen` | documented | documented | — | documented | — | documented | argv |
| `grok` | `grok` | documented | documented | documented | documented | documented | documented | file |
| `kimi` | `kimi` | documented | — | documented | documented | — | documented | argv |
| `zcode` | `zcode` | documented | documented | documented | — | — | documented | file |
| `cline` | `cline` | documented | documented | — | documented | — | documented | stdin |
| `pi` | `pi` | documented | documented | documented | documented | — | documented | stdin |
| `omp` | `omp` | documented | documented | documented | documented | documented | documented | stdin |
| `vibe` | `vibe` | documented | documented | documented | — | — | — | argv |
| `warp` | `oz` | documented | — | documented | documented | — | documented | argv |
| `commandcode` | `cmd` | documented | documented | documented | documented | documented | documented | stdin |
| `qoder` | `qodercli` | documented | documented | documented | documented | — | documented | argv |

Run `doctor` and these become facts about *your* machine: it promotes `documented` to `verified`
where the installed CLI really has the flag, and demotes it to `—` where it does not.

## What `verified` means in this table

`verified` records that the capability was exercised against a real installation of that CLI on
macOS (arm64) while the adapter was written, and each adapter's `evidence` field carries the method
and date. Everything else is marked `documented` or `unknown`.

None of that is evidence about *your* machine, and the framework does not treat it as such: a
declared `verified` reads as `documented` until `doctor` has run where you are. Run it, and this
table stops mattering — your `.delegate-fleet/verification.json` is the authority, for your CLI
versions.

## Honest limits worth knowing

- **Only `codex` has a sandbox-enforced read-only.** `--sandbox read-only` is an OS-level
  restriction. Every other backend's read-only is a *withheld tool surface* — strong, but enforced
  by the CLI's own permission model, not the kernel.
- **`warp` and `kimi` have no read-only at all.** The framework refuses `--read-only` on them rather
  than pretending a prompt makes it so.
- **Write runs are wide.** With `--yolo`, `--force`, `--auto` or `--dangerously-skip-permissions`,
  the brief's path list is guidance, not containment. `repository.changed` is how you find out what
  really happened. Use a worktree or a container when writes outside the tree are unacceptable.
- **`aider` commits by default.** Both `--auto-commits` and `--dirty-commits` default on, and the
  second commits *your* pre-existing uncommitted work before editing. Both are forced off and are
  deliberately not configurable through this relay.
- **`opencode` needs `--auto` to write.** Without it a headless run blocks on a permission prompt.
  Its read-only is the built-in `plan` agent; there is no `--read-only` flag.
- **`commandcode`'s CLI is named `cmd`** (`cmdc` on Windows), which can collide with an unrelated
  binary on PATH. Set `workers.commandcode.cli` to an absolute path if it does.
- **`zcode` ships its CLI inside the desktop app** and only its `plan` and `yolo` modes work
  headlessly; the others exit 0 having changed nothing, which this framework reports as `noop`.
- **Model ids rot.** Prefer the aliases a backend resolves itself, and record what actually ran.

## Providers are not backends

DeepSeek, GLM, Qwen-the-model, Kimi-the-model, Mistral, and any local model served by Ollama or
LM Studio are **model providers**, not agent CLIs. They have no file tools and cannot execute a
slice on their own. You reach them through a provider-agnostic backend's `modelSelection`:

```bash
# DeepSeek through OpenCode
node scripts/relay.js --backend opencode --model deepseek/deepseek-chat --brief …

# A local model through OpenCode or Aider — no account, no per-token cost
node scripts/relay.js --backend opencode --model ollama/qwen2.5-coder --brief …
```

`opencode`, `crush`, `aider` and `pi` are the provider-agnostic ones. Shipping a "deepseek backend"
would be fiction: there is no `deepseek` agent CLI to invoke. Shipping DeepSeek *reachable through*
a backend is real, and it is what this framework does.

`ollama` is deliberately **not** a backend for the same reason. `ollama run <model> "<prompt>"` has
no file access, no tools, and cannot edit a repository; it only prints text. Point a real agent CLI
at your Ollama endpoint instead.

## Adding one

See [extending.md](extending.md). One file, no fork required.
