---
description: Run the 14-point quality gate against an architecture spec
argument-hint: [path to architecture.json]
---

Run the architecture-visualizer quality gate on: $ARGUMENTS

```bash
node .claude/skills/architecture-visualizer/bin/arch-viz.js validate $ARGUMENTS --repo-root .
```

Read the skill's `references/reasoning-checklist.md`, then report each gate that warns, why it warns, and the
smallest spec change that would clear it. Judge the checks the CLI cannot decide mechanically (comprehension,
arrow semantics, animation meaning) yourself.
