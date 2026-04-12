# Maintenance Op: Create Helper Asset

Summary: Create a workspace-local helper asset under `tools/` or `skills/` when a future solve agent would benefit from reusable local tooling.

- Keep helper assets inside `tools/` or `skills/` only.
- Prefer text-based assets such as `SKILL.md`, Python scripts, and JSON/TOML/YAML manifests.
- Make sure the workspace entry or a linked guide tells future agents when the asset should be used.
