---
name: orch-build-mvp
description: Zero-to-one MVP construction workflow for hackathons. Guides the agent to identify core demo value, generate foundational code, connect APIs, and verify user flows in record time.
metadata:
  origin: curated-hackathon
---

# Skill: Orchestrated MVP Builder (`orch-build-mvp`)

Accelerates the construction of high-impact Hackathon Minimum Viable Products (MVPs) in hours rather than days.

## When to Trigger:
- User says: "build an MVP", "hackathon project", "prototipo rápido", "start from scratch", "0 to 1".
- Initial stage of any new system idea.

## 4-Step Hackathon Sprint Workflow:

### Step 1: Scope Compression (The 1-Feature Rule)
In a hackathon, a working, gorgeous 1-feature product always beats a half-finished 5-feature monolith.
- Identify the single "Hero Flow" (what the judges must see).
- Ruthlessly defer non-critical scope (complex billing, email confirmations, nested settings).

### Step 2: Foundation & Scaffolding
- Deploy the starter scaffold:
  ```bash
  npm run scaffold fullstack-web
  # or
  npm run scaffold ai-backend
  ```
- Configure `.env` with API keys and mock databases.

### Step 3: Implement & Connect
- Build the core business logic or AI pipeline first.
- Connect the frontend with modern UI aesthetics (clean dark mode, vibrant accents, instant feedback).
- Add defensive error states and loading skeletons so the demo never hangs or crashes in front of judges.

### Step 4: Verification & Opus Checkpoint
- Verify end-to-end user flow:
  1. User enters input $\rightarrow$ 2. AI/System processes $\rightarrow$ 3. Result displays dynamically.
- Submit final check to Opus Advisor before declaring done.
