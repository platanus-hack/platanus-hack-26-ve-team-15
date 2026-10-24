---
name: prompt-caching
description: Maximize LLM prompt caching hit rate to reduce API costs up to 90% and slash response latency. Analyzes prompt structure and preserves stable prefix order.
metadata:
  origin: community
---

# Skill: Prompt Caching Strategy

Optimizes prompt structure to achieve maximum cache hit rates across Anthropic, OpenAI, and Gemini models.

## How Prompt Caching Works:
When the prefix of your prompt remains byte-for-byte identical across consecutive requests:
- **Anthropic Claude**: Slashes input costs by **90%** on cache reads (`$0.30/M` vs `$3.00/M` on Sonnet).
- **Latency**: Reduces Time-To-First-Token (TTFT) significantly.

## Golden Rules for Caching:
1. **Preserve a Stable Prefix**:
   ```text
   [Stable Prefix - 100% Cached]
   ├── System Persona & Master Directives (CLAUDE.md)
   ├── Subagent Definitions & Tool Schemas
   └── Core Coding Guidelines & Architecture Map
   
   [Dynamic Suffix - Fresh Content]
   ├── Current User Prompt / Feature Request
   ├── Fresh Terminal Command Output
   └── Active File Diffs
   ```
2. **Never Inject Timestamps or Random Nonces into System Prompts**:
   Dynamic values in the system prefix invalidate the cache for all subsequent tokens.
3. **Run Cost Simulations**:
   ```bash
   npm run tokens sim 10000
   ```
