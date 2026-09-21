# Install

A skill is a folder containing a `SKILL.md`. Installing one means copying that folder into a directory
your agent already searches for skills. There is no installer, package registry, or build step required.

Replace `mohamed23231` with the repository owner once the project is published.

## Clone once, copy the skill

```bash
git clone https://github.com/mohamed23231/skill-atelier.git
cd skill-atelier
```

From here, every install is a directory copy of `skills/architecture-visualizer`.

## Per-harness paths

The `.agents/skills/` directory is the cross-client standard from the
[Agent Skills specification](https://agentskills.io/specification) and works with the widest range of
clients. Client-specific paths are listed for convenience; check a harness's own documentation, since
these paths change between releases.

| Harness | Project | Personal |
| ------- | ------- | -------- |
| Cross-client standard | `.agents/skills/` | `~/.agents/skills/` |
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| OpenCode | `.opencode/skills/` | `~/.config/opencode/skills/` |
| GitHub Copilot | `.github/skills/`, `.claude/skills/`, `.agents/skills/` | `~/.copilot/skills/`, `~/.agents/skills/` |
| Cursor | `.agents/skills/` | `~/.agents/skills/` |
| Codex CLI | `.agents/skills/` | `~/.agents/skills/` |

Project install, using the cross-client path:

```bash
mkdir -p .agents/skills
cp -R skills/architecture-visualizer .agents/skills/architecture-visualizer
```

Personal install, available to every project:

```bash
mkdir -p ~/.agents/skills
cp -R skills/architecture-visualizer ~/.agents/skills/architecture-visualizer
```

Claude Code reads slash commands from a commands directory rather than from inside a skill folder, so
copy them separately if you want `/visualize`:

```bash
mkdir -p .claude/skills .claude/commands
cp -R skills/architecture-visualizer .claude/skills/architecture-visualizer
cp .claude/skills/architecture-visualizer/commands/*.md .claude/commands/
```

## Keep a checkout in sync with git

Both approaches keep one copy of the repository in your project and expose the skill through a symlink.
Symlinks work on macOS and Linux; on Windows, copy the folder instead.

### Subtree

```bash
git subtree add --prefix vendor/skill-atelier https://github.com/mohamed23231/skill-atelier.git main --squash
mkdir -p .agents/skills
ln -s ../../vendor/skill-atelier/skills/architecture-visualizer .agents/skills/architecture-visualizer
```

Update later with:

```bash
git subtree pull --prefix vendor/skill-atelier https://github.com/mohamed23231/skill-atelier.git main --squash
```

### Submodule

```bash
git submodule add https://github.com/mohamed23231/skill-atelier.git vendor/skill-atelier
mkdir -p .agents/skills
ln -s ../../vendor/skill-atelier/skills/architecture-visualizer .agents/skills/architecture-visualizer
```

## Optional: Claude Code plugin marketplace

Claude Code can install the skills in this repository as a plugin. This is optional and Claude-specific;
the copy-based install above stays the primary, vendor-neutral path.

```text
/plugin marketplace add mohamed23231/skill-atelier
/plugin install architecture-visualizer@skill-atelier
```

## Use the CLI without installing a skill

The `arch-viz` engine is a plain Node script. It runs against a local checkout with no install step.

```bash
node skills/architecture-visualizer/bin/arch-viz.js inspect .
node skills/architecture-visualizer/bin/arch-viz.js scaffold -o spec.json
node skills/architecture-visualizer/bin/arch-viz.js build spec.json -o dist/architecture.html --md dist/architecture.md
```

## Verify an install

```bash
# From the repository checkout: the structural checks and every skill's tests
node scripts/validate-repo.js
node scripts/test-all.js

# That the skill is discoverable: most harnesses list skills at session start.
# Ask the agent a question the skill's description matches, for example:
#   "Visualize how a login request flows through this service."
```

## Uninstall

Remove the copied folder, and the command files if you installed them.

```bash
rm -rf .agents/skills/architecture-visualizer
rm -f .claude/commands/visualize.md .claude/commands/architecture.md .claude/commands/design.md .claude/commands/review-architecture.md
```

## Update

```bash
cd skill-atelier
git pull --ff-only
cp -R skills/architecture-visualizer ~/.agents/skills/architecture-visualizer
```

Pin a tag or commit rather than `main` when you need reproducible installs.
