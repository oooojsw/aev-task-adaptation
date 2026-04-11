# Propagation Method: Single Branch Baseline

Status: initial third-layer method

## Purpose

- Create one experimental branch from an existing experience commit.
- Reuse one second-layer maintenance method on that branch.
- Evaluate the resulting branch without touching the live canonical workspace.

## What It Proves

- Third-layer experiments can contain second-layer methods instead of replacing them.
- The system can snapshot canonical experience, materialize a branch workspace, run a delegated maintenance route, and store the resulting candidate commit.

## Current Scope

- One source ref
- One branch
- One delegated second-layer maintenance method
- No merge
- No promotion
- No multi-branch comparison yet
