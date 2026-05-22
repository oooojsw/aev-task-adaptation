# audit-point-learnbench

This dataset splits the original audit-report-pilot task into single audit finding instances.
All instances read the same full valuation material directories from audit-report-pilot.
The shared material directories are read-only inputs. Do not copy them and do not grant edit access to them.
Each instance has a different hidden answer under answer/answer.md and a soft validator for exactly one audit point.

- train instances: audit-point-001 to audit-point-020
- intended fanout: 4 concurrent campaigns
- intended output per instance: one reusable skill plus workspace/audit-point-output.md
- writable paths per instance: only its own workspace/ and expert-workspace/