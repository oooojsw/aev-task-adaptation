# Opt-in tool permission boundaries

The existing host builds deny-by-default read/list/edit rules from declared
paths and denies shell when allowShell=false. Legacy open configuration with
an empty read list selects makeOpenPermissions; its behavior is not changed by
this work. The opt-in driver instead rejects empty read/edit permission lists
before invoking that host. This is an entry guard, not a legacy default change.

validateToolRequest clones the caller request through the driver, requires
absolute non-pattern paths, an existing canonical directory workDir and existing
canonical read paths. Edit paths must remain inside workDir; missing output paths
are allowed only through canonical existing parents. Symlinks/junction aliases
are rejected before backend invocation. Shell and implicit retries stay disabled.
Helper source identity is bound into the backend fingerprint.

Supported caller paths:
- tool-session.ts stages only declared Skill/public material; workspace is writable.
- merge-stage.ts stages source Skill entries; output entries alone are writable.
- instance-repair.ts stages public materials; declared candidate entries are writable.

The tests verify empty lists, wildcard paths, external edits, missing reads and
linked ancestors block. Actual driver tests confirm malformed paths produce zero
backend calls and no started claim. Tests of staged request lists are distinct
from proving actual OpenCode tool enforcement against every adversarial action.

Remaining audit: generated permission configuration plus actual host tool checks,
Campaign role read directories and private-data visibility. This guard does not
provide OS process isolation or solve link replacement races during execution.
No production deployment or historical evidence modification is implied.
