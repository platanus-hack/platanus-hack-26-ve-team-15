---
name: strategic-compact
description: Context compaction and memory preservation workflow. Condenses long conversational histories into structured state checkpoints before hitting context limits.
metadata:
  origin: curated-hackathon
---

# Skill: Strategic Context Compaction (`strategic-compact`)

Prevents agent performance degradation and context window exhaustion by summarizing past milestones and clearing dead token weight.

## When to Trigger:
- Context window exceeds ~70% capacity.
- Moving from Phase 1 (Planning & Scaffolding) to Phase 2 (Implementation).
- After completing a large refactor or debugging session.

## Compaction Protocol:
1. **Extract Milestone Summary**:
   - What features have been completed and verified?
   - What decisions were locked?
   - What is the immediate next priority?
2. **Purge Ephemeral Artifacts**:
   - Discard raw build error traces, verbose test dumps, and temporary logs.
3. **Execute Compaction**:
   - In Claude Code, run `/compact`.
   - Re-anchor context using `CLAUDE.md` and the distilled milestone summary.
