# Security Policy

## Reporting a vulnerability

Do not open a public issue for a security problem.

Use GitHub's private vulnerability reporting for this repository: open the **Security** tab, choose
**Report a vulnerability**, and describe the issue. If private reporting is unavailable, contact a
maintainer privately through their GitHub profile.

Please include:

- what the issue is and why it is a security problem;
- the affected skill and version (or the commit you tested);
- reproduction steps, a proof of concept, or the exact command you ran;
- the impact you believe it has;
- any suggested fix, if you have one.

## What to expect

- Acknowledgement within a few days.
- An assessment and a proposed timeline after the report is reproduced.
- A note in the release that fixes the issue, crediting the reporter unless you prefer to stay anonymous.

This is a volunteer project, so timelines are best-effort. Please allow reasonable time before disclosing
publicly.

## Scope

Skill Atelier ships instructions and local scripts. The relevant attack surfaces are:

- **Skill instructions.** A skill is text an agent will follow. Malicious or careless instructions can
  cause an agent to read, modify, or transmit data. Report content that appears designed to exfiltrate
  data, disable safeguards, or run unreviewed commands.
- **Bundled scripts.** Anything under a skill's `scripts/` or `bin/` directory runs locally with the
  privileges of the user who invoked it. Report unsafe file handling, command injection, or path
  traversal.
- **Generated output.** The `architecture-visualizer` emits a standalone HTML file. Report ways an
  untrusted spec JSON could produce script execution or leak files when the page is opened.

## Out of scope

- Vulnerabilities in third-party agents, editors, or operating systems. Report those to the relevant
  vendor.
- The behaviour of an agent that ignores a skill's instructions. Skills guide an agent; they do not
  sandbox it.
- Social-engineering findings that require the user to run an obviously destructive command.

## Supported versions

The repository is pre-1.0 and moves quickly. Security fixes target the latest release and the `main`
branch. If you depend on a specific commit, watch the repository for security-tagged releases.
