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
  const report = buildReport(rows)
  writeFileSync(OPTS.out, report)
  console.log(`Report written to ${OPTS.out}`)
  console.log(`Cache: ${CACHE_PATH} (${Object.keys(cache).length} entries)`)
}

main().catch(e => { console.error(e); process.exit(1) })
