// cultivation.ts — route each AI request into the regime its goal actually needs.
//
// Grounded in the Tier-A evidence on AI and cognition:
//   • Answer-giving AI lifts assisted performance but erodes UNAIDED skill once
//     removed (Bastani, PNAS 2025; Fan 2025; Bassner 2026). Withholding prevents
//     it — but adds no gain over no-AI, so it's damage-avoidance, not acceleration.
//   • Experts get captured by a confidently-wrong model (Dratsch, Radiology 2023).
//     What reduces it: commit-before-reveal + cheap-to-verify errors. What
//     BACKFIRES: confidence scores and "here's my reasoning" (they read as
//     competence → more blind trust). So this module never enforces a "safety
//     via transparency" pattern.
//   • Withholding hurts true novices (expertise reversal) → expertise-adaptive.
//
// Provider-agnostic; the classifier call below uses the OpenRouter-compatible
// /chat/completions shape already used in this codebase.

export type Regime = 'skill_building' | 'expert_decision' | 'offload'
export type Expertise = 'novice' | 'developing' | 'proficient' | 'expert' | 'unknown'

export interface RequestContext {
  /** What the product surface knows the user is doing, if anything. */
  surfaceGoal?: 'learn' | 'decide' | 'produce'
  /** Per-user, per-domain competence signal — drives fade + expertise reversal. */
  expertise?: Expertise
  /** Stakes of being wrong; low stakes should stay in `offload`. */
  stakes?: 'low' | 'high'
}

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

const RAILS = `Non-negotiable rules for every reply:
- If the user opts out ("just tell me", "just do it", "give me the answer", "stop asking"), comply immediately and fully — no lecture, no guilt. Their opt-out is absolute.
- Never state a confidence level, and never lead with "here's my reasoning" as reassurance. Both increase blind trust. State falsifiable, checkable facts instead.
- Never announce a judgement about the user ("you seem like a beginner") — adapt silently.
- Be honest about the ceiling: do not claim you make the user smarter or faster. At most you avoid eroding their skill, or reduce their odds of trusting a wrong answer.
- For "who do I want to become"-type questions, point to people, books, and communities — not yourself.`

const REGIME_PROMPTS: Record<Regime, string> = {
  skill_building: `The user is building a skill they will later use WITHOUT you. Optimize for what they can do unaided afterward, not the polish of this output.
- Do not hand over the answer. Ask for their attempt or plan first, then give the SMALLEST hint that unblocks (a question, a concept, an analogous example), escalating only as needed.
- EXCEPTION for a true novice with no schema to attempt: give a full worked example WITH a prompt to explain it back — do not force a blank-page struggle.
- Fade your support as they show competence.`,

  expert_decision: `The user is already competent and is making a consequential, checkable decision; the risk is that they over-trust a wrong answer.
- Ask for their own read first (one line: their call + why). Only then give yours.
- On disagreement, say it neutrally ("we differ") — their call is the default; you are not an authority to defer to.
- Surface exactly ONE claim they can verify in seconds. Be brief when you agree; spend attention on genuine disagreement.
- Do NOT withhold or run them through hints — they have the skill; the goal is decision integrity, not teaching.`,

  offload: `There is no skill-building or decision-integrity goal here. Do the task immediately, fully, and well, and make the result easy to spot-check. No friction, no attempt-first, no quiz.`,
}

const EXPERTISE_NOTE: Partial<Record<Expertise, string>> = {
  novice: `This user is a novice in this domain: prefer a worked example they can study over withholding, which would only stall them.`,
  expert: `This user is expert here: keep support minimal; withholding and challenge are appropriate.`,
}

/** Compose the system prompt for a regime (+ expertise adaptation for skill-building). */
export function buildSystemPrompt(regime: Regime, ctx: RequestContext = {}): string {
  const parts = [REGIME_PROMPTS[regime], RAILS]
  const note = ctx.expertise ? EXPERTISE_NOTE[ctx.expertise] : undefined
  if (regime === 'skill_building' && note) parts.push(note)
  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** The escape hatch: any of these forces plain offload regardless of the regime. */
export const OPT_OUT = /\b(just (tell|give|show|do)\b|give me the answer|stop asking|no hints?|just answer)\b/i

/** Free, no-LLM signals. Returns a confident regime or null (→ ask the model). */
export function heuristicRegime(input: string, ctx: RequestContext = {}): Regime | null {
  if (OPT_OUT.test(input)) return 'offload'
  if (ctx.surfaceGoal === 'produce') return 'offload'
  if (ctx.surfaceGoal === 'learn') return 'skill_building'
  if (ctx.surfaceGoal === 'decide') return 'expert_decision'
  return null
}

export interface ClassifyOptions {
  apiKey: string
  model?: string
  endpoint?: string
  ctx?: RequestContext
}

const CLASSIFIER_SYSTEM = `Classify the user request into exactly one regime. Return strict JSON only.
- "skill_building": the user is trying to learn or get better at something they will later do without AI (homework, practicing a craft, "help me understand", "teach me").
- "expert_decision": an already-competent user is making a consequential, checkable judgement where over-trusting the AI is the risk ("review this", "is this right", "should I", high-stakes calls).
- "offload": no learning goal and nothing rides on being wrong — drafting, formatting, translating, summarizing, lookups, boilerplate, throughput. THIS IS THE DEFAULT when unsure and stakes are low.
Return: {"regime": "skill_building" | "expert_decision" | "offload", "confidence": 0-1}`

/**
 * Classify a request. Uses free heuristics first (surface goal + escape hatch),
 * falls back to one cheap classification call. Fails safe to `offload` — the
 * failure mode must never be "silently withhold".
 */
export async function classifyRegime(
  input: string,
  opts: ClassifyOptions,
): Promise<{ regime: Regime; confidence: number; optedOut: boolean }> {
  const optedOut = OPT_OUT.test(input)
  const fast = heuristicRegime(input, opts.ctx)
  if (fast) return { regime: fast, confidence: 1, optedOut }

  try {
    const res = await fetch(opts.endpoint ?? 'https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model ?? 'google/gemini-2.0-flash-exp:free',
        response_format: { type: 'json_object' },
        max_tokens: 40,
        messages: [
          { role: 'system', content: CLASSIFIER_SYSTEM },
          { role: 'user', content: input },
        ],
      }),
    })
    const data = await res.json()
    const parsed = JSON.parse(data.choices[0].message.content)
    const regime: Regime = (['skill_building', 'expert_decision', 'offload'] as const).includes(parsed.regime)
      ? parsed.regime
      : 'offload'
    return { regime, confidence: Number(parsed.confidence) || 0.5, optedOut }
  } catch {
    return { regime: 'offload', confidence: 0, optedOut } // fail open — never withhold on error
  }
}

/**
 * One-call helper: classify, honor the escape hatch, and return the system
 * prompt to pass into your normal chat completion.
 *
 *   const { regime, systemPrompt } = await route(userText, { apiKey, ctx })
 *   // ...send [{role:'system', content: systemPrompt}, ...history] to your model
 */
export async function route(
  input: string,
  opts: ClassifyOptions,
): Promise<{ regime: Regime; systemPrompt: string }> {
  const { regime, optedOut } = await classifyRegime(input, opts)
  const effective: Regime = optedOut ? 'offload' : regime // escape hatch overrides everything
  return { regime: effective, systemPrompt: buildSystemPrompt(effective, opts.ctx) }
}

// ---------------------------------------------------------------------------
// Measurement (the part most implementations skip — and then can't prove it works)
//
// The whole point is the WITHOUT-tool outcome, which assisted metrics hide.
// If you ship this, instrument at least one of:
//   • unaided/transfer performance on a later, tool-absent task (the real signal);
//   • assistance depth over time per user (is it falling? → skill forming);
//   • outcomes STRATIFIED by expertise/prior-knowledge, to catch the equity trap
//     where forcing only helps the already-capable and just churns everyone else.
// Do not report with-tool lift as evidence of a learning win.
// ---------------------------------------------------------------------------
