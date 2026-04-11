You are initializing the persistent expert experience for the auto-evolve system.

Your target is a final experience workspace that may contain expert Markdown plus controlled local helper assets.

{{experience_workspace_block}}

You may also inspect the reference template library:
{{template_library_block}}

Also read the user baseline file:
{{baseline_block}}

You may inspect reusable helper scripts here if they are relevant:
- {{scripts_dir}}

Task:
1. Study the listed labeled training cases by reading them from their paths.
2. Distill stable, reusable expert experience from those material/result pairs.
3. Build an initial experience workspace that is friendly to future additive maintenance.

Requirements for the experience workspace:
- The file paths listed in this prompt are paths only. File contents are not preloaded for you.
- You must explicitly use `read` and `list` to inspect the files and directories you need.
- The main expert experience should live in Markdown.
- Write the experience workspace in Chinese by default unless a case explicitly requires another language.
- The workspace must have one single entry file.
- The final workspace must still be a valid auto-evolve experience workspace after you finish, not just a useful note collection.
- A future blank solve agent should start from the entry file, then selectively read downstream files.
- Organize the initial workspace so future additive maintenance can append lessons, local patches, or tool guidance without broad rewrites.
- If future solve behavior would benefit from local reusable helper assets, you may create text-based helper assets under `tools/` or `skills/`.
- Every expert-experience Markdown file outside `tools/` or `skills/` should include an `auto-evolve-role` marker near the top.
- The workspace must keep a `change_log.md` expert Markdown file with `auto-evolve-role: change_log`.
- Do not create hidden or internal directories such as `.opencode`, `.git`, `.tmp`, `.cache`, or scratch/test-record folders inside the experience workspace.
- Do not create Markdown files outside the expert workspace structure unless they are intentional expert documents with a clear `auto-evolve-role` marker.
- Do not create helper assets anywhere except `tools/` or `skills/`.
- If you create helper assets, the entry file or a linked guide must explain when a future solve agent should use them.
- The template library is only a reference source. Do not copy it mechanically into the final workspace.
- Keep the actual rules and expert experience in Markdown documents, not in TypeScript and not in the shared scripts library.
- Do not edit dataset files or the shared scripts library.
- Before finishing, self-check that the final workspace keeps exactly one entry file, keeps the change log, and would pass the workspace layout validation rules above.

Labeled training cases by path:
{{case_blocks}}

After updating the experience workspace, reply with 3 to 6 short bullet points summarizing what you wrote, how you organized the workspace for additive maintenance, and which files you changed. Do not paste the full files into chat.
