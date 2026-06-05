<!-- auto-evolve-role: failure_lessons -->
# Cross-Round Failure Lessons

Status: updated through round-002

## Purpose

- This file accumulates failed paths across campaign rounds.
- A deployment-time blank agent should read this file before following the execution checklist.
- Only stable, task-relevant lessons from actual failed paths should remain here.

## Latest Campaign State

- title: audit-report-pilot-campaign
- rounds_completed: 2
- latest_status: graph_completed
- latest_summary: All work units completed and all required completion validators passed.

## Stable Failed-Path Lessons

- Execution claim failed: Attempted synthesize-expert-workspace, but did not return a structured claim.
- Execution claim failed: Expert workspace has manifest.md, change_log.md, surface_contract.json but is MISSING output_contract.md listed in surface_contract.json documents array
  causes: output_contract.md is referenced in surface_contract.json documents array but does not exist in expert-workspace dire... | Cannot claim pass when a required artifact is absent
  next_fix: Create output_contract.md or remove its reference from surface_contract.json to achieve layout consistency

## Retry Guidance That Emerged From Failures

- Execution claim failed: Attempted synthesize-expert-workspace, but did not return a structured claim. -> Follow the current unit check plan before returning claimed_success=true: Update the tracked expert workspace with stable rules, output contract, and execution guidance. The bla...
- Execution claim failed: Expert workspace has manifest.md, change_log.md, surface_contract.json but is MISSING output_contract.md listed in surface_contract.json documents array -> Create output_contract.md or remove its reference from surface_contract.json to achieve layout consistency

## Blank-Agent Execution System Blockers and Bypasses

- Keep only system-level blockers observed during blank-agent execution and concrete bypass guidance for next round.

- none yet

## Generalized Learning That Survived Across Rounds

- Must return structured JSON claim when unit completes; failure was 'did not return structured claim'
- High-level framework description in manifest.md is insufficient for blank-agent operational extraction - derivation paths must be specific (cell addresses, formula locations, reconciliation algorithms)
- High-level framework description in manifest.md is insufficient for blank-agent operational extraction - derivation paths must be specific (cell addresses, formula locations, reconciliation algorithms)
- surface_contract.json documents array must be consistent with actual files on disk - a missing file listed in the contract causes validation failure even if other artifacts are present

## Round Chronology

- round-001: graph_completed | closure=closed_repairable | AI covered 6/28 human audit points (21.4% coverage). Main gaps: specific cell references, PPI adjustment calculations, equipment depreciation details | failures=1 retry_lessons=1 learning_units=1
- round-002: graph_completed | closure=closed_success | All work units completed and all required completion validators passed. | failures=1 retry_lessons=1 learning_units=3
