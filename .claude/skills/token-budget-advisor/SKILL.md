---
name: token-budget-advisor
description: Offers a choice of response depth (25%/50%/75%/100%) to control verbosity and token expenditure. Use when the user requests concise or budget-conscious answers.
metadata:
  origin: community
---

# Skill: Token Budget Advisor (TBA)

Controls output token expenditure by tailoring response depth to user requirements.

## When to Trigger:
- User mentions: "token budget", "short version", "tldr", "ahorrar tokens", "25% depth", "50% depth", "detailed answer".
- User wants upfront control over verbosity and token burn.

## Response Depth Levels:
| Level | Depth | Target Size | Content Included |
|---|---|---|---|
| **[1] Essential** | 25% | 2-4 sentences max | Direct solution, minimal diff, zero conversational filler |
| **[2] Moderate** | 50% | 1-3 paragraphs | Working code + essential rationale + 1 verification check |
| **[3] Detailed** | 75% | Structured doc | Full implementation + error handling + edge cases |
| **[4] Exhaustive** | 100% | Full deep dive | Architecture breakdown, trade-offs, benchmarks, full tests |

## Real-time Token Monitoring:
Use Claude Code's native session telemetry commands:
- `/usage`: View exact token consumption and cost breakdown across models in the active session.
- `/context`: Visualize active context window occupancy and identify context-heavy tools or files.
- `/compact`: Compress conversational history when context approaches limits.
