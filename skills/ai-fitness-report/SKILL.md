---
name: ai-fitness-report
description: >-
  Analyze the user's own Claude Code conversation archive locally, classify
  every past prompt into a cultivation-mode regime (skill_building /
  expert_decision / offload), and write a personal AI-use report. Uses Claude
  Code itself for the classification — no external API, nothing leaves the
  user's machine → Anthropic trust boundary. Trigger when the user asks to
  audit their AI use, generate an AI fitness report, see how they use Claude,
  understand their own regime distribution, or invokes this skill by name.
---

# ai-fitness-report

Run the local audit on the user's Claude Code archive using in-context
classification (no OpenRouter, no external API). Drive the `audit.ts` script's
`--dump` and `--report` modes, doing the classification yourself in between.

## Where to run

The script lives in the `ai-fitness-report` repo at `~/Development/cultivation-mode`
(local checkout still uses the old directory name). `cd` there before running any
command.

## Step 1 — extract prompts

Ask the user if they want a sample or the full archive. Default to a sample
(`--sample 5`, ~80 prompts, ~1 batch) unless they say full.

```bash
cd ~/Development/cultivation-mode
source ~/.nvm/nvm.sh && nvm use 22
node --experimental-strip-types audit.ts --dump [--sample N]
```

That writes `.ai-fitness-prompts.json` — an array of
`{hash, project, content}` objects for the uncached prompts.

## Step 2 — classify in-context

Read `.ai-fitness-prompts.json` and `.ai-fitness-cache.json` (may
not exist — that's fine, treat as `{}`).

For each prompt, decide:

- **`skill_building`** — user is trying to learn or get better at something
  they'll later do without AI ("help me understand," "teach me," "I'm learning,"
  homework, practicing a craft). *Includes trying to build the mental model for
  a system, not just copy-paste output.*
- **`expert_decision`** — an already-competent user making a consequential,
  checkable judgement where over-trusting the AI is the risk ("review this,"
  "is this right," "should I," "check my," high stakes).
- **`offload`** — no learning goal, nothing rides on being wrong. Drafting,
  formatting, translating, summarizing, lookups, boilerplate, throughput,
  bug fixes on code you're not trying to learn from, one-offs.
  **This is the default when unsure and stakes are low. Most requests are this.**

Also extract:

- A short kebab-case `topic` (e.g. `sql`, `react-ui`, `career-decision`, `email-draft`, `bug-fix`, `deploy`).
- `stakes`: `low` by default, `high` only when a wrong answer causes real hard-to-reverse harm.
- `familiarity` — signals whether the user seems to KNOW the domain, independent of regime. This feeds a separate "chronic offload domains" section that shows the user where they've repeatedly leaned on AI in unfamiliar territory.
  - **`familiar`** — uses jargon correctly, directs implementation, edits/reviews existing work, references specifics ("in the `useState` hook", "the FK constraint on `user_id`"). Even if they're offloading, they clearly know the field.
  - **`learning`** — signals not-knowing ("how do I", "what's the difference", "why does", "I've never", "no idea how", asks for explanation rather than execution).
  - **`unclear`** — very short, a paste, an acknowledgement, or genuinely ambiguous. Use this liberally rather than guessing.

`familiarity` is **descriptive, not prescriptive.** Never judge whether the user *should* know the domain — just describe what the prompt shows. The report aggregates this into a "chronic offload domains" section that the user decides what to do with.

**Batching.** Keep batches around 50–100 prompts per turn. For each batch,
build a JSON object keyed by `hash`:

```json
{
  "7a469c07d1593ca5": {"regime": "expert_decision", "topic": "build-verify", "stakes": "low", "familiarity": "familiar"},
  "821c30781937beb1": {"regime": "offload", "topic": "meta-discussion", "stakes": "low", "familiarity": "familiar"}
}
```

**Bulk-classification tip for large archives.** If the dump returns 500+
prompts, a fully manual pass burns tokens. A better flow: write an overrides
JSON of only the prompts that look like `expert_decision` or `skill_building`,
then default every other uncached prompt to `offload` in a single script pass.
The report's guardrails already say offload is the correct default when
unsure — this just automates that default at scale.

## Step 3 — write classifications to cache

After each batch (or at the end for small runs), merge into
`.ai-fitness-cache.json`. Read the existing file (if any), spread it
plus your new entries, write back. Do not overwrite unrelated entries — this
is an append-only cache keyed by content hash.

## Step 4 — generate the report

Default to the HTML output — it's the intended reading experience. The script
picks format from the `--out` extension.

```bash
node --experimental-strip-types audit.ts --report --out ai-fitness-report.html [--sample N]
```

(Pass the same `--sample` value used in Step 1.) This uses the cached
classifications with zero API calls. Open the file with `open ai-fitness-report.html`
after generation.

The HTML report leads with two evaluative sections — **Impression** (3–5
observations tied to specific Tier-A findings with confidence tags) and
**Moments** (10 most-recent skill-building / expert-decision prompts, with the
top 2 shown as full before/after cards including a copy-paste "Try instead"
reframe). Every claim links the actual paper it operationalizes (Bastani PNAS
2025, Dratsch Radiology 2023, Parasuraman & Manzey Human Factors 2010). All
the descriptive summaries — mix, activity, sessions, projects, deep dives,
topics, stakes, chronic offload — sit below.

If the user asks for markdown instead (e.g. for a diff, an issue, or a
non-browser context), use `--out ai-fitness-report.md`.

## Step 5 — show the user

Read `ai-fitness-report.md` and summarize the standout findings in
chat: their regime mix, the projects that skew skill-building or expert-decision
(not offload), and 2–3 specific "moments cultivation-mode would have changed"
examples that stood out. Point them at the full file for the rest. Frame it as
a mirror, not a benchmark — the report already says this in its own words.

## Honest guardrails

- **Don't invent a benchmark.** There's no evidence-based "healthy distribution."
  Describe their pattern; don't tell them it's too high or too low.
- **Don't over-classify as skill_building.** People rarely explicitly want to
  learn from AI — most of what looks like "understand this" is actually offload
  (understand this thing enough to use it, then move on). If the user doesn't
  clearly signal a learning goal AND the task is one they'll later do without
  AI, it's offload.
- **Frame the intervention as harm-avoidance, not acceleration.** The strongest
  claim their report can support is "here are moments where using cultivation-mode
  would have kept the AI from anchoring your judgment or from offloading
  effortful work you wanted to own." Never "here's where you would have learned
  more."
- **Escape-hatch honesty.** If a prompt contains `just tell me` / `give me the
  answer` / `stop asking`, that's `offload` regardless of surface topic — the
  user opted out of any regime.

## If the user asks "should I use the OpenRouter path instead?"

The repo's `audit.ts` also has an OpenRouter path (uses `google/gemini-2.0-flash-exp:free`,
free tier). Fine for unattended full-archive runs, but that free tier trains on
prompts. This skill exists so audits stay within the Claude Code trust boundary
they've already accepted. Recommend the skill by default.
