You are updating the persistent expert experience after a failed solve attempt.

Your target is the Markdown knowledge pack:
{{knowledge_pack_block}}

Also read the user baseline file:
{{baseline_block}}

You may inspect reusable helper scripts here if relevant:
- {{scripts_dir}}

Failure context for attempt {{attempt}}:
- case id: {{case_id}}
- instruction: {{instruction}}
- materials:
{{material_list}}
- expected output: {{expected_path}}
- actual failed output: {{actual_path}}
- structured evaluation summary: {{evaluation_path}}
- simplified solve action trace: {{action_trace_path}}

{{refine_routing_block}}

Task:
1. Read the current knowledge pack files.
2. Read the failure context.
3. Read the simplified solve action trace so you understand what the agent actually tried.
4. Update one or more knowledge-pack files in place by using file-editing tools.

Refinement rules:
- Only file paths are provided in this prompt. File contents are not preloaded.
- You must explicitly use `read` and `list` to inspect the files and directories you need.
- Preserve still-useful knowledge.
- Keep the knowledge-pack content in Chinese by default unless the task explicitly requires another language.
- Treat the baseline file as user-provided context, not as proof.
- Add or revise only the lessons that help a fresh future solve agent avoid this failure.
- Prefer small, generalizable corrections over case-specific memorization.
- If the previous knowledge pack already contains the right rule, strengthen or clarify it instead of duplicating it.
- If the failure happened because the solve agent printed explanations instead of only the answer, strengthen the output-discipline section so exact-match cases return only the bare answer.
- Use the action trace to capture the solve agent's real behavior, not just the final mismatch.
- Prefer targeted file updates:
  - mission-level reusable guidance -> `core/expert_rules.md`
  - exact output discipline -> `core/output_contract.md`
  - repeatable procedure -> `core/execution_checklist.md`
  - reusable transformation rules -> `patterns/general_rules.md`
  - justified narrow special cases -> `patterns/exceptions.md`
  - recurring anti-patterns and lessons -> `lessons/failure_lessons.md`
- Update `manifest.md` only if the structure, load order, or file responsibilities need clarification.
- Do not use `bash`, web tools, or subagents for this task.
- Do not edit dataset files or the scripts library.

After updating the knowledge pack, reply with 3 to 6 short bullet points summarizing the failure lesson you added or revised and which files you changed. Do not paste the full files into chat.
