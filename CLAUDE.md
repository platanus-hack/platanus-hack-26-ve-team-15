# CLAUDE.md — Claude Code Harness Configuration

@AGENTS.md

---

## Claude Code Specific Configuration

### 1. Model Pairing & Advisor Strategy

This project pairs **Claude Sonnet** as the primary execution engine with **Claude Opus** as senior advisor:

- Launch command: `claude --model sonnet --advisor opus` (configured in `.claude/settings.json` via `advisorModel: "opus"`).
- **Advisor Guidelines**:
  - Claude consults Opus at critical turning points (planning architecture, diagnosing repeating errors, verifying final completion).
  - You may also explicitly prompt: `"Consult the advisor on this plan before executing."`

### 2. Native Subagents (`.claude/agents/`)

Delegate tasks to dedicated subagents in isolated context windows:

- `@specifier`: Formulate acceptance criteria, OpenAPI contracts, and edge cases (no code).
- `@coder-tdd`: Red-Green TDD implementation; write failing specs first, then minimal code to pass.
- `@cleaner`: Behavior-preserving refactoring; reduce CRAP score < 8, eliminate duplication (DRY).
- `@architect-hardener`: Architecture review, differential mutation testing, and full Gauntlet certification.
- `@Explore`: Fast file mapping and symbol search on Haiku (bypasses CLAUDE.md for minimal token usage).
- `@docs`: Documentation and API reference retrieval on Haiku.
- `@code-reviewer`: In-depth code quality and type safety review on Sonnet.
- `@security-reviewer`: Secret audit and vulnerability scan on Sonnet.

### 3. Native Skills (`.claude/skills/`)

Skills load dynamically into context and double as slash commands:

- `/clean-ai-discipline`: Uncle Bob's Autonomous Trust Gauntlet (CRAP metric, differential mutation, SwarmForge handoffs).
- `/orch-build-mvp`: Fast MVP construction workflow.
- `/frontend-design`: Modern UI/UX guidelines and glassmorphism styling.
- `/backend-express-api`: RESTful APIs, error handling, and validation patterns.
- `/rag-ai-pipeline`: Vector retrieval and streaming pipelines.
- `/security-guardrails`: Simon Willison's Lethal Trifecta defenses.
- `/pitch-pack`: 2-minute demo script, slide outline, and judge Q&A prep.
- `/strategic-compact`: Milestone summarization protocol before `/compact`.
- `/token-budget-advisor`: Response depth selector (25%, 50%, 75%, 100%).

### 4. Quality Gauntlet & Token Optimization

- `npm run gauntlet`: Execute Uncle Bob's 5 Quality Gates before committing or ending a task.
- `npm run gauntlet:quick`: Fast hackathon mode (Gates 1, 2, 5).
- `npm run gauntlet:crap`: Inspect CRAP complexity scores (< 8) on modified files.
- `npm run gauntlet:mutate`: Run differential mutation testing to eliminate false-positive tests.
- `node scripts/handoff.js send <role> <task>`: Pass work via Git commit SHA to save 85% context tokens.
- `/usage`: Check active session token counts and model breakdown.
- `/context`: Inspect context window consumption.
- `/compact`: Condense conversation history at major milestones.
