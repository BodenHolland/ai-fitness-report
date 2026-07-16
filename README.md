# Cultivation Mode

An evidence-grounded discipline for how AI systems should interact with people —
so the tool builds the user's capability instead of quietly eroding it.

It is **not** "make the AI withhold answers." It's a **router**: classify what a
given request is actually optimizing, then apply the intervention that matches —
because the credible evidence contains two different problems that need two
different, sometimes opposite, responses, and most requests need neither.

> **Honest ceiling:** the strongest evidence supports *damage-avoidance*, not
> acceleration. The defensible claims are "this keeps the AI from eroding your
> skill" and "this reduces your odds of trusting a wrong answer" — never "this
> makes you smarter or faster."

---

## The idea

The default assistant paradigm is a single slider: *how much does the AI help?*,
with the implicit belief that more help is always better and that performance
**while the tool is present** is the outcome that matters.

The most credible evidence breaks that slider. Performance and the human
capability underneath it can move in **opposite directions**. So the real design
question isn't a setting — it's a **prior classification**:

> For *this* request, am I optimizing the assisted output, the user's future
> unaided skill, or the user's resistance to a wrong model?

Those three goals need structurally different machines:

| Regime | When | Intervention |
|---|---|---|
| **Skill-building** | User is learning something they'll later do without AI | **Withhold + fade** — elicit their attempt first, give the smallest hint that unblocks, fade support as competence grows |
| **Expert decision** | An already-competent user makes a consequential, checkable call where over-trusting the AI is the risk | **Commit-first + cheap-to-check** — get their read first, then surface one verifiable claim; *no* confidence scores or "here's my reasoning" (they backfire) |
| **Offload** | No learning goal, nothing rides on being wrong | **Just do it** — answer fully and fast, easy to spot-check. *Most requests live here.* |

Applying skill-building or expert-decision friction to an offload task is a pure
tax with no payoff.

---

## Research

1. **Performance ≠ learning.** Answer-giving AI lifts assisted performance but
   leaves *unaided* performance null-to-negative once removed. Preregistered
   classroom RCT: bare ChatGPT left students ~17% worse on an unaided exam
   (−0.054 SD); a hint-only, answer-withholding tutor **erased** the harm
   (−0.004, n.s.) — but added no gain over no AI.
   [Bastani et al., *PNAS* 2025](https://www.pnas.org/doi/10.1073/pnas.2422633122).
   Corroborated by [Fan et al., *BJET* 2025](https://doi.org/10.1111/bjet.13544)
   ("metacognitive laziness") and
   [Bassner et al., *Computers & Education: AI* 2026](https://www.sciencedirect.com/science/article/pii/S2666920X25001778).

2. **Automation bias reaches experts, and training doesn't remove it.** When the
   AI's suggestion was wrong, even very experienced radiologists collapsed from
   82.3% → 45.5% accuracy.
   [Dratsch et al., *Radiology* 2023](https://pubs.rsna.org/doi/10.1148/radiol.222176);
   [Parasuraman & Manzey, *Human Factors* 2010](https://journals.sagepub.com/doi/10.1177/0018720810376055).
   - **What reduces it:** cognitive forcing (commit before reveal), and making the
     AI's error salient and cheap to verify.
   - **What backfires:** confidence scores and plain explanations — they read as
     competence signals and *increase* blind trust. **Transparency is not
     scrutiny.**

3. **Withholding helps people with a schema but hurts true novices**
   (expertise-reversal) → scaffolding must be expertise-adaptive, never blanket.
   Underpinned by the robust pre-AI mechanisms: retrieval practice (g≈0.51),
   generation effect (d≈0.40), intelligent tutoring systems (d≈0.43–0.76).

---

## What's in this repo

| File | What it is |
|---|---|
| [`cultivation.ts`](./cultivation.ts) | **The product router.** Server-side code for an app's backend: classify each request into a regime and return the matching system prompt before calling the model. Provider-agnostic (OpenRouter-compatible `/chat/completions`). |
| [`skills/cultivation-mode/SKILL.md`](./skills/cultivation-mode/SKILL.md) | **The behavioral skill.** The same discipline as a portable instruction set — installable as a Claude/Agent Skill, or pasted into any model as a system prompt to change how it talks to *you*. |
| [`skills/ai-fitness-report/SKILL.md`](./skills/ai-fitness-report/SKILL.md) | **The audit skill.** Drives `audit.ts` end-to-end using in-context classification — no external API, nothing leaves your Claude Code trust boundary. Invoke in a fresh chat: "generate my AI fitness report." |
| [`audit.ts`](./audit.ts) | **The audit script.** Walks `~/.claude/projects/*.jsonl`, extracts your prompts, and generates the report. Two paths: driven by the audit skill (stays local, uses subscription), or headless via OpenRouter (unattended, uses free tier that trains on data). |

**Two different jobs:** the skill changes how a model talks to *you* in a chat;
the router changes how *your app's* AI talks to *your users*, automatically.

---

## Using the router

```ts
import { route } from './cultivation'

const { regime, systemPrompt } = await route(userText, {
  apiKey: process.env.OPENROUTER_API_KEY!,
  ctx: { surfaceGoal: 'decide', expertise: 'expert', stakes: 'high' },
})
// then send [{ role: 'system', content: systemPrompt }, ...history] to your model
```

Design notes baked in:

- **Skip the classifier when you can.** If the product surface already knows the
  goal, pass `ctx.surfaceGoal` and routing is free (no extra LLM call). Reserve
  the classifier for genuinely open-ended chat.
- **The escape hatch overrides everything.** "just tell me" forces plain offload,
  regardless of regime — withholding is only legitimate because the user can opt
  out instantly.
- **Fail open.** Any classifier error routes to offload. The failure mode is never
  "silently withhold."

---

## Installing the skill

The skill ships in installable form at
[`skills/cultivation-mode/SKILL.md`](./skills/cultivation-mode/SKILL.md).

```bash
# Claude Code — personal (available in every project)
mkdir -p ~/.claude/skills/cultivation-mode
cp skills/cultivation-mode/SKILL.md ~/.claude/skills/cultivation-mode/

# or per-project
mkdir -p .claude/skills/cultivation-mode
cp skills/cultivation-mode/SKILL.md .claude/skills/cultivation-mode/
```

Then invoke it by name (or let it auto-trigger on a relevant request); it stays
active for the rest of that conversation. In any other tool, paste the body of
`SKILL.md` (everything below the frontmatter) as a system prompt / custom
instruction.

---

## Running the audit

Two paths — same report either way.

### A) Through Claude Code (recommended — stays local)

Install the audit skill, then invoke it in a fresh Claude Code chat:

```bash
mkdir -p ~/.claude/skills/ai-fitness-report
cp skills/ai-fitness-report/SKILL.md ~/.claude/skills/ai-fitness-report/
```

Then in Claude Code:

> "Generate my AI fitness report."

Claude will `cd` to this repo, extract your prompts, classify them in-context (no external API), write them to the local cache, and generate an HTML report opened in your default browser. Uses your existing Claude Code subscription; nothing leaves your machine → Anthropic trust boundary.

### B) Headless via OpenRouter

Unattended — good for full-archive one-shots, but the default free-tier model trains on your prompts.

```bash
export OPENROUTER_API_KEY=sk-or-...
node --experimental-strip-types audit.ts --sample 5 --out ai-fitness-report.html
node --experimental-strip-types audit.ts --out ai-fitness-report.html    # full archive
```

Flags: `--sample N`, `--dump` (write prompts file for external classifier), `--report` (regenerate report from cache, no API), `--dry` (heuristics only), `--out PATH` (`.html` for HTML, `.md` for markdown), `--concurrency N`, `--model NAME`.

Classifications are cached in `.ai-fitness-cache.json` so re-runs are free.

### What the report contains

Leads with two evaluative sections — **Impression** (3–5 observations applying specific Tier-A findings to your pattern, each with a confidence tag and a linked citation) and **Moments** (the 10 most-recent skill-building / expert-decision prompts, with the top 2 shown as full before/after cards including a copy-paste "Try instead" reframe). Everything descriptive — regime mix, activity heatmap, session stats, project deep dives, topics, stakes, chronic offload domains, narrative summary — sits below.

**Framing discipline.** The report applies specific findings to your pattern; it does not compare you against a benchmark of "healthy AI use." No such benchmark exists in the evidence. Every observation carries a confidence tag (Strong / Plausible / Speculative) so overclaims are visible.

---

## Honest limits (read before shipping)

- **Measure the *unaided* outcome, not the assisted one.** Assisted metrics hide
  the exact harm this exists to prevent. Instrument later tool-absent performance,
  or falling assistance-depth over time — and stratify by expertise.
- **Watch the equity trap.** Cognitive forcing helps high-need-for-cognition users
  most and may just slow and churn everyone else — the people the learning harm
  hits hardest. If it only helps the top tier, it's not a safeguard.
- **Friction fights the market.** A frictionless competitor is one click away, so
  gate friction to genuinely high-stakes / skill-building moments, never a blanket
  tax, and keep a frictionless path for offload, accessibility, and time-critical
  use.
- **Frame it truthfully.** Harm-avoidance and capture-avoidance — never "makes you
  better."

