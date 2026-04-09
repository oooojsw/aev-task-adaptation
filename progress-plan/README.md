# Progress Plan

This folder is the living planning space for the `auto-evolve` work inside this repository.

Use it to track:

- current project status
- completed work
- next-phase plans
- raw user ideas and goals
- important architectural decisions

## Folder Files

- `CURRENT_STATUS.md`
  - current state of the system, what works now, and what is still weak
- `WORK_LOG.md`
  - dated record of what has already been built
- `NEXT_STEPS.md`
  - recommended next actions and phased roadmap
- `IDEAS_RAW.md`
  - raw user goals, direct intent notes, and future experimentation directions
- `DECISIONS.md`
  - important architectural choices and current working assumptions

## Update Rule

When we finish meaningful work, update at least:

1. `WORK_LOG.md`
2. `CURRENT_STATUS.md`
3. `NEXT_STEPS.md` if priorities changed

## Current Focus

The immediate goal is no longer just "make the loop run once".

The goal is to evolve this into an experimentable training framework that can:

- extract reusable expert experience
- guide a fresh agent from zero
- generalize to new cases
- support multiple refinement strategies
- support parallel experiments with isolated sessions and isolated knowledge states
