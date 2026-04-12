# Method: Sequential Refine

Status: active baseline

## Purpose

- This is the current baseline learning method for auto-evolve.
- It keeps the existing loop intact:
  - bootstrap
  - solve
  - evaluate
  - invoke knowledge maintainer
  - verify
  - retry

## Notes

- This method should remain available as the default control baseline.
- Prompt instructions live under `prompts/`.
- The knowledge maintainer agent updates the experience workspace under prompt-only constraints in this phase of the project.
- Future methods should be added beside this one rather than replacing it.
