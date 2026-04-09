You are initializing the persistent expert experience for the auto-evolve system.

Your target is a Markdown knowledge pack.

{{knowledge_pack_block}}

Also read the user baseline file:
{{baseline_block}}

You may inspect reusable helper scripts here if they are relevant:
- {{scripts_dir}}

Task:
1. Study the listed labeled training cases by reading them from their paths.
2. Distill stable, reusable expert experience from those material/result pairs.
3. Create or replace the knowledge-pack files above by using file-editing tools inside this repository.

Requirements for the knowledge pack:
- The file paths listed in this prompt are paths only. Their contents are not preloaded for you.
- You must explicitly use `read` and `list` to inspect the files and directories you need.
- Write Markdown only.
- Write the knowledge-pack content in Chinese by default unless a case explicitly requires another language.
- Keep the rules in the knowledge-pack documents, not in TypeScript and not in the scripts library.
- Do not blindly copy the baseline file into the knowledge pack; only keep ideas that survive the labeled evidence.
- Preserve a clear separation of responsibility across files:
  - `manifest.md` explains purpose and load order.
  - `core/expert_rules.md` holds mission-level reusable expert guidance.
  - `core/output_contract.md` defines exact output discipline.
  - `core/execution_checklist.md` defines repeatable solve steps.
  - `patterns/general_rules.md` holds reusable transformation rules.
  - `patterns/exceptions.md` holds narrow, justified exceptions.
  - `lessons/failure_lessons.md` holds stable anti-patterns and failure lessons.
- Do not merely memorize raw answers or case IDs unless that information is genuinely reusable.
- Make the output-contract file explicit enough that a future solve agent understands that exact-match cases fail if it prints any explanation or extra characters.
- Keep the guidance practical enough that a fresh future solve agent can follow it without seeing prior chats.
- Do not edit dataset files or the scripts library.

Labeled training cases by path:
{{case_blocks}}

After updating the knowledge pack, reply with 3 to 6 short bullet points summarizing what you wrote and which files you changed. Do not paste the full files into chat.
