# Method: Sequential Refine

Status: active baseline

## Purpose

- This is the current baseline learning method for auto-evolve.
- It keeps the existing loop intact:
  - bootstrap
  - solve
  - evaluate
  - maintain experience
  - retry

## Notes

- This method should remain available as the default control baseline.
- Prompt instructions live under `prompts/`.
- Future methods should be added beside this one rather than replacing it.
