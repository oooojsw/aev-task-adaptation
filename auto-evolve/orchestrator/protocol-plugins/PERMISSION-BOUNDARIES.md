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

## Declared external-directory traversal

The new driver explicitly supplies permissionExternalPaths derived from declared
read/edit paths. The host grants external-directory traversal for these directories
only, retaining separate deny-by-default read/list/edit checks. Without that field,
legacy external-directory rules remain byte-for-byte equivalent in fixed fixtures.
This avoids blocking staged public materials outside the author workDir, without
granting sibling private-file reads or source-file writes.

host-permissions.test.ts extracts actual pure generation functions from host source
and uses the actual fromConfig/evaluate/Wildcard.match implementations, not a copied
matching algorithm. It compares default output to the pre-upgrade Git source and
verifies public read, private read denial, output edit, source edit denial and
disabled tool permissions. Source hashes are retained in fixture evidence.

Remaining audit: actual complete host tool calls, Campaign role read directories
and private-data visibility. This guard does not
provide OS process isolation or solve link replacement races during execution.
No production deployment or historical evidence modification is implied.
