## What this is

Two tools and a system prompt built on the same idea. AI is a powerful tool, but not without consequences. This skill helps identify your usage patterns and course-correct depending on your desired outcome.

- A **Skill** you install into Claude Code that changes how Claude talks to you, so it doesn't hand over the answer when you were trying to learn or trying to make a real decision.
- A **Report generator** that reads your past Claude Code chats and tells you how you've actually been using AI. Where you were offloading, where you were learning, where you were letting the AI make consequential calls for you.
- A **router** developers can drop into their own AI app to do the same routing automatically for their users.

Everything is grounded in the research at the bottom. Nothing here claims to make you smarter or faster. The honest claim is: it can keep AI from eroding skill you actually want to keep, and it can stop you from trusting a wrong answer on something that matters.

---

## Why this exists

Today's AI assistants have one dial: how much to help, with the assumption that more help is always better. That assumption is wrong.

Handing over the answer raises your performance while the AI is in the room and lowers your ability once it's not. Studies (linked below) find measurable skill loss after using answer-giving AI, and automation bias so strong that even expert radiologists collapse from 82% to 45% accuracy when the AI is confidently wrong.

So the real question for a given chat isn't "how helpful should the AI be." It's:

> For this request, am I optimizing the assisted output, my future unaided skill, or my resistance to a wrong answer?

The three answers need different behavior from the AI.

---

## Three modes

| Mode | When it applies | What the AI should do |
|---|---|---|
| **Skill-building** | You are trying to learn or get better at something you'll later do without AI | Withhold and fade. Get your attempt first, give the smallest hint that unblocks you, back off as you get better. |
| **Expert decision** | You're already competent, the call is consequential and checkable, over-trusting the AI is the risk | Get your read first, then surface one verifiable claim. No confidence scores, no "here's my reasoning." Both make you trust wrong answers more. |
| **Offload** | No learning goal, nothing bad happens if the AI is wrong | Just answer. Fast. Easy to spot-check. Most requests live here. |

The point of routing is to avoid taxing an offload request (formatting an email, running a build, drafting boilerplate) with friction it doesn't need. That would just be annoying with no payoff. Withholding is only earned on the ~10% of requests where the user actually wanted to learn or was making a real decision.

If you're not sure which mode a request is in, it's offload. That's the honest default.

---

## Research

The design is built on causal, replicated findings, not viral takes.

1. **Performance is not learning.** Answer-giving AI raises assisted performance and leaves unaided performance flat or negative once removed. Preregistered classroom RCT: bare ChatGPT left students ~17% worse on an unaided exam (−0.054 SD); a hint-only tutor erased the harm (−0.004, n.s.) but added no gain. [Bastani et al., *PNAS* 2025](https://www.pnas.org/doi/10.1073/pnas.2422633122). Corroborated by [Fan et al., *BJET* 2025](https://doi.org/10.1111/bjet.13544) and [Bassner et al., *Computers & Education: AI* 2026](https://www.sciencedirect.com/science/article/pii/S2666920X25001778).

2. **Automation bias reaches experts.** When the AI was wrong, experienced radiologists dropped from 82.3% to 45.5% accuracy. [Dratsch et al., *Radiology* 2023](https://pubs.rsna.org/doi/10.1148/radiol.222176); [Parasuraman & Manzey, *Human Factors* 2010](https://journals.sagepub.com/doi/10.1177/0018720810376055).
   - **What reduces it:** cognitive forcing (commit before reveal), and making the error cheap to verify.
   - **What backfires:** confidence scores and explanations. Both read as competence signals and increase blind trust.

3. **Withholding helps schema-holders and hurts true novices** (expertise reversal). Scaffolding has to adapt to expertise, never blanket. Underpinned by retrieval practice (g≈0.51), generation effect (d≈0.40), and intelligent tutoring systems (d≈0.43 to 0.76).

---

## What's in this repo

| File | What it is |
|---|---|
| [`skills/cultivation-mode/SKILL.md`](./skills/cultivation-mode/SKILL.md) | **The behavioral skill.** Install this into Claude Code and it changes how Claude talks to you. Also works as a paste-in system prompt in any other model. |
| [`skills/ai-fitness-report/SKILL.md`](./skills/ai-fitness-report/SKILL.md) | **The report skill.** Install this and say "generate my AI fitness report" in a fresh Claude Code chat. It reads your past sessions and produces an HTML report on how you've been using AI. |
| [`audit.ts`](./audit.ts) | **The report script.** What the fitness-report skill actually runs. Can also be used headless with an OpenRouter API key. |
| [`cultivation.ts`](./cultivation.ts) | **The router.** For developers building AI apps. Classifies user requests and returns the right system prompt before you call your model. |

---

## Installing the skill (change how Claude talks to you)

```bash
# personal, works in every project
mkdir -p ~/.claude/skills/cultivation-mode
cp skills/cultivation-mode/SKILL.md ~/.claude/skills/cultivation-mode/

# or per-project
mkdir -p .claude/skills/cultivation-mode
cp skills/cultivation-mode/SKILL.md .claude/skills/cultivation-mode/
