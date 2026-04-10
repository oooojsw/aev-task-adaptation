# Judge Skill Toolkit

This directory contains project-local judge skills for the Soft Judge Agent.

These judge skills are not globally exposed.
They are only referenced by path inside judge runs.

## Available Skills

- exact-output
  - purpose: summarize exact output comparison and mismatch evidence
  - folder: judge-skills/exact-output
- tool-failures
  - purpose: summarize observed tool failures
  - folder: judge-skills/tool-failures
- session-behavior
  - purpose: summarize session behavior patterns from events and execution reports
  - folder: judge-skills/session-behavior
