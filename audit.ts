// audit.ts — scan local Claude Code transcripts, classify every user prompt
// into a cultivation-mode regime, and write a personal report.
//
// Two ways to run this:
//
// A) Through Claude Code (uses your subscription, no external API, no training):
//      invoke the `ai-fitness-report` skill in a fresh Claude Code chat.
//      The skill drives this script's --dump and --report modes.
//
// B) Headless via OpenRouter (unattended, but hits external API):
//      OPENROUTER_API_KEY=... node --experimental-strip-types audit.ts
//
// Flags:
//   --sample N       only the N most-recent sessions (default: all)
//   --dump           extract prompts to .ai-fitness-prompts.json and exit
//                    (Claude Code flow — classification happens in the skill)
//   --report         generate report from cache only; skip all classification
//   --dry            no API calls; heuristics only (everything else → unclassified)
//   --out PATH       report path (default: ./ai-fitness-report.md)
//   --concurrency N  parallel classifier calls when using OpenRouter (default: 8)
//   --model NAME     OpenRouter model (default: google/gemini-2.0-flash-exp:free)
//
// The report is descriptive, not prescriptive. There is no evidence-based
// "healthy distribution" — this is your own mirror, not a benchmark.

import { readdirSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Regime = 'skill_building' | 'expert_decision' | 'offload'

interface Prompt {
  project: string   // decoded project dir, e.g. "volunteer-EBT"
  session: string   // session id
  timestamp: string
  content: string
}

type Familiarity = 'familiar' | 'learning' | 'unclear'
interface Classification { regime: Regime; topic: string; stakes: 'low' | 'high'; familiarity?: Familiarity }

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const val = (name: string, d: string) => {
  const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const OPTS = {
  sample: Number(val('--sample', '0')),
  dry: flag('--dry'),
  dump: flag('--dump'),
  report: flag('--report'),
  out: val('--out', 'ai-fitness-report.md'),
  concurrency: Number(val('--concurrency', '8')),
  model: val('--model', 'google/gemini-2.0-flash-exp:free'),
}
const PROMPTS_PATH = '.ai-fitness-prompts.json'
const API_KEY = process.env.OPENROUTER_API_KEY

// ---------------------------------------------------------------------------
// Ingest — walk ~/.claude/projects/*/*.jsonl for enqueue rows
// ---------------------------------------------------------------------------

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

function decodeProject(dir: string): string {
  // Claude Code encodes /Users/boden/Development/foo as -Users-boden-Development-foo
  return dir.replace(/^-Users-boden-Development-?/, '') || dir
}

function readSessions(): Prompt[] {
  const prompts: Prompt[] = []
  const projects = readdirSync(PROJECTS_DIR).filter(d => statSync(join(PROJECTS_DIR, d)).isDirectory())
  for (const proj of projects) {
    const files = readdirSync(join(PROJECTS_DIR, proj))
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, path: join(PROJECTS_DIR, proj, f), mtime: statSync(join(PROJECTS_DIR, proj, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const { f, path } of files) {
      const session = f.replace(/\.jsonl$/, '')
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue
        let row: any; try { row = JSON.parse(line) } catch { continue }
        if (row.type === 'queue-operation' && row.operation === 'enqueue' && typeof row.content === 'string' && row.content.trim()) {
          prompts.push({
            project: decodeProject(proj),
            session,
            timestamp: row.timestamp ?? '',
            content: row.content.trim(),
          })
        }
      }
    }
  }
  return prompts
}

// ---------------------------------------------------------------------------
// Classifier (mirrors cultivation.ts, extended to return topic + stakes)
// ---------------------------------------------------------------------------

const OPT_OUT = /\b(just (tell|give|show|do)\b|give me the answer|stop asking|no hints?|just answer)\b/i
const SLASH = /^\/[a-z][\w-]*(\s|$)/i
// System-emitted user messages (task pings, command stdout, slash-command wrappers).
// These aren't real user cognition — treat as offload noise.
const SYSTEM_TAG = /^<(task-notification|local-command-stdout|local-command-stderr|command-name|command-message|command-args|scheduled-task|create-pr-command)\b/i
// One-word acknowledgements / directions that carry no judgement.
const ACK = /^(ok|okay|k|kk|yes|no|sure|thanks|thx|ty|great|grat|perfect|cool|nice|nope|yep|ship it|do it|go|next|more|continue|proceed|resume|keep going|carry on|almost done\??|still going\??|done\??|all done\??|check|check again|👍|✅)[.!?\s]*$/i
// Pasted logs / URLs / build output — starts with a URL or a timestamped log line.
const PASTED_LOG = /^(https?:\/\/|\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/

function heuristic(text: string): Classification | null {
  const t = text.trim()
  if (t.length < 8) return { regime: 'offload', topic: 'trivial', stakes: 'low' }
  if (SYSTEM_TAG.test(t)) return { regime: 'offload', topic: 'system-message', stakes: 'low' }
  if (SLASH.test(t)) return { regime: 'offload', topic: 'slash-command', stakes: 'low' }
  if (OPT_OUT.test(t)) return { regime: 'offload', topic: 'opt-out', stakes: 'low' }
  if (ACK.test(t)) return { regime: 'offload', topic: 'ack', stakes: 'low' }
  if (PASTED_LOG.test(t)) return { regime: 'offload', topic: 'pasted-log', stakes: 'low' }
  return null
}

const CLASSIFIER_SYSTEM = `Classify the user's request. Return strict JSON: {"regime": "skill_building"|"expert_decision"|"offload", "topic": "short-kebab-topic", "stakes": "low"|"high", "familiarity": "familiar"|"learning"|"unclear"}.
- "regime":
  - "skill_building": user is trying to learn or get better at something they'll later do without AI ("help me understand", "teach me", "I'm learning", homework, practicing craft).
  - "expert_decision": already-competent user making a consequential, checkable judgement where over-trusting the AI is the risk ("review this", "is this right", "should I", "check my", high stakes).
  - "offload": no learning goal, nothing rides on being wrong — drafting/formatting/translating/summarizing/lookups/boilerplate/throughput. DEFAULT when unsure and low stakes.
- "topic": one short tag identifying the domain, e.g. "sql", "react-ui", "career-decision", "email-draft".
- "stakes": "high" only when a wrong answer causes real, hard-to-reverse harm.
- "familiarity" — signals whether the user seems to KNOW this domain, independent of what they're asking:
  - "familiar": uses domain jargon correctly, directs implementation, edits/reviews existing work, references specifics ("in the useState hook", "the FK constraint on user_id"). Even if they're offloading, they clearly know the field.
  - "learning": signals not-knowing ("how do I", "what's the difference between", "why does", "I've never", "no idea how", "not sure how", first-time framing, asks for explanation rather than execution).
  - "unclear": can't tell from the prompt (very short, just a paste, acknowledgement).
This is descriptive, not prescriptive — don't judge whether they SHOULD know the domain. Just describe what the prompt shows.`

async function llmClassify(text: string): Promise<Classification> {
  const body = {
    model: OPTS.model,
    response_format: { type: 'json_object' },
    max_tokens: 60,
    messages: [
      { role: 'system', content: CLASSIFIER_SYSTEM },
      { role: 'user', content: text.slice(0, 500) },
    ],
  }
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json() as any
  const parsed = JSON.parse(data.choices[0].message.content)
  const regime: Regime = (['skill_building', 'expert_decision', 'offload'] as const).includes(parsed.regime) ? parsed.regime : 'offload'
  const familiarity: Familiarity = (['familiar', 'learning', 'unclear'] as const).includes(parsed.familiarity) ? parsed.familiarity : 'unclear'
  return { regime, topic: String(parsed.topic || 'unknown').toLowerCase(), stakes: parsed.stakes === 'high' ? 'high' : 'low', familiarity }
}

// ---------------------------------------------------------------------------
// Cache — hash-keyed, so re-runs don't re-classify
// ---------------------------------------------------------------------------

const CACHE_PATH = '.ai-fitness-cache.json'
type Cache = Record<string, Classification>
const cache: Cache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : {}
const hashOf = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16)

async function classify(text: string): Promise<Classification> {
  const h = hashOf(text)
  if (cache[h]) return cache[h]
  const heur = heuristic(text)
  if (heur) { cache[h] = heur; return heur }
  if (OPTS.report) {
    // report-only mode: no API, no caching of the fallback (so a later run can classify)
    return { regime: 'offload', topic: 'unclassified', stakes: 'low' }
  }
  if (OPTS.dry || !API_KEY) {
    const fallback: Classification = { regime: 'offload', topic: 'unclassified', stakes: 'low' }
    cache[h] = fallback; return fallback
  }
  try { const c = await llmClassify(text); cache[h] = c; return c }
  catch { return { regime: 'offload', topic: 'error', stakes: 'low' } }
}

// pool with a hard concurrency limit
async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>, onTick?: (done: number) => void): Promise<R[]> {
  const out: R[] = new Array(items.length); let idx = 0, done = 0
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); done++; onTick?.(done) }
  })
  await Promise.all(workers); return out
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const pct = (n: number, total: number) => total ? `${((n / total) * 100).toFixed(1)}%` : '0%'
const bar = (n: number, total: number, width = 24) => '█'.repeat(Math.round((n / Math.max(total, 1)) * width))

function buildReport(rows: (Prompt & Classification)[]): string {
  const total = rows.length
  const byRegime = { skill_building: 0, expert_decision: 0, offload: 0 } as Record<Regime, number>
  for (const r of rows) byRegime[r.regime]++

  // Timeline: month → regime counts
  const byMonth = new Map<string, Record<Regime, number>>()
  for (const r of rows) {
    const m = r.timestamp.slice(0, 7) || 'unknown'
    if (!byMonth.has(m)) byMonth.set(m, { skill_building: 0, expert_decision: 0, offload: 0 })
    byMonth.get(m)![r.regime]++
  }

  // Project × regime
  const byProject = new Map<string, Record<Regime, number>>()
  for (const r of rows) {
    if (!byProject.has(r.project)) byProject.set(r.project, { skill_building: 0, expert_decision: 0, offload: 0 })
    byProject.get(r.project)![r.regime]++
  }

  // Topics per regime (top 8)
  const topicsIn = (regime: Regime) => {
    const t = new Map<string, number>()
    for (const r of rows) if (r.regime === regime && r.topic && r.topic !== 'unknown') t.set(r.topic, (t.get(r.topic) ?? 0) + 1)
    return [...t.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  }

  // Mismatch candidates — skill_building or expert_decision prompts that DIDN'T
  // include an opt-out phrase (i.e., you were probably given a full answer or
  // the AI didn't ask you to commit first). These are the moments where
  // cultivation-mode would have changed the response.
  const mismatches = rows.filter(r => r.regime !== 'offload' && !OPT_OUT.test(r.content)).slice(0, 12)

  const now = new Date().toISOString().slice(0, 10)
  const dates = rows.map(r => r.timestamp).filter(Boolean).sort()
  const range = dates.length ? `${dates[0].slice(0, 10)} → ${dates[dates.length - 1].slice(0, 10)}` : 'n/a'

  const lines: string[] = []
  lines.push(`# Cultivation audit — ${now}`)
  lines.push('')
  lines.push(`Scanned **${new Set(rows.map(r => r.session)).size} sessions** · **${total} user prompts** · ${range}`)
  lines.push('')
  lines.push(`This is descriptive, not prescriptive. There's no evidence-based "healthy distribution" — it's a mirror of your own regime mix, mismatches, and topic patterns. See [cultivation-mode](https://github.com/BodenHolland/ai-fitness-report) for the intervention.`)
  lines.push('')

  lines.push('## Regime distribution')
  lines.push('')
  lines.push('| Regime | Count | Share |    |')
  lines.push('|---|---:|---:|:---|')
  for (const r of ['skill_building', 'expert_decision', 'offload'] as Regime[]) {
    lines.push(`| ${r.replace('_', ' ')} | ${byRegime[r]} | ${pct(byRegime[r], total)} | \`${bar(byRegime[r], total)}\` |`)
  }
  lines.push('')

  lines.push('## By month')
  lines.push('')
  lines.push('| Month | skill | decision | offload | total |')
  lines.push('|---|---:|---:|---:|---:|')
  for (const [m, c] of [...byMonth.entries()].sort()) {
    const t = c.skill_building + c.expert_decision + c.offload
    lines.push(`| ${m} | ${c.skill_building} | ${c.expert_decision} | ${c.offload} | ${t} |`)
  }
  lines.push('')

  lines.push('## By project')
  lines.push('')
  lines.push('| Project | skill | decision | offload | total |')
  lines.push('|---|---:|---:|---:|---:|')
  const projRows = [...byProject.entries()].map(([p, c]) => ({ p, c, t: c.skill_building + c.expert_decision + c.offload })).sort((a, b) => b.t - a.t)
  for (const { p, c, t } of projRows.slice(0, 20)) lines.push(`| ${p} | ${c.skill_building} | ${c.expert_decision} | ${c.offload} | ${t} |`)
  lines.push('')

  lines.push('## Top topics per regime')
  lines.push('')
  for (const r of ['skill_building', 'expert_decision', 'offload'] as Regime[]) {
    const top = topicsIn(r)
    if (!top.length) continue
    lines.push(`**${r.replace('_', ' ')}** — ${top.map(([t, n]) => `${t} (${n})`).join(', ')}`)
    lines.push('')
  }

  lines.push('## Moments cultivation-mode would have changed')
  lines.push('')
  lines.push(`${mismatches.length} of your recent skill-building / expert-decision requests didn't include an "just tell me" opt-out — i.e., you were likely handed a full answer without an attempt-first or commit-first step. A sample:`)
  lines.push('')
  for (const m of mismatches) {
    const snippet = m.content.replace(/\n/g, ' ').slice(0, 140)
    lines.push(`- **[${m.regime.replace('_', ' ')}]** \`${m.project}\` — "${snippet}${m.content.length > 140 ? '…' : ''}"`)
  }
  lines.push('')

  // Chronic offload domains: topics where you've offloaded repeatedly WHILE signaling
  // unfamiliarity with the domain. Not verdicts — candidates for reflection.
  // Filters: ≥5 offloads, ≥2 distinct weeks, learning-share ≥ 30% of the classified subset.
  const weekOf = (ts: string) => {
    const d = new Date(ts); if (isNaN(d.getTime())) return ''
    // ISO week bucket, cheap approximation: yyyy-Www
    const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    const dayNum = day.getUTCDay() || 7
    day.setUTCDate(day.getUTCDate() + 4 - dayNum)
    const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1))
    const wk = Math.ceil((((day.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
    return `${day.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`
  }
  type Chronic = { topic: string; offloads: number; learning: number; familiar: number; unclear: number; weeks: Set<string>; withSignal: number }
  const byTopic = new Map<string, Chronic>()
  for (const r of rows) {
    if (r.regime !== 'offload' || !r.topic || ['unknown', 'unclassified', 'error', 'trivial', 'system-message', 'slash-command', 'opt-out', 'ack', 'pasted-log', 'agent-notification'].includes(r.topic)) continue
    if (!byTopic.has(r.topic)) byTopic.set(r.topic, { topic: r.topic, offloads: 0, learning: 0, familiar: 0, unclear: 0, weeks: new Set(), withSignal: 0 })
    const c = byTopic.get(r.topic)!
    c.offloads++
    if (r.familiarity === 'learning') { c.learning++; c.withSignal++ }
    else if (r.familiarity === 'familiar') { c.familiar++; c.withSignal++ }
    else if (r.familiarity === 'unclear') { c.unclear++ }
    const w = weekOf(r.timestamp); if (w) c.weeks.add(w)
  }
  const chronic = [...byTopic.values()]
    .filter(c => c.offloads >= 5 && c.weeks.size >= 2 && c.withSignal >= 3 && (c.learning / Math.max(c.withSignal, 1)) >= 0.3)
    .sort((a, b) => (b.learning / Math.max(b.withSignal, 1)) - (a.learning / Math.max(a.withSignal, 1)))
    .slice(0, 12)

  const withFamiliarity = rows.filter(r => r.familiarity && r.familiarity !== 'unclear').length
  lines.push('## Chronic offload domains')
  lines.push('')
  if (withFamiliarity < 20) {
    lines.push(`_Based on ${withFamiliarity} prompts with a clear familiarity signal. Re-run after more prompts are classified with the new signal to make this section meaningful._`)
    lines.push('')
  } else if (!chronic.length) {
    lines.push(`_Based on ${withFamiliarity} classified prompts, no topics met the threshold (≥5 offloads across ≥2 weeks with ≥30% learning-signal). Either you're offloading things you already know, or the domains vary too much to chronic-ize._`)
    lines.push('')
  } else {
    lines.push(`Topics you've offloaded repeatedly while signaling unfamiliarity with the domain. **Not verdicts — candidates for reflection.** If a topic here is something you'd rather own, that's where cultivation-mode would apply next time. If not, offload is a legitimate mode.`)
    lines.push('')
    lines.push('| Topic | Offloads | Learning share | Weeks span |')
    lines.push('|---|---:|---:|---:|')
    for (const c of chronic) {
      const share = c.withSignal ? Math.round((c.learning / c.withSignal) * 100) : 0
      lines.push(`| ${c.topic} | ${c.offloads} | ${share}% (${c.learning}/${c.withSignal}) | ${c.weeks.size} |`)
    }
    lines.push('')
  }

  lines.push('## What to actually do with this')
  lines.push('')
  lines.push('- If **skill_building** shows up meaningfully in a project you care about, invoke `cultivation-mode` at the start of those chats — that\'s where withhold-and-fade would have helped.')
  lines.push('- If **expert_decision** shows up in a project, invoke it there too — you get commit-first + cheap-to-verify instead of the AI anchoring your judgment.')
  lines.push('- Everything else is **offload** — don\'t add friction; the skill would route it to plain offload anyway.')
  lines.push('- The honest ceiling: this prevents skill erosion / capture, not "makes you smarter." Don\'t market it to yourself as more than that.')
  lines.push('')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// HTML report — self-contained, no external deps, print-friendly
// ---------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

function donutSvg(counts: { skill_building: number; expert_decision: number; offload: number }): string {
  const total = counts.skill_building + counts.expert_decision + counts.offload
  if (!total) return ''
  const cx = 90, cy = 90, r = 68, sw = 22
  const circ = 2 * Math.PI * r
  const segs = [
    { key: 'skill_building', color: 'var(--skill)', n: counts.skill_building },
    { key: 'expert_decision', color: 'var(--decision)', n: counts.expert_decision },
    { key: 'offload', color: 'var(--offload)', n: counts.offload },
  ]
  let offset = 0
  const arcs = segs.filter(s => s.n > 0).map(s => {
    const frac = s.n / total
    const len = frac * circ
    const el = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${sw}" stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})" />`
    offset += len
    return el
  }).join('')
  const pctOffload = Math.round((counts.offload / total) * 100)
  return `<svg viewBox="0 0 180 180" width="180" height="180" role="img" aria-label="Regime distribution">${arcs}<text x="${cx}" y="${cy - 4}" text-anchor="middle" class="donut-num">${pctOffload}%</text><text x="${cx}" y="${cy + 14}" text-anchor="middle" class="donut-lbl">offload</text></svg>`
}

function stackedBar(c: { skill_building: number; expert_decision: number; offload: number }, max: number): string {
  const total = c.skill_building + c.expert_decision + c.offload
  const w = 220, h = 14
  const scale = (n: number) => (n / Math.max(max, 1)) * w
  const sw = scale(c.skill_building), ew = scale(c.expert_decision), ow = scale(c.offload)
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${total} prompts">
    <rect x="0" y="0" width="${sw}" height="${h}" fill="var(--skill)" />
    <rect x="${sw}" y="0" width="${ew}" height="${h}" fill="var(--decision)" />
    <rect x="${sw + ew}" y="0" width="${ow}" height="${h}" fill="var(--offload)" />
  </svg>`
}

// ---------------------------------------------------------------------------
// Evaluative "Impression" section — applies Tier-A findings to observed patterns.
// Guardrails: every observation cites a specific finding, carries a confidence
// tag, and suggests conditional shifts. No benchmark against strangers, no
// diagnostic labels, no "you should" commands.
// ---------------------------------------------------------------------------

type Confidence = 'strong' | 'plausible' | 'speculative'
interface Observation {
  title: string
  confidence: Confidence
  body: string
  evidence?: { name: string; url: string; note: string }
  shift: string
}

function renderObservation(o: Observation, i: number): string {
  const confLabel = { strong: 'Strong', plausible: 'Plausible', speculative: 'Speculative' }[o.confidence]
  return `<article class="obs obs-${o.confidence}">
    <div class="obs-head">
      <span class="obs-num">${String(i + 1).padStart(2, '0')}</span>
      <span class="obs-tag">${confLabel}</span>
    </div>
    <h3 class="obs-title">${o.title}</h3>
    <p class="obs-body">${o.body}</p>
    ${o.evidence ? `<p class="obs-line"><span class="obs-lbl">Evidence</span><a href="${o.evidence.url}" target="_blank" rel="noopener">${esc(o.evidence.name)}</a> — ${o.evidence.note}</p>` : ''}
    <p class="obs-line"><span class="obs-lbl">Shift</span>${o.shift}</p>
  </article>`
}

function impressionSection(
  rows: (Prompt & Classification)[],
  byRegime: Record<Regime, number>,
  byProject: Map<string, Record<Regime, number>>,
  chronic: { topic: string; offloads: number; learning: number; withSignal: number; weeks: Set<string> }[],
): string {
  const total = rows.length
  if (!total) return '<p class="sub"><em>No data.</em></p>'
  const pct = (n: number) => Math.round((n / total) * 100)

  const bySession = new Map<string, number>()
  for (const r of rows) bySession.set(r.session, (bySession.get(r.session) ?? 0) + 1)
  const sessionLens = [...bySession.values()].sort((a, b) => a - b)
  const median = sessionLens.length ? sessionLens[Math.floor(sessionLens.length / 2)] : 0

  const projTotals = [...byProject.entries()].map(([p, c]) => ({ p, t: c.skill_building + c.expert_decision + c.offload })).sort((a, b) => b.t - a.t)
  const topProj = projTotals[0]

  const highStakes = rows.filter(r => r.stakes === 'high').length
  const highOffload = rows.filter(r => r.stakes === 'high' && r.regime === 'offload').length

  const obs: Observation[] = []

  // 1) Dominant pattern — always fire
  if (pct(byRegime.offload) >= 85) {
    obs.push({
      title: 'You use Claude as an execution tool, not a teacher',
      confidence: 'strong',
      body: `<strong>${pct(byRegime.offload)}%</strong> of your ${total} classified prompts are offload — you route work through the AI without a skill-building or decision-integrity goal. The Tier-A evidence explicitly says this is the <em>correct</em> mode when the task isn't identity-relevant to you. It is not a red flag on its own.`,
      evidence: { name: 'Bastani et al., PNAS 2025', url: 'https://www.pnas.org/doi/10.1073/pnas.2422633122', note: 'the dissociation harm only bites when there IS a learning goal to undermine' },
      shift: `The question isn't "should I offload less?" — it's "which of these ${byRegime.offload} offloads are in domains I'd rather own?" Look at the topics list below. If SQL, React, systems design, or anything else on that list matters to your identity as a builder, those specific chat types should invoke <code>cultivation-mode</code>. Everything else stays exactly as it is.`,
    })
  } else if (pct(byRegime.skill_building) >= 20) {
    obs.push({
      title: 'You use Claude to learn — that\'s exactly where dissociation risk lives',
      confidence: 'strong',
      body: `<strong>${pct(byRegime.skill_building)}%</strong> of your prompts read as skill-building (${byRegime.skill_building} of ${total}). This is the pattern where the Tier-A dissociation harm applies most directly: answer-giving AI leaves users measurably worse on unaided tasks after the tool is removed.`,
      evidence: { name: 'Bastani et al., PNAS 2025', url: 'https://www.pnas.org/doi/10.1073/pnas.2422633122', note: 'unrestricted ChatGPT left students −0.054 SD (~17%) worse on unaided exams; a hint-only tutor erased the harm' },
      shift: `Invoke <code>cultivation-mode</code> at the start of these chats — the withhold-and-fade discipline is the exact mechanism that erased the harm in Bastani's RCT.`,
    })
  }

  // 2) Absence of skill-building — worth naming, plausible
  if (byRegime.skill_building === 0 && total >= 200) {
    obs.push({
      title: 'You never frame prompts as "help me learn"',
      confidence: 'plausible',
      body: `Zero of your ${total} classified prompts read as skill-building. Two readings: (a) you're already expert in every domain you touch — plausible in some cases, unlikely across all of them; or (b) you route learning-shaped work through the AI as pure execution and skip the learning. The evidence is silent on which is happening; only you know.`,
      evidence: { name: 'Bastani et al., PNAS 2025', url: 'https://www.pnas.org/doi/10.1073/pnas.2422633122', note: 'dissociation only happens when a learning goal exists and gets offloaded — no goal, no harm' },
      shift: `Once the familiarity signal populates (next audit), the "Chronic offload domains" section below will surface the specific topics where you consistently signal not-knowing. Those are the concrete candidates for reflection — not "should I learn more?" but "is <em>this specific domain</em> one I'd rather own?"`,
    })
  }

  // 3) Expert-decision without commit-first — strong
  if (byRegime.expert_decision > 0) {
    const n = byRegime.expert_decision
    obs.push({
      title: `Your ${n} expert-decision moment${n === 1 ? '' : 's'} ran without commit-first framing`,
      confidence: 'strong',
      body: `${n} prompt${n === 1 ? '' : 's'} read as consequential judgement${n === 1 ? '' : 's'} — architecture, design, prioritization calls where over-trusting the AI is the risk. In every one of them you asked for the AI's answer without first committing your own. That's the exact pattern the Dratsch radiology experiment shows collapses expert judgement.`,
      evidence: { name: 'Dratsch et al., Radiology 2023', url: 'https://pubs.rsna.org/doi/10.1148/radiol.222176', note: 'even very-experienced radiologists dropped from 82.3% → 45.5% accuracy on incorrect AI suggestions when no commit-first structure was imposed' },
      shift: `For your next consequential design call, prepend the request with: <em>"Before you answer, ask me to commit my own take first."</em> That's the commit-first pattern, literally — and it's the only intervention with direct experimental support for this failure mode. Confidence scores and "show me your reasoning" do <strong>not</strong> work; they measurably increase blind trust.`,
    })
  }

  // 4) High-stakes concentration — plausible
  if (highStakes >= 5) {
    obs.push({
      title: `${highStakes} of your prompts are flagged high-stakes — including ${highOffload} offloads`,
      confidence: 'plausible',
      body: `High-stakes moments (prod deploys, financial calls, hard-to-reverse actions) are where automation bias bites hardest — you're likely to move fast and follow the AI. The concerning subset is the ${highOffload} high-stakes prompts that classified as pure offload: you handed the AI a consequential action without a commit-first or verify step.`,
      evidence: { name: 'Parasuraman & Manzey, Human Factors 2010', url: 'https://journals.sagepub.com/doi/10.1177/0018720810376055', note: 'automation bias reaches experts, resists training, and concentrates when task stakes are high and time-pressure exists' },
      shift: `For anything that touches production — deploys, DB migrations, financial state — apply a salient-error verify step before the action fires: open the diff, confirm the target environment, run the test suite. Salience beats explanation. Even a 10-second "does this look right?" glance recovers most of the accuracy loss.`,
    })
  }

  // 5) Project concentration — speculative
  if (topProj && topProj.t / total >= 0.35) {
    const projPct = Math.round((topProj.t / total) * 100)
    obs.push({
      title: `${projPct}% of your prompts concentrate in ${topProj.p}`,
      confidence: 'speculative',
      body: `Heavy concentration in one project. That's not a risk by itself — it's what deep work looks like. But it means most of the pattern-specific advice above lands in <code>${esc(topProj.p)}</code> first. Look at the "Moments cultivation-mode would have changed" list below — expect them to cluster there.`,
      shift: `Start invoking <code>cultivation-mode</code> in <code>${esc(topProj.p)}</code> chats specifically before generalizing it. It's easier to build the habit in one context than everywhere at once.`,
    })
  }

  // 6) Chronic offload — only if populated
  if (chronic.length > 0) {
    obs.push({
      title: `${chronic.length} topic${chronic.length === 1 ? '' : 's'} show a chronic-dependency pattern`,
      confidence: 'plausible',
      body: `You've offloaded these topics repeatedly across weeks while your prompts signaled not-knowing the domain: <strong>${chronic.slice(0, 5).map(c => esc(c.topic)).join(', ')}</strong>${chronic.length > 5 ? `, +${chronic.length - 5} more` : ''}. That's the exact pattern where the dissociation harm compounds — <em>if</em> any of these are domains you'd rather own.`,
      evidence: { name: 'Bastani et al., PNAS 2025', url: 'https://www.pnas.org/doi/10.1073/pnas.2422633122', note: 'the −0.054 SD unaided-exam harm was for a domain (math) students were supposed to be learning; the mechanism generalizes wherever a skill-preservation goal exists' },
      shift: `Look at the chronic list below. For each: <strong>ask yourself if you'd rather own it.</strong> If yes, that's a cultivation-mode invocation next time. If no, offload is fine — no shift needed.`,
    })
  }

  // 7) Session length — speculative
  if (median > 0 && sessionLens.length >= 5) {
    if (median <= 3) {
      obs.push({
        title: `Your sessions are tactical — median ${median} prompts each`,
        confidence: 'speculative',
        body: `Short bursts suggest quick execution / lookup / fix work. That's consistent with the offload-heavy mix above. It means most of your AI use won't benefit from cultivation-mode friction — you're not trying to learn, you're trying to unblock and move.`,
        shift: `Reserve cultivation-mode for the few longer, more exploratory chats where you actually want to think. Tactical bursts stay frictionless.`,
      })
    } else if (median >= 20) {
      obs.push({
        title: `Your sessions are deep — median ${median} prompts each`,
        confidence: 'speculative',
        body: `Long sessions mean you're using Claude as a working partner across sustained work. That's where either failure mode can compound: dissociation from many offloads in a row, or anchoring from an early AI answer that shapes the rest of the chat.`,
        shift: `For long chats specifically, break the pattern once per session: "before your next answer, ask me to commit my take first." Once is enough to reset the anchor.`,
      })
    }
  }

  const disclaimer = `<p class="sub" style="margin-top:0">Applies specific Tier-A findings to your observed pattern. Not a benchmark against strangers — no such benchmark exists in the evidence. Confidence-tagged so overclaims are visible. <strong>Strong</strong> means a direct application of the finding; <strong>plausible</strong> is a reasonable extension; <strong>speculative</strong> is a pattern-based hypothesis.</p>`
  return disclaimer + obs.map(renderObservation).join('')
}

// Auto-generated 2-3 sentence narrative: describe standout facts, no benchmark.
function execSummary(rows: (Prompt & Classification)[], byRegime: Record<Regime, number>, byProject: Map<string, Record<Regime, number>>): string {
  const total = rows.length; if (!total) return ''
  const pct = (n: number) => Math.round((n / total) * 100)
  const dominant = pct(byRegime.offload) >= 90 ? 'offload' : byRegime.skill_building > byRegime.expert_decision && byRegime.skill_building > byRegime.offload ? 'skill_building' : byRegime.expert_decision > byRegime.offload ? 'expert_decision' : 'offload'
  const projTotals = [...byProject.entries()].map(([p, c]) => ({ p, t: c.skill_building + c.expert_decision + c.offload })).sort((a, b) => b.t - a.t)
  const topProj = projTotals[0]
  const topShare = topProj ? Math.round((topProj.t / total) * 100) : 0
  const sd = pct(byRegime.skill_building), ed = pct(byRegime.expert_decision)
  const parts: string[] = []
  if (dominant === 'offload') parts.push(`You use Claude Code overwhelmingly as an execution tool — <strong>${pct(byRegime.offload)}%</strong> offload across ${total} classified prompts. Per the Tier-A evidence, that's a legitimate mode when there's no skill-building or decision-integrity goal on the surface.`)
  else if (dominant === 'skill_building') parts.push(`Your archive skews toward learning: <strong>${sd}%</strong> of prompts read as skill-building. That's where cultivation-mode's withhold-and-fade discipline would most directly apply.`)
  else parts.push(`Your archive is expert-decision heavy: <strong>${ed}%</strong> of prompts look like consequential judgements. That's where commit-first + cheap-to-verify would keep the AI from anchoring you.`)
  if (topProj && topShare >= 30) parts.push(`Work concentrates in <code>${esc(topProj.p)}</code> — <strong>${topShare}%</strong> of all prompts.`)
  if (sd > 0 || ed > 0) parts.push(`Of note: <strong>${sd + ed}%</strong> of prompts (${byRegime.skill_building + byRegime.expert_decision} total) are the regimes where cultivation-mode would have changed the response — those are your candidates for reflection.`)
  return parts.join(' ')
}

// GitHub-style contribution grid: rows are days-of-week, cols are weeks in the data range.
function activityHeatmap(rows: (Prompt & Classification)[]): string {
  const byDay = new Map<string, number>()
  const dates: Date[] = []
  for (const r of rows) {
    if (!r.timestamp) continue
    const d = new Date(r.timestamp); if (isNaN(d.getTime())) continue
    const key = d.toISOString().slice(0, 10)
    byDay.set(key, (byDay.get(key) ?? 0) + 1)
    dates.push(d)
  }
  if (!dates.length) return '<p class="sub"><em>No timestamped data.</em></p>'
  dates.sort((a, b) => a.getTime() - b.getTime())
  const start = new Date(dates[0]); start.setUTCHours(0, 0, 0, 0)
  const end = new Date(dates[dates.length - 1]); end.setUTCHours(0, 0, 0, 0)
  // Snap start to Monday
  const startDow = (start.getUTCDay() || 7) - 1
  start.setUTCDate(start.getUTCDate() - startDow)
  const weeks = Math.ceil(((end.getTime() - start.getTime()) / 86400000 + 1) / 7)
  const cell = 13, gap = 3, dayLabelW = 26, cols = Math.max(weeks, 1)
  const w = dayLabelW + cols * (cell + gap), h = 7 * (cell + gap) + 20
  const max = Math.max(...[...byDay.values()], 1)
  const shade = (n: number) => n === 0 ? '#efece2' : n < max * 0.15 ? '#c8dcc5' : n < max * 0.35 ? '#8fbf8a' : n < max * 0.6 ? '#5fa25c' : '#2E7D32'
  const cells: string[] = []
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  for (let d = 0; d < 7; d++) if (d % 2 === 0) cells.push(`<text x="0" y="${d * (cell + gap) + cell - 2}" class="hm-lbl">${dayNames[d]}</text>`)
  for (let wi = 0; wi < cols; wi++) {
    for (let d = 0; d < 7; d++) {
      const day = new Date(start); day.setUTCDate(day.getUTCDate() + wi * 7 + d)
      if (day > end) continue
      const key = day.toISOString().slice(0, 10)
      const n = byDay.get(key) ?? 0
      cells.push(`<rect x="${dayLabelW + wi * (cell + gap)}" y="${d * (cell + gap)}" width="${cell}" height="${cell}" rx="2" fill="${shade(n)}"><title>${key}: ${n} prompt${n === 1 ? '' : 's'}</title></rect>`)
    }
  }
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Daily activity heatmap">${cells.join('')}</svg><div class="hm-legend"><span>Less</span><span class="hm-sw" style="background:#efece2"></span><span class="hm-sw" style="background:#c8dcc5"></span><span class="hm-sw" style="background:#8fbf8a"></span><span class="hm-sw" style="background:#5fa25c"></span><span class="hm-sw" style="background:#2E7D32"></span><span>More</span></div>`
}

// 24-hour distribution
function hourDistribution(rows: (Prompt & Classification)[]): string {
  const buckets = new Array(24).fill(0)
  for (const r of rows) { const d = new Date(r.timestamp); if (!isNaN(d.getTime())) buckets[d.getHours()]++ }
  const max = Math.max(...buckets, 1)
  const w = 720, h = 90, barW = w / 24 - 2
  const bars = buckets.map((n, i) => {
    const bh = (n / max) * (h - 20)
    return `<g><rect x="${i * (w / 24)}" y="${h - 20 - bh}" width="${barW}" height="${bh}" rx="2" fill="var(--offload)"><title>${String(i).padStart(2, '0')}:00 — ${n} prompt${n === 1 ? '' : 's'}</title></rect>${i % 3 === 0 ? `<text x="${i * (w / 24) + barW / 2}" y="${h - 4}" text-anchor="middle" class="hm-lbl">${String(i).padStart(2, '0')}</text>` : ''}</g>`
  }).join('')
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Hour of day distribution">${bars}</svg>`
}

// Session stats + distribution histogram
function sessionSection(rows: (Prompt & Classification)[]): string {
  const bySession = new Map<string, number>()
  for (const r of rows) bySession.set(r.session, (bySession.get(r.session) ?? 0) + 1)
  const lens = [...bySession.values()].sort((a, b) => a - b)
  if (!lens.length) return ''
  const median = lens[Math.floor(lens.length / 2)]
  const mean = Math.round(lens.reduce((s, n) => s + n, 0) / lens.length)
  const longest = lens[lens.length - 1]
  const bins = [{ label: '1-5', lo: 1, hi: 5 }, { label: '6-10', lo: 6, hi: 10 }, { label: '11-20', lo: 11, hi: 20 }, { label: '21-50', lo: 21, hi: 50 }, { label: '51+', lo: 51, hi: Infinity }]
  const counts = bins.map(b => lens.filter(n => n >= b.lo && n <= b.hi).length)
  const maxB = Math.max(...counts, 1)
  const w = 720, h = 120, colW = w / bins.length
  const bars = counts.map((n, i) => {
    const bh = (n / maxB) * (h - 32); const x = i * colW + 20; const barW = colW - 40
    return `<g><rect x="${x}" y="${h - 24 - bh}" width="${barW}" height="${bh}" rx="3" fill="var(--offload)" /><text x="${x + barW / 2}" y="${h - 26 - bh - 4}" text-anchor="middle" class="hm-num">${n}</text><text x="${x + barW / 2}" y="${h - 8}" text-anchor="middle" class="hm-lbl">${bins[i].label}</text></g>`
  }).join('')
  return `<div class="stat-row"><div class="stat"><span class="stat-num">${lens.length}</span><span class="stat-lbl">sessions</span></div><div class="stat"><span class="stat-num">${median}</span><span class="stat-lbl">median prompts</span></div><div class="stat"><span class="stat-num">${mean}</span><span class="stat-lbl">mean</span></div><div class="stat"><span class="stat-num">${longest}</span><span class="stat-lbl">longest</span></div></div><h3>Distribution</h3><svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Session length distribution">${bars}</svg>`
}

// Stakes breakdown
function stakesSection(rows: (Prompt & Classification)[]): string {
  const highBy = { skill_building: 0, expert_decision: 0, offload: 0 } as Record<Regime, number>
  const lowBy = { skill_building: 0, expert_decision: 0, offload: 0 } as Record<Regime, number>
  for (const r of rows) { if (r.stakes === 'high') highBy[r.regime]++; else lowBy[r.regime]++ }
  const totalHigh = highBy.skill_building + highBy.expert_decision + highBy.offload
  const totalLow = lowBy.skill_building + lowBy.expert_decision + lowBy.offload
  if (!totalHigh) return `<p class="sub"><em>No high-stakes prompts classified.</em></p>`
  return `<p class="sub"><strong>${totalHigh}</strong> high-stakes prompts (${((totalHigh / (totalHigh + totalLow)) * 100).toFixed(1)}% of classified). "High" means a wrong answer would cause real, hard-to-reverse harm — production deploys, financial calls, prod-data mutations.</p>
    <table><thead><tr><th>Regime</th><th class="num">High stakes</th><th class="num">Low stakes</th><th class="num">High-stakes share</th></tr></thead><tbody>
      ${(['skill_building', 'expert_decision', 'offload'] as Regime[]).map(r => { const h = highBy[r], l = lowBy[r], t = h + l; if (!t) return ''; return `<tr><td>${r.replace('_', ' ')}</td><td class="num">${h}</td><td class="num">${l}</td><td class="num">${((h / t) * 100).toFixed(1)}%</td></tr>` }).filter(Boolean).join('')}
    </tbody></table>`
}

// Familiarity mix per regime (only meaningful when the signal is populated)
function familiaritySection(rows: (Prompt & Classification)[]): string {
  const buckets = { skill_building: { familiar: 0, learning: 0, unclear: 0, missing: 0 }, expert_decision: { familiar: 0, learning: 0, unclear: 0, missing: 0 }, offload: { familiar: 0, learning: 0, unclear: 0, missing: 0 } } as Record<Regime, Record<string, number>>
  for (const r of rows) {
    const b = buckets[r.regime]
    if (!r.familiarity) b.missing++
    else b[r.familiarity]++
  }
  const withSignal = rows.filter(r => r.familiarity && r.familiarity !== 'unclear').length
  if (withSignal < 20) return `<p class="sub"><em>Based on ${withSignal} prompts with a clear familiarity signal. Re-run after more prompts are classified.</em></p>`
  const rowsHtml = (['skill_building', 'expert_decision', 'offload'] as Regime[]).map(r => {
    const b = buckets[r]; const known = b.familiar + b.learning; if (!known) return ''
    const familPct = Math.round((b.familiar / known) * 100)
    return `<tr><td>${r.replace('_', ' ')}</td><td class="num">${b.familiar}</td><td class="num">${b.learning}</td><td>${familPct}% familiar<span class="learning-bar"><span style="width:${familPct}%; background:var(--skill)"></span></span></td></tr>`
  }).filter(Boolean).join('')
  return `<table><thead><tr><th>Regime</th><th class="num">Familiar</th><th class="num">Learning</th><th>Split</th></tr></thead><tbody>${rowsHtml}</tbody></table>`
}

// Deep-dive card for one project
function projectDeepDive(project: string, projRows: (Prompt & Classification)[]): string {
  const c = { skill_building: 0, expert_decision: 0, offload: 0 } as Record<Regime, number>
  const topicCounts = new Map<string, number>()
  for (const r of projRows) {
    c[r.regime]++
    if (r.topic && !['unknown', 'unclassified', 'error', 'trivial', 'system-message', 'slash-command', 'opt-out', 'ack', 'pasted-log', 'agent-notification'].includes(r.topic)) {
      topicCounts.set(r.topic, (topicCounts.get(r.topic) ?? 0) + 1)
    }
  }
  const total = c.skill_building + c.expert_decision + c.offload
  const topics = [...topicCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  const dates = projRows.map(r => r.timestamp).filter(Boolean).sort()
  const range = dates.length ? `${dates[0].slice(0, 10)} → ${dates[dates.length - 1].slice(0, 10)}` : ''
  return `<div class="deep-dive">
    <div class="dd-head"><h4>${esc(project)}</h4><span class="sub">${total} prompts · ${range}</span></div>
    <div class="dd-body">
      <div class="dd-bar">${stackedBar(c, total)}</div>
      <div class="dd-legend"><span><span class="dot skill"></span>${c.skill_building}</span><span><span class="dot decision"></span>${c.expert_decision}</span><span><span class="dot offload"></span>${c.offload}</span></div>
      ${topics.length ? `<div class="topics">${topics.map(([t, n]) => `<span class="chip">${esc(t)} <span class="count">${n}</span></span>`).join('')}</div>` : ''}
    </div>
  </div>`
}

function buildHtml(rows: (Prompt & Classification)[]): string {
  const total = rows.length
  const byRegime = { skill_building: 0, expert_decision: 0, offload: 0 } as Record<Regime, number>
  for (const r of rows) byRegime[r.regime]++

  const byMonth = new Map<string, Record<Regime, number>>()
  for (const r of rows) {
    const m = r.timestamp.slice(0, 7) || 'unknown'
    if (!byMonth.has(m)) byMonth.set(m, { skill_building: 0, expert_decision: 0, offload: 0 })
    byMonth.get(m)![r.regime]++
  }
  const months = [...byMonth.entries()].sort()
  const monthMax = Math.max(...months.map(([, c]) => c.skill_building + c.expert_decision + c.offload), 1)

  const byProject = new Map<string, Record<Regime, number>>()
  for (const r of rows) {
    if (!byProject.has(r.project)) byProject.set(r.project, { skill_building: 0, expert_decision: 0, offload: 0 })
    byProject.get(r.project)![r.regime]++
  }
  const projRows = [...byProject.entries()].map(([p, c]) => ({ p, c, t: c.skill_building + c.expert_decision + c.offload })).sort((a, b) => b.t - a.t).slice(0, 15)
  const projMax = Math.max(...projRows.map(x => x.t), 1)

  const topicsIn = (regime: Regime) => {
    const t = new Map<string, number>()
    for (const r of rows) if (r.regime === regime && r.topic && !['unknown', 'unclassified', 'error'].includes(r.topic)) t.set(r.topic, (t.get(r.topic) ?? 0) + 1)
    return [...t.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  }

  const mismatches = rows.filter(r => r.regime !== 'offload' && !OPT_OUT.test(r.content)).slice(0, 10)

  // Chronic offload — same logic as buildReport
  const weekOf = (ts: string) => {
    const d = new Date(ts); if (isNaN(d.getTime())) return ''
    const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    const dayNum = day.getUTCDay() || 7
    day.setUTCDate(day.getUTCDate() + 4 - dayNum)
    const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1))
    const wk = Math.ceil((((day.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
    return `${day.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`
  }
  type Chronic = { topic: string; offloads: number; learning: number; withSignal: number; weeks: Set<string> }
  const byTopic = new Map<string, Chronic>()
  const noiseTopics = new Set(['unknown', 'unclassified', 'error', 'trivial', 'system-message', 'slash-command', 'opt-out', 'ack', 'pasted-log', 'agent-notification'])
  for (const r of rows) {
    if (r.regime !== 'offload' || !r.topic || noiseTopics.has(r.topic)) continue
    if (!byTopic.has(r.topic)) byTopic.set(r.topic, { topic: r.topic, offloads: 0, learning: 0, withSignal: 0, weeks: new Set() })
    const c = byTopic.get(r.topic)!
    c.offloads++
    if (r.familiarity === 'learning') { c.learning++; c.withSignal++ }
    else if (r.familiarity === 'familiar') { c.withSignal++ }
    const w = weekOf(r.timestamp); if (w) c.weeks.add(w)
  }
  const chronic = [...byTopic.values()]
    .filter(c => c.offloads >= 5 && c.weeks.size >= 2 && c.withSignal >= 3 && (c.learning / Math.max(c.withSignal, 1)) >= 0.3)
    .sort((a, b) => (b.learning / Math.max(b.withSignal, 1)) - (a.learning / Math.max(a.withSignal, 1)))
    .slice(0, 12)
  const withFamiliarity = rows.filter(r => r.familiarity && r.familiarity !== 'unclear').length

  const sessions = new Set(rows.map(r => r.session)).size
  const dates = rows.map(r => r.timestamp).filter(Boolean).sort()
  const range = dates.length ? `${dates[0].slice(0, 10)} → ${dates[dates.length - 1].slice(0, 10)}` : 'n/a'
  const now = new Date().toISOString().slice(0, 10)

  const legendRow = (label: string, count: number, cls: string) => `<li><span class="dot ${cls}"></span> ${label}<span class="num">${count}</span><span class="pct">${total ? ((count / total) * 100).toFixed(1) + '%' : '0%'}</span></li>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI fitness report — ${now}</title>
<style>
  :root {
    --bg: #fafaf7;
    --card: #ffffff;
    --ink: #1a1a1a;
    --muted: #6b6b6b;
    --line: #e6e4dd;
    --skill: #2E7D32;
    --decision: #6A3EA1;
    --offload: #6B7A85;
    --learning: #B77A00;
  }
  * { box-sizing: border-box }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased }
  main { max-width: 880px; margin: 0 auto; padding: 40px 24px 80px }
  header { border-bottom: 1px solid var(--line); padding-bottom: 24px; margin-bottom: 32px }
  h1 { font-size: 28px; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.01em }
  h2 { font-size: 18px; font-weight: 600; margin: 40px 0 14px }
  h3 { font-size: 14px; font-weight: 600; margin: 20px 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em }
  .sub { color: var(--muted); font-size: 14px }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 22px; margin-bottom: 18px }
  .disclaimer { background: #fdf9ec; border: 1px solid #ede0b8; border-radius: 8px; padding: 12px 14px; font-size: 13.5px; color: #6f5410 }
  .mix { display: flex; align-items: center; gap: 28px }
  .donut-num { font-size: 30px; font-weight: 700; fill: var(--ink) }
  .donut-lbl { font-size: 11px; fill: var(--muted); text-transform: uppercase; letter-spacing: 0.08em }
  .legend { list-style: none; margin: 0; padding: 0; flex: 1 }
  .legend li { display: flex; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 14px }
  .legend li:last-child { border: 0 }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 10px }
  .dot.skill { background: var(--skill) } .dot.decision { background: var(--decision) } .dot.offload { background: var(--offload) }
  .num { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 600 }
  .pct { margin-left: 12px; color: var(--muted); font-variant-numeric: tabular-nums; min-width: 48px; text-align: right }
  table { width: 100%; border-collapse: collapse; font-size: 14px }
  th { text-align: left; font-weight: 600; padding: 10px 8px; border-bottom: 1px solid var(--line); color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em }
  td { padding: 10px 8px; border-bottom: 1px solid var(--line); vertical-align: middle }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums }
  tr:last-child td { border: 0 }
  .month-row { display: grid; grid-template-columns: 90px 1fr 60px; align-items: center; padding: 6px 0; gap: 12px }
  .month-row .m { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 13px }
  .month-row .n { font-variant-numeric: tabular-nums; text-align: right; font-size: 13px }
  .topics { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: #f2efe6; font-size: 12.5px; color: #3a3a3a }
  .chip .count { color: var(--muted); font-variant-numeric: tabular-nums }
  .moment { padding: 10px 0; border-bottom: 1px dashed var(--line); font-size: 14px }
  .moment:last-child { border: 0 }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; margin-right: 8px }
  .tag.skill { background: rgba(46,125,50,0.12); color: var(--skill) }
  .tag.decision { background: rgba(106,62,161,0.12); color: var(--decision) }
  .proj { color: var(--muted); font-size: 12.5px }
  .learning-bar { display: inline-block; width: 100px; height: 6px; background: #f0ede4; border-radius: 3px; vertical-align: middle; margin-left: 8px; position: relative; overflow: hidden }
  .learning-bar > span { display: block; height: 100%; background: var(--learning) }
  .toc { position: sticky; top: 0; background: var(--bg); padding: 12px 0; border-bottom: 1px solid var(--line); margin: 0 0 24px; display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 13px; z-index: 5 }
  .toc a { text-decoration: none; color: var(--muted); padding: 4px 0 }
  .toc a:hover { color: var(--ink) }
  .summary { font-size: 16px; line-height: 1.65 }
  .summary code { background: #f2efe6; padding: 1px 6px; border-radius: 4px; font-size: 13.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace }
  .stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 10px 0 20px }
  .stat { background: #f7f4eb; border-radius: 8px; padding: 14px; text-align: center }
  .stat-num { display: block; font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1 }
  .stat-lbl { display: block; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 4px }
  .hm-lbl { fill: var(--muted); font-size: 10px }
  .hm-num { fill: var(--ink); font-size: 10px; font-weight: 600; font-variant-numeric: tabular-nums }
  .hm-legend { display: flex; align-items: center; gap: 3px; margin-top: 10px; font-size: 11px; color: var(--muted); justify-content: flex-end }
  .hm-legend .hm-sw { display: inline-block; width: 13px; height: 13px; border-radius: 2px }
  .hm-legend span:first-child, .hm-legend span:last-child { margin: 0 6px }
  .obs { border-top: 1px solid var(--line); padding: 22px 0 }
  .obs:first-of-type { border-top: 0; padding-top: 6px }
  .obs-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px }
  .obs-num { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums }
  .obs-tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600 }
  .obs-strong .obs-tag { background: rgba(46,125,50,0.12); color: var(--skill) }
  .obs-plausible .obs-tag { background: rgba(183,122,0,0.14); color: var(--learning) }
  .obs-speculative .obs-tag { background: rgba(107,122,133,0.14); color: var(--offload) }
  .obs-title { font-size: 17px; font-weight: 600; margin: 0 0 8px; letter-spacing: -0.005em; line-height: 1.35 }
  .obs-body { margin: 0 0 10px; font-size: 14.5px; line-height: 1.6 }
  .obs-body em { color: var(--muted); font-style: normal; font-weight: 500 }
  .obs-body code { background: #f2efe6; padding: 1px 6px; border-radius: 4px; font-size: 13px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace }
  .obs-line { margin: 6px 0; font-size: 13.5px; line-height: 1.55; color: #3a3a3a }
  .obs-line code { background: #f2efe6; padding: 1px 6px; border-radius: 4px; font-size: 12.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace }
  .obs-lbl { display: inline-block; width: 62px; color: var(--muted); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; margin-right: 6px; vertical-align: baseline }
  .impression h2 { margin-top: 0 }
  .impression { border-left: 3px solid var(--skill); padding-left: 22px; padding-right: 24px }
  .featured { border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; margin: 14px 0 18px; background: #fbfaf5 }
  .ft-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px }
  .ft-row { display: grid; grid-template-columns: 130px 1fr; gap: 12px; padding: 8px 0; border-top: 1px dashed var(--line); align-items: baseline }
  .ft-row:first-of-type { border-top: 0; padding-top: 4px }
  .ft-lbl { color: var(--muted); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600 }
  .ft-row > div { font-size: 14px; line-height: 1.55 }
  .ft-quote { font-style: italic; color: #3a3a3a; padding-left: 12px; border-left: 3px solid var(--line) }
  .ft-try { background: #f2efe6; padding: 10px 12px; border-radius: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 1.5; user-select: all; cursor: text }
  .featured h3, .card > h3:not(:first-child) { margin-top: 22px }
  .deep-dive { padding: 14px 0; border-bottom: 1px solid var(--line) }
  .deep-dive:last-child { border: 0 }
  .dd-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px }
  .dd-head h4 { margin: 0; font-size: 15px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace }
  .dd-bar { margin-bottom: 6px }
  .dd-legend { display: flex; gap: 16px; font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; margin-bottom: 8px }
  .dd-legend .dot { margin-right: 6px }
  footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12.5px; text-align: center }
  a { color: inherit }
  @media print { body { background: white } .card { box-shadow: none; border-color: #ddd } .toc { display: none } }
</style>
</head>
<body>
<main>
  <header>
    <h1>AI fitness report</h1>
    <div class="sub">${sessions} sessions · ${total} prompts · ${range} · generated ${now}</div>
  </header>

  <p class="disclaimer">This report applies specific findings from the Tier-A evidence on AI &amp; cognition — the dissociation harm (Bastani et al.), automation bias (Dratsch et al.), expertise-reversal — to your observed pattern. It does <strong>not</strong> compare you against a benchmark of "healthy" AI users. No such benchmark exists in the evidence. Read <a href="https://github.com/BodenHolland/cultivation-mode">cultivation-mode</a> for the intervention this report points toward.</p>

  <nav class="toc">
    <a href="#impression"><strong>Impression</strong></a>
    <a href="#moments"><strong>Moments</strong></a>
    <a href="#mix">Mix</a>
    <a href="#activity">Activity</a>
    <a href="#sessions">Sessions</a>
    <a href="#months">Months</a>
    <a href="#projects">Projects</a>
    <a href="#deep-dives">Deep dives</a>
    <a href="#topics">Topics</a>
    <a href="#stakes">Stakes</a>
    <a href="#chronic">Chronic</a>
    <a href="#summary">Summary</a>
    <a href="#todo">What to do</a>
  </nav>

  <section class="card impression" id="impression">
    <h2>Impression</h2>
    ${impressionSection(rows, byRegime, byProject, chronic)}
  </section>

  <section class="card" id="moments">
    <h2>Moments cultivation-mode would have changed</h2>
    ${(() => {
      if (mismatches.length === 0) return '<p class="sub"><em>None in this data — you handed the AI mostly execution tasks.</em></p>'
      const featured = mismatches.slice(0, 2)
      const remaining = mismatches.slice(2, 10)
      const renderFeatured = (m: Prompt & Classification) => {
        const isSkill = m.regime === 'skill_building'
        const excerpt = esc(m.content.replace(/\n/g, ' ').slice(0, 240)) + (m.content.length > 240 ? '…' : '')
        const defaultBehavior = isSkill
          ? 'Claude delivers a full explanation. You read it and move on — the effortful <em>generation</em> that actually produces retention is skipped.'
          : 'Claude gives its direct answer / recommendation. You now anchor on that answer before forming your own take — the exact pattern that collapsed expert accuracy in Dratsch\'s radiology experiment.'
        const shortEx = m.content.replace(/\n/g, ' ').slice(0, 90) + (m.content.length > 90 ? '…' : '')
        const tryInstead = isSkill
          ? `Before you answer, ask me what I already know about this and what my first guess would be — then respond to my guess rather than replacing it. My question is: "${shortEx}"`
          : `Before you answer, ask me for my own read first — then push back on my reasoning rather than leading with your own. My question is: "${shortEx}"`
        const why = isSkill
          ? '<a href="https://www.pnas.org/doi/10.1073/pnas.2422633122">Bastani et al., PNAS 2025</a>. The generation effect: durable retention comes from effortful retrieval / generation, not from receiving a well-explained answer.'
          : '<a href="https://pubs.rsna.org/doi/10.1148/radiol.222176">Dratsch et al., Radiology 2023</a>. Even very-experienced radiologists dropped from 82% → 45% accuracy on wrong AI when they didn\'t commit first. Commit-first is the fix.'
        return `<div class="featured">
          <div class="ft-head"><span class="tag ${isSkill ? 'skill' : 'decision'}">${m.regime.replace('_', ' ')}</span><span class="proj">${esc(m.project)}</span></div>
          <div class="ft-row"><span class="ft-lbl">What you asked</span><div class="ft-quote">${excerpt}</div></div>
          <div class="ft-row"><span class="ft-lbl">Default behavior</span><div>${defaultBehavior}</div></div>
          <div class="ft-row"><span class="ft-lbl">Try instead</span><div class="ft-try">${esc(tryInstead)}</div></div>
          <div class="ft-row"><span class="ft-lbl">Why</span><div>${why}</div></div>
        </div>`
      }
      return `<p class="sub">Your ten most recent skill-building or expert-decision prompts that ran without an opt-out. The first two are shown as full before/after examples with copy-paste-ready reframes; the rest are compact.</p>
        <h3>Featured — before / after</h3>
        ${featured.map(renderFeatured).join('')}
        ${remaining.length ? `<h3>Other recent moments</h3>` : ''}
        ${remaining.map(m => `<div class="moment"><span class="tag ${m.regime === 'skill_building' ? 'skill' : 'decision'}">${m.regime.replace('_', ' ')}</span><span class="proj">${esc(m.project)}</span><div>${esc(m.content.replace(/\n/g, ' ').slice(0, 200))}${m.content.length > 200 ? '…' : ''}</div></div>`).join('')}`
    })()}
  </section>

  <section class="card" id="mix">
    <h2>The mix</h2>
    <div class="mix">
      ${donutSvg(byRegime)}
      <ul class="legend">
        ${legendRow('skill building', byRegime.skill_building, 'skill')}
        ${legendRow('expert decision', byRegime.expert_decision, 'decision')}
        ${legendRow('offload', byRegime.offload, 'offload')}
      </ul>
    </div>
    <h3>Familiarity split within each regime</h3>
    ${familiaritySection(rows)}
  </section>

  <section class="card" id="activity">
    <h2>Activity</h2>
    <h3>By day</h3>
    ${activityHeatmap(rows)}
    <h3>By hour of day</h3>
    ${hourDistribution(rows)}
  </section>

  <section class="card" id="sessions">
    <h2>Sessions</h2>
    ${sessionSection(rows)}
  </section>

  <section class="card" id="months">
    <h2>By month</h2>
    ${months.map(([m, c]) => `
      <div class="month-row">
        <span class="m">${esc(m)}</span>
        ${stackedBar(c, monthMax)}
        <span class="n">${c.skill_building + c.expert_decision + c.offload}</span>
      </div>
    `).join('')}
  </section>

  <section class="card" id="projects">
    <h2>By project</h2>
    <table>
      <thead><tr><th>Project</th><th class="num">skill</th><th class="num">decision</th><th class="num">offload</th><th class="num">total</th></tr></thead>
      <tbody>
        ${projRows.map(({ p, c, t }) => `<tr><td>${esc(p)}</td><td class="num">${c.skill_building}</td><td class="num">${c.expert_decision}</td><td class="num">${c.offload}</td><td class="num">${t}</td></tr>`).join('')}
      </tbody>
    </table>
  </section>

  <section class="card" id="deep-dives">
    <h2>Deep dives</h2>
    <p class="sub">Regime mix and top topics for your five busiest projects.</p>
    ${projRows.slice(0, 5).map(({ p }) => projectDeepDive(p, rows.filter(r => r.project === p))).join('')}
  </section>

  <section class="card" id="topics">
    <h2>Top topics</h2>
    ${(['skill_building', 'expert_decision', 'offload'] as Regime[]).map(r => {
      const top = topicsIn(r); if (!top.length) return ''
      return `<h3>${r.replace('_', ' ')}</h3><div class="topics">${top.map(([t, n]) => `<span class="chip">${esc(t)} <span class="count">${n}</span></span>`).join('')}</div>`
    }).join('')}
  </section>

  <section class="card" id="stakes">
    <h2>Stakes</h2>
    ${stakesSection(rows)}
  </section>

  <section class="card" id="chronic">
    <h2>Chronic offload domains</h2>
    ${
      withFamiliarity < 20
        ? `<p class="sub"><em>Based on ${withFamiliarity} prompts with a clear familiarity signal. Re-run after more prompts are classified to make this section meaningful.</em></p>`
        : !chronic.length
        ? `<p class="sub"><em>Based on ${withFamiliarity} classified prompts, no topics met the threshold (≥5 offloads across ≥2 weeks with ≥30% learning-signal). Either you're offloading things you already know, or the domains vary too much to chronic-ize.</em></p>`
        : `<p class="sub">Topics you've offloaded repeatedly while signaling unfamiliarity. <strong>Not verdicts — candidates for reflection.</strong> If a topic here is something you'd rather own, that's where cultivation-mode would apply next time.</p>
           <table><thead><tr><th>Topic</th><th class="num">Offloads</th><th>Learning share</th><th class="num">Weeks</th></tr></thead><tbody>
           ${chronic.map(c => { const pct = c.withSignal ? Math.round((c.learning / c.withSignal) * 100) : 0; return `<tr><td>${esc(c.topic)}</td><td class="num">${c.offloads}</td><td>${pct}% <span class="learning-bar"><span style="width:${pct}%"></span></span></td><td class="num">${c.weeks.size}</td></tr>` }).join('')}
           </tbody></table>`
    }
  </section>

  <section class="card" id="summary">
    <h2>Narrative summary</h2>
    <p class="summary">${execSummary(rows, byRegime, byProject)}</p>
  </section>

  <section class="card" id="todo">
    <h2>What to do with this</h2>
    <ul>
      <li>If <strong>skill building</strong> shows up meaningfully in a project you care about, invoke <code>cultivation-mode</code> at the start of those chats.</li>
      <li>If <strong>expert decision</strong> shows up in a project, invoke it there too — commit-first + cheap-to-verify beats the AI anchoring your judgment.</li>
      <li>Everything else is <strong>offload</strong> — don't add friction; the skill would route it to plain offload anyway.</li>
      <li>The honest ceiling: this prevents skill erosion / capture, not "makes you smarter." Don't market it to yourself as more than that.</li>
    </ul>
  </section>

  <footer>Generated by <a href="https://github.com/BodenHolland/cultivation-mode">cultivation-mode</a> · self-contained HTML, open anywhere</footer>
</main>
</body>
</html>`
}

async function main() {
  console.log('Reading transcripts…')
  let prompts = readSessions()
  if (!prompts.length) { console.error(`No prompts found under ${PROJECTS_DIR}`); process.exit(1) }

  // sort newest first for --sample
  prompts.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
  if (OPTS.sample > 0) {
    const keepSessions = new Set(prompts.slice(0, OPTS.sample * 40).map(p => p.session))
    const uniq = [...new Set(prompts.map(p => p.session))].slice(0, OPTS.sample)
    prompts = prompts.filter(p => uniq.includes(p.session))
    void keepSessions
  }

  // --dump: write UNCACHED prompts to a batch file for the ai-fitness-report skill
  // to classify in-context (uses Claude Code inference, no external API).
  if (OPTS.dump) {
    const batch = prompts
      .filter(p => !heuristic(p.content) && !cache[hashOf(p.content)])
      .map(p => ({ hash: hashOf(p.content), project: p.project, content: p.content.slice(0, 500) }))
    writeFileSync(PROMPTS_PATH, JSON.stringify(batch, null, 2))
    console.log(`Wrote ${batch.length} uncached prompts to ${PROMPTS_PATH}`)
    console.log(`(${prompts.length - batch.length} were already cached or heuristic-classified)`)
    console.log(`Next: classify them (via the ai-fitness-report skill), then run: node --experimental-strip-types audit.ts --report`)
    return
  }

  console.log(`Classifying ${prompts.length} prompts (dry=${OPTS.dry}, report=${OPTS.report}, concurrency=${OPTS.concurrency})…`)
  const needsApi = !OPTS.dry && !OPTS.report && prompts.some(p => !cache[hashOf(p.content)] && !heuristic(p.content))
  if (needsApi && !API_KEY) { console.error('OPENROUTER_API_KEY not set — pass --dry, --report, or use --dump + the ai-fitness-report skill.'); process.exit(1) }

  const classifications = await pool(prompts, OPTS.concurrency, p => classify(p.content), done => {
    if (done % 50 === 0 || done === prompts.length) process.stdout.write(`  ${done}/${prompts.length}\r`)
  })
  process.stdout.write('\n')
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2))

  const rows = prompts.map((p, i) => ({ ...p, ...classifications[i] }))
  const asHtml = OPTS.out.toLowerCase().endsWith('.html') || OPTS.out.toLowerCase().endsWith('.htm')
  const report = asHtml ? buildHtml(rows) : buildReport(rows)
  writeFileSync(OPTS.out, report)
  console.log(`Report written to ${OPTS.out}`)
  console.log(`Cache: ${CACHE_PATH} (${Object.keys(cache).length} entries)`)
}

main().catch(e => { console.error(e); process.exit(1) })
