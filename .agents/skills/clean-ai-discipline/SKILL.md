---
name: clean-ai-discipline
description: "Uncle Bob's Autonomous AI Trust Gauntlet and SwarmForge methodology. Enforces strict TDD, CRAP complexity thresholds (< 8), differential mutation testing, and token-saving git handoffs."
---

# Clean AI Discipline & The Autonomous Trust Gauntlet

Inspired by **Robert C. Martin (Uncle Bob)**, author of *Clean Code*, and his multi-agent orchestration platform **SwarmForge** (`github.com/unclebob/swarm-forge`).

---

## 1. The Core Philosophy: Why We Don't Read AI Code

> *"I do not read the code my AI agents write. I trust them because they cannot commit or finish a task until they pass through a strict mechanical gauntlet."*  
> — Robert C. Martin ("Uncle Bob")

Manual line-by-line code review cannot keep up with AI generation velocity. Asking humans to review hundreds of lines of AI-generated boilerplate leads to "rubber-stamping" and hallucination leaks.

Instead, we bind AI agents to a **Mechanical Proof Loop**:
1. AI cannot write code without a failing test first.
2. AI cannot leave complex code without high test coverage (CRAP metric `< 8`).
3. AI cannot write superficial tests (differential mutation testing kills fake assertions).
4. AI agents operate in specialized roles with isolated context windows to avoid token bloat.

---

## 2. The Five Non-Negotiable Quality Gates (`npm run gauntlet`)

Before considering any task, issue, or feature complete, run:

```bash
npm run gauntlet          # Strict production mode (all 5 gates)
npm run gauntlet:quick    # Quick hackathon mode (Gates 1, 2, 5)
```

| Gate | Check | Tool | Uncle Bob Rule |
|---|---|---|---|
| **Gate 1** | Secret & Credential Leak Scan | `agent-shield` | Zero `.env`, keys, or tokens in diffs or code. |
| **Gate 2** | TDD Specs & Behavioral Tests | `npm test` | 100% green tests; specs must pass without errors. |
| **Gate 3** | CRAP Complexity Metric | `scripts/gauntlet/crap-score.js` | `CRAP = CC² × (1 - cov)³ + CC < 8`. High complexity code without tests is rejected. |
| **Gate 4** | Differential Mutation Testing | `scripts/gauntlet/differential-mutator.js` | Invert AST conditions and operators. **Zero surviving mutants**. |
| **Gate 5** | Architectural Boundaries | `code-reviewer` / `architect-hardener` | Clean Architecture dependency rule: business logic never imports frameworks. |

---

## 3. The CRAP Metric Explained

The **CRAP (Change Risk Anti-Pattern)** metric measures the risk of modifying a function:

$$\text{CRAP}(m) = \text{CC}^2 \times (1 - \text{cov})^3 + \text{CC}$$

- $\text{CC}$ = Cyclomatic Complexity (number of decision branches: `if`, `for`, `while`, `case`, `&&`, `||`, ternary).
- $\text{cov}$ = Test statement/branch coverage (0.0 to 1.0).

### Threshold Guide
| CRAP Score | Rating | Action Required |
|---|---|---|
| **1 – 4.9** | Clean | Well-tested, low complexity. Certified green. |
| **5 – 7.9** | Acceptable | Moderate complexity; verify edge cases. |
| **8.0+** | **CRAPPY (FAIL)** | **Gauntlet Blocked**. Split the function or add unit tests until CRAP < 8. |

Run standalone:
```bash
npm run gauntlet:crap              # Evaluate changed git files
node scripts/gauntlet/crap-score.js --threshold 8 path/to/file.js
```

---

## 4. Differential Mutation Testing (Mutant Killer)

Unit tests often pass with 100% code coverage without actually testing anything (e.g., tests without assertions, or assertions that always evaluate to true).

Mutation testing programmatically injects intentional bugs into changed code:
- Inverts comparisons (`>` $\to$ `<=`, `===` $\to$ `!==`)
- Flips booleans (`true` $\to$ `false`)
- Swaps logical operators (`&&` $\to$ `||`)

### The Outcome
- **Mutant KILLED (Green)**: The test suite caught the bug and failed.
- **Mutant SURVIVED (Red / Blocker)**: The test suite still passed despite the bug! The tests are fake or incomplete.

```bash
npm run gauntlet:mutate            # Run mutation on git diff
node scripts/gauntlet/differential-mutator.js --scan   # Preview mutation sites
```

---

## 5. SwarmForge Multi-Agent Workflows

IA-Template provides two curated SwarmForge configurations:

### Option A: The Fast 2-Pack (Hackathons & Quick Features)
1. **`@coder-tdd`**: Writes failing unit specs first, then writes minimal production code to turn them green.
2. **`@cleaner`**: Takes green code, runs CRAP analysis, extracts helpers to bring CRAP < 8, and removes code duplication (DRY) without breaking existing tests.

### Option B: The Disciplined 4-Pack (Pro & Critical Systems)
1. **`@specifier`**: Writes Gherkin acceptance criteria, OpenAPI schemas, and edge case matrices. **Never writes production code.**
2. **`@coder-tdd`**: Implements behavior slices following Red-Green TDD.
3. **`@cleaner`**: Refactors functions, enforces DRY, and reduces CRAP complexity below 8.
4. **`@architect-hardener`**: Checks module boundaries and runs the full Gauntlet (`npm run gauntlet`) with mutation testing.

---

## 6. Extreme Token Conservation: Git Handoff Protocol

Traditional multi-agent chat accumulates massive context (10,000+ tokens per agent turn), causing slowdowns, high costs, and hallucinations.

SwarmForge solves this by replacing chat memory with **Git Commits + Structured File Handoffs**:

1. Subagent A finishes its slice, runs tests, and creates a git commit.
2. Subagent A dispatches a minimal handoff:
   ```bash
   node scripts/handoff.js send cleaner auth-jwt "Implemented auth slice with 4 unit specs"
   ```
3. Subagent B starts in a **fresh context window** and reads only the handoff:
   ```bash
   node scripts/handoff.js next cleaner
   ```
4. Subagent B loads only `git show --stat <commit>` (~150 tokens) instead of reading the entire conversational transcript, saving up to **85% of tokens**.
