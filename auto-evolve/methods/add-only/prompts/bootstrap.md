You are initializing the persistent expert experience for the auto-evolve system.

Your target is an experience workspace of Markdown documents.

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
- Write Markdown only.
- Write the experience workspace in Chinese by default unless a case explicitly requires another language.
- The workspace must have one single entry file.
- A future blank solve agent should start from the entry file, then selectively read downstream files.
- Organize the initial workspace so future additive maintenance can append lessons, local patches, or tool guidance without broad rewrites.
- Every Markdown file you keep in the final workspace should include an `auto-evolve-role` marker near the top.
- The template library is only a reference source. Do not copy it mechanically into the final workspace.
- Keep the actual rules and expert experience in Markdown documents, not in TypeScript and not in the scripts library.
- Do not edit dataset files or the scripts library.

Labeled training cases by path:
{{case_blocks}}

After updating the experience workspace, reply with 3 to 6 short bullet points summarizing what you wrote, how you organized the workspace for additive maintenance, and which files you changed. Do not paste the full files into chat.
