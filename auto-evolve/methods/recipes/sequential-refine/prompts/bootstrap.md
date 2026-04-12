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
3. Replace the minimal seed with a final experience workspace structure that you judge to be appropriate.

Requirements for the experience workspace:
- The file paths listed in this prompt are paths only. Their contents are not preloaded for you.
- You must explicitly use `read` and `list` to inspect the files and directories you need.
- The main expert experience should live in Markdown.
- Write the experience workspace in Chinese by default unless a case explicitly requires another language.
- The workspace must have one single entry file. The current entry path is shown above.
- A future blank solve agent should start from the entry file, then selectively read downstream files instead of reading every file blindly.
- You are free to replace the minimal seed layout. Do not preserve old placeholder structure just because it already exists.
- You may create rule modules, output-contract files, execution guides, exception modules, partition indexes, task routers, and tool guides only if they help the final structure.
- If future solve behavior would benefit from local reusable helper assets, you may create text-based helper assets under `tools/` or `skills/`.
- Every expert-experience Markdown file outside `tools/` or `skills/` should include an `auto-evolve-role` marker near the top.
- The template library is only a reference source. Do not copy it mechanically into the final workspace.
- Keep the actual rules and expert experience in Markdown documents, not in TypeScript and not in the shared scripts library.
- Do not blindly copy the baseline file into the workspace; only keep ideas that survive the labeled evidence.
- Do not merely memorize raw answers or case IDs unless that information is genuinely reusable.
- Make the output-discipline guidance explicit enough that a future solve agent understands exact-match tasks fail if it prints explanations or extra characters.
- Keep the guidance practical enough that a fresh future solve agent can follow it without seeing prior chats.
- Do not edit dataset files or the shared scripts library.

Labeled training cases by path:
{{case_blocks}}

After updating the experience workspace, reply with 3 to 6 short bullet points summarizing what you wrote, how you organized the workspace, and which files you changed. Do not paste the full files into chat.
