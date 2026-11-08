---
name: review-changes
description: Review the current Git changes for correctness, regressions, and missing validation when the user asks for a code review. Report findings without editing files.
---

1. Read the repository's applicable instructions and inspect `git status`.
2. Read staged and unstaged diffs. Inspect relevant untracked source files without opening credentials or environment files.
3. Follow changed behavior through callers, guards, and tests. Look for observable failures rather than style preferences.
4. Run relevant read-only checks if the repository supplies them and they fit the user's request. Ask before checks that modify data or use paid services.
5. Report actionable findings with file locations, the triggering conditions, and their consequences. Distinguish verified failures from hypotheses.
6. If there are no findings, say so and name any meaningful validation gaps. Do not commit, publish, or fix code unless asked.
