# Based East Africa Builds — OpenClaw Agent Workshop Guide

> Build an autonomous, onchain AI agent that posts daily build-streak prompts on Farcaster, replies to community members, and tips builders with USDC on Base.

**Built for**: Base Builder Quest (5 ETH prize pool) & Base East Africa Workshop
**Stack**: OpenClaw + Farcaster + Base (USDC) + Node.js + systemd
**Agent FID**: 2660927 | **Username**: @basedeabuilds
**Wallet**: `0xD90D5483660D76D69B3406db3F42c41b7d92dB2d`

---

## Table of Contents

1. [What We're Building](#what-were-building)
2. [Architecture Overview](#architecture-overview)
3. [How x402 Works (Important!)](#how-x402-works-important)
4. [Prerequisites](#prerequisites)
5. [Step 1 — VPS Setup](#step-1--vps-setup)
6. [Step 2 — Install OpenClaw](#step-2--install-openclaw)
7. [Step 3 — Farcaster Account (Manual Flow)](#step-3--farcaster-account-manual-flow)
8. [Step 4 — Agent Personality (SOUL.md & AGENTS.md)](#step-4--agent-personality-soulmd--agentsmd)
9. [Step 5 — Daily Prompt Script](#step-5--daily-prompt-script)
10. [Step 6 — Reply to Replies (Smart Reply System)](#step-6--reply-to-replies-smart-reply-system)
11. [Step 7 — Tipping with USDC on Base](#step-7--tipping-with-usdc-on-base)
12. [Step 8 — Discovery Job (Web Research)](#step-8--discovery-job-web-research)
13. [Step 9 — Systemd Services & Timers](#step-9--systemd-services--timers)
14. [Step 10 — OpenClaw Gateway & Dashboard](#step-10--openclaw-gateway--dashboard)
15. [Step 11 — HEARTBEAT.md & Cron Jobs](#step-11--heartbeatmd--cron-jobs)
16. [What Worked & What Didn't](#what-worked--what-didnt)
17. [OpenClaw Deep Dive](#openclaw-deep-dive)
18. [Key Concepts (x402, ERC-8004)](#key-concepts-x402-erc-8004)
19. [File Structure (on VPS)](#file-structure-on-vps)
20. [Cost Budget](#cost-budget)
21. [Troubleshooting](#troubleshooting)

---

## What We're Building

An autonomous Farcaster agent that:

- **Posts daily build-streak prompts** — GM/BM/evening casts encouraging builders to share progress
- **Replies to community members** — smart, multi-cast reply system with conversation threading, web research, and 4 distinct reply styles
- **Discovers trending news** — Brave Search integration surfaces Base ecosystem news twice daily
- **Tips builders with USDC** — deterministic winner selection using Base block hash, sends USDC to their Farcaster verified wallet, and replies with the basescan tx link
- **Community pulse cron job** — gateway-managed wakeup that lets the agent freely decide whether to post
- **Runs 24/7 on a VPS** — systemd timers + gateway cron jobs, no human in the loop

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│  Contabo VPS (Ubuntu 24.04, Node 22)                     │
│                                                          │
│  ┌──────────────────┐   ┌───────────────────────────┐   │
│  │ OpenClaw Gateway  │   │ Scheduled Jobs (systemd)   │   │
│  │ :18789            │   │                            │   │
│  │                   │   │  hourly  → daily_prompt.js │   │
│  │ SOUL.md           │   │  :00/:15/:30/:45           │   │
│  │ AGENTS.md         │   │          → reply_to_...js  │   │
│  │ BOOTSTRAP.md      │   │  16:00  → tip_winners.js   │   │
│  │ Skills            │   │  6AM/6PM→ discovery_job.js │   │
│  │ HEARTBEAT.md      │   └────────────┬──────────────┘   │
│  │ Cron Jobs         │                │                   │
│  └──────────────────┘                ▼                   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │ External APIs (all via x402 — paid with USDC)     │   │
│  │  • Neynar Hub — post casts, read conversations    │   │
│  │    (0.001 USDC per call via x402/EIP-3009)        │   │
│  │                                                    │   │
│  │ Free APIs                                          │   │
│  │  • OpenRouter — LLM generation (claude-3.5-haiku) │   │
│  │  • Base RPC — USDC transfers (mainnet.base.org)   │   │
│  │  • Brave Search — Base ecosystem news discovery   │   │
│  └──────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

## How x402 Works (Important!)

This agent uses **x402** for every Farcaster interaction. x402 is an HTTP 402 payment protocol:

1. Agent wants to post a cast or read a conversation from Neynar Hub
2. Agent creates an **EIP-3009 `transferWithAuthorization`** signature (USDC on Base)
3. This signature is base64-encoded into an `X-PAYMENT` HTTP header
4. Neynar receives the request, a facilitator settles the USDC payment (0.001 per call)
5. Neynar processes the request

**This means every API call costs 0.001 USDC.** Reading a conversation = 0.001. Posting a cast = 0.001. The agent wallet needs USDC on Base to operate.

The x402 flow is implemented in `src/x402.js` in the farcaster-agent repo. The key function is `createX402Header(wallet)` which signs the EIP-712 typed data for USDC transfer authorization.

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Ubuntu VPS | 24.04 LTS | Contabo Cloud VPS S (~$7/mo) — or [Contabo OpenClaw Hosting](https://contabo.com/en/openclaw-hosting/) (pre-installed) |
| Node.js | 22.x | `nvm install 22` |
| OpenClaw | 2026.2.x | `npm i -g openclaw` |
| ETH on Optimism | ~$0.50 | For FID registration (happens on OP Mainnet) |
| USDC on Base | ~$1+ | For x402 API calls + tipping builders |
| OpenRouter API key | free tier | openrouter.ai — for LLM prompt generation |
| Brave Search API key | free tier | brave.com/search/api — for web research (1 req/sec) |

**You do NOT need** a separate Neynar API key. The farcaster-agent uses x402 (USDC payments) instead of API keys for all Neynar Hub interactions.

---

## Step 1 — VPS Setup

SSH into your fresh Ubuntu 24.04 VPS:

```bash
ssh root@YOUR_VPS_IP
```

Install Node.js 22 via nvm:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash
source ~/.bashrc
nvm install 22
node -v   # should show v22.22.0
```

Enable lingering for systemd user services (critical — lets timers run after SSH disconnect):

```bash
loginctl enable-linger $USER
```

## Step 2 — Install OpenClaw

```bash
npm i -g openclaw
openclaw --version   # 2026.2.x
```

Run the onboarding wizard:

```bash
openclaw setup
```

This creates:
- `~/.openclaw/openclaw.json` — config (model, API keys, ports)
- `~/.openclaw/workspace/` — default workspace for SOUL.md, AGENTS.md, skills

### Install the Farcaster skill

The skill provides `postCast()`, wallet creation, FID registration, and signer management.

> **Lesson learned**: `npx clawhub@latest install farcaster-agent` only downloads the `SKILL.md` descriptor, NOT the full source code. You need to `git clone` the full repo.

```bash
cd ~/.openclaw/workspace
git clone https://github.com/rishavmukherji/farcaster-agent.git
cd farcaster-agent
npm install
```

This installs key dependencies: `ethers`, `@farcaster/hub-nodejs`, and the x402 payment module.

## Step 3 — Farcaster Account (Manual Flow)

> **Lesson learned**: The `auto-setup.js` script tries to swap USDC→ETH and bridge Base→Optimism. The bridge reverted for me. The **manual flow is more reliable**.

### 3a. Create a wallet

```bash
cd ~/.openclaw/workspace/farcaster-agent
node src/auto-setup.js   # or create manually
```

This generates a custody wallet. Fund it with ~$0.50 ETH on **Optimism** (FID registration happens on OP Mainnet) and some USDC on **Base** (for x402 payments).

### 3b. Register a Farcaster ID (FID)

```bash
export CUSTODY_PK="0xYOUR_CUSTODY_PRIVATE_KEY"
node src/register-fid.js
```

Note down your FID (ours: `2660927`).

### 3c. Add a signer

```bash
export FID=2660927
export CUSTODY_PK="0x..."
node src/add-signer.js
```

> **Lesson learned**: You must `export` shell variables before running Node scripts. Plain `read` variables are invisible to child processes.

### 3d. Save credentials

The manual flow doesn't auto-save. Create the credentials file:

```bash
cat > ~/.openclaw/farcaster-credentials.json << 'EOF'
{
  "YOUR_FID": {
    "fid": "YOUR_FID",
    "custodyPrivateKey": "0x...",
    "signerPrivateKey": "...",
    "fname": null,
    "createdAt": "2026-02-04T00:00:00.000Z"
  },
  "_active": "YOUR_FID"
}
EOF
chmod 600 ~/.openclaw/farcaster-credentials.json
```

> **Lesson learned**: The nested format with `_active` pointer is important. `loadCredentials()` reads `data[data._active]` to find the active account.

### 3e. Test a post

```bash
cd ~/.openclaw/workspace/farcaster-agent
PRIVATE_KEY="0x..." SIGNER_PRIVATE_KEY="..." FID=2660927 node src/post-cast.js "gm from my autonomous agent!"
```

### 3f. Set profile

```bash
node src/set-profile.js --username YOUR_USERNAME --display "Your Agent Name" --bio "Your agent description"
```

## Step 4 — Agent Personality (SOUL.md & AGENTS.md)

OpenClaw injects these files into the agent's system prompt. Place them in the workspace:

**`~/.openclaw/workspace/SOUL.md`** — who the agent *is*:

```markdown
# Your Agent Name — Soul

I am [name], an autonomous [role] agent on Farcaster.
My mission: [what you do].

## Personality
- [trait 1]
- [trait 2]
- [trait 3]

## Voice
- Clear, direct, optimistic.
- Say "onchain," not "on-chain."
```

**`~/.openclaw/workspace/AGENTS.md`** — how the agent *operates*:

```markdown
# AGENTS.md

## Agent: main
Role: [your agent's role]

### Rules
- [rule 1]
- [rule 2]

### Safety
- Never ask for private keys or secrets.
- Never claim official endorsement.
- If funds are low, pause tipping.
```

**`~/.openclaw/workspace/BOOTSTRAP.md`** — first-run conversation script. OpenClaw uses this on first launch to let the agent discover its identity through conversation.

## Step 5 — Daily Prompt Script

The heartbeat: `scripts/daily_prompt.js` — lives inside the farcaster-agent directory.

**What it does:**
1. Checks time-of-day slot (morning → "GM", afternoon → "BM", evening, night)
2. Rolls mood/energy/theme using deterministic seeds (`dateKey:hour`)
3. Calls LLM (OpenRouter) to generate a 1-2 sentence prompt (max 240 chars)
4. Checks similarity against recent posts (Jaccard distance, threshold 0.7)
5. Posts to Farcaster via x402 Hub submission (costs 0.001 USDC)
6. Saves state: hash, timestamp, streak count, recent prompts

**Key environment** (`~/.openclaw/secrets/prompt.env`):

```bash
OPENROUTER_API_KEY=sk-or-v1-...
PROMPT_PROVIDER=openrouter
PROMPT_MODEL=anthropic/claude-3.5-haiku
```

**Key behavior:**
- Probability-based posting (not every hour) — morning 25%, afternoon 32%, evening 30%
- Guaranteed at least 1 post per day (probability → 100% after `MUST_POST_BY` hour)
- Cooldown between posts (default 2 hours)
- Max 5 posts per day, target 3
- Quiet hours 22:00–06:00

**Test it:**

```bash
cd ~/.openclaw/workspace/farcaster-agent
node scripts/daily_prompt.js --dry-run    # preview without posting
node scripts/daily_prompt.js --force       # bypass cooldown/probability
```

## Step 6 — Reply to Replies (Smart Reply System)

`scripts/reply_to_replies.js` — fully autonomous reply system that polls every 15 minutes.

**What makes it smart:**

1. **Multi-cast checking** — fetches the agent's recent casts directly from Neynar API (no dependency on daily_prompt state). Checks up to 5 casts within the last 72 hours.
2. **Conversation threading** — uses `reply_depth=2` to see replies to the agent's own replies, enabling back-and-forth conversations (up to 3 levels deep).
3. **Web research** — detects builder replies using keyword classification (needs 2+ indicators like "built"+"app", or contains a URL). Searches Brave for project info and feeds it to the LLM for specific, informed feedback. Capped at 2 searches per run.
4. **4 distinct reply styles**:
   - **Casual** (gm, short replies): max 140 chars, warm + invite to share
   - **Builder with research**: max 320 chars, specific feedback referencing web findings
   - **Builder without research**: max 200 chars, acknowledge + ask follow-up
   - **Thread continuation**: max 200 chars, includes prior context
5. **Tiered frequency** — latest cast checked every run, 2nd oldest every other run, 3rd+ every 4th run (cost optimization).

**Flow:**
1. Calls Neynar `/v2/farcaster/feed/user/casts` via x402 to get agent's recent casts
2. For each cast, fetches conversation thread via x402 (`reply_depth=2`)
3. Filters for new replies not yet responded to (tracked in `.state/replies.json`)
4. Classifies each reply (casual vs builder), optionally searches Brave for project context
5. Generates contextual reply using LLM (OpenRouter, temperature 0.85)
6. Cleans LLM output (strips extra quotes, truncates at word boundary)
7. Posts reply as a **threaded cast** using `parentCastId` in the Hub CastAdd message via x402

**Key detail**: The farcaster-agent's `postCast()` does NOT support replies. Our script builds the `CastAdd` message directly using `@farcaster/hub-nodejs` with a `parentCastId` field containing the reply's hash and author FID, then submits via x402.

**Configuration** (via environment):
- `MAX_REPLIES_PER_RUN=5` — max replies per run
- `MAX_CASTS_TO_CHECK=5` — how many recent casts to check
- `MAX_CAST_AGE_HOURS=72` — ignore casts older than this
- `MAX_SEARCHES_PER_RUN=2` — cap on Brave searches per run
- `MAX_THREAD_DEPTH=3` — max conversation depth to follow

**Cost**: ~0.001 USDC per conversation read + 0.001 per reply posted. ~0.11 USDC/day.

**Test it:**

```bash
cd ~/.openclaw/workspace/farcaster-agent
node scripts/reply_to_replies.js --dry-run
```

## Step 7 — Tipping with USDC on Base

`scripts/tip_winners.js` — runs daily at 4 PM EAT.

**Full flow:**
1. Checks if the latest post is old enough (≥2 hours)
2. Fetches replies via x402 conversation API
3. Gets each replier's **Farcaster verified wallet** automatically (`author.verified_addresses.primary.eth_address`) — no need for users to paste addresses!
4. **Deterministic winner selection**:
   ```
   seed = latestBlockHash + ":" + castHash + ":" + postTimestamp
   winnerIndex = keccak256(seed) % eligibleCount
   ```
   Fully auditable — anyone can verify with the same inputs.
5. Sends 0.02 USDC per winner via `usdc.transfer()` on Base
6. **Replies to the winner** on Farcaster with a celebratory LLM-generated message + basescan tx link

**Example tip reply:**
> Woohoo @xiaomaov2, your creative spark just lit up Base! Keep pushing the boundaries of what's possible. 🚀
>
> https://basescan.org/tx/0x769dcd52a5298e6abf88d8278e7cfb8fd6d61abeccaeb393bedd61db689a6164

**Configuration** (via systemd environment):
- `TIP_AMOUNT_USDC=0.02` — tip amount per winner
- `TIP_MAX_WINNERS=2` — number of winners per round
- `TIP_MIN_AGE_MINUTES=120` — minimum age of post before tipping

**Test it:**

```bash
cd ~/.openclaw/workspace/farcaster-agent
node scripts/tip_winners.js --dry-run
```

## Step 8 — Discovery Job (Web Research)

`scripts/discovery_job.js` — searches the web for Base ecosystem news and generates "sparks" for the agent to use.

**Flow:**
1. Runs 4 Brave Search queries: "Base chain news", "Base app update", "Farcaster Base creators", "Base East Africa builders"
2. Takes top 2 results per query (8 items total)
3. Sends items to LLM to generate 3 short "sparks" (under 140 chars each, no URLs/hashtags)
4. Saves results to `.state/discovery.json` and `memory/DISCOVERY.md`

**Key details:**
- Uses Brave Search API (free plan, 1 req/sec)
- 1.5s delay between searches to avoid 429 rate limiting
- API key stored in `~/.openclaw/secrets/discovery.env`
- Output feeds into HEARTBEAT.md so the gateway agent can reference fresh news

**Configuration** (`~/.openclaw/secrets/discovery.env`):
```bash
BRAVE_API_KEY=BSA...
```

**Schedule:** Runs at 6 AM and 6 PM via `bea-discovery.timer`.

**Test it:**
```bash
cd ~/.openclaw/workspace/farcaster-agent
node scripts/discovery_job.js
```

## Step 9 — Systemd Services & Timers

We use **systemd user services** so everything runs without needing an active SSH session.

### The services running on our VPS

**bea-heartbeat** — hourly posting:
```ini
[Service]
Type=oneshot
Environment=QUIET_ENABLED=0
Environment=MIN_POSTS=2
Environment=MAX_POSTS=6
Environment=COOLDOWN_HOURS=1
Environment=MUST_POST_BY=23
ExecStart=/usr/bin/node /root/.openclaw/workspace/farcaster-agent/scripts/daily_prompt.js
```
Timer: `OnCalendar=hourly` with 15min random delay.

**bea-replies** — reply checking every 15 min:
```ini
[Service]
Type=oneshot
WorkingDirectory=/root/.openclaw/workspace/farcaster-agent
ExecStart=/usr/bin/node /root/.openclaw/workspace/farcaster-agent/scripts/reply_to_replies.js
```
Timer: `OnCalendar=*:00,15,30,45` with 1min random delay.

**bea-tips** — daily tipping at 4 PM:
```ini
[Service]
Type=oneshot
WorkingDirectory=/root/.openclaw/workspace/farcaster-agent
ExecStart=/usr/bin/node /root/.openclaw/workspace/farcaster-agent/scripts/tip_winners.js
Environment=TIP_MAX_WINNERS=2
```
Timer: `OnCalendar=16:00`.

**bea-discovery** — web research at 6 AM and 6 PM:
```ini
[Service]
Type=oneshot
WorkingDirectory=/root/.openclaw/workspace/farcaster-agent
ExecStart=/usr/bin/node /root/.openclaw/workspace/farcaster-agent/scripts/discovery_job.js
```
Timer: `OnCalendar=06:00,18:00`.

### Setup commands

```bash
mkdir -p ~/.config/systemd/user

# Create service and timer files (see examples above)
# Then enable:
systemctl --user daemon-reload
systemctl --user enable --now bea-heartbeat.timer
systemctl --user enable --now bea-replies.timer
systemctl --user enable --now bea-tips.timer
systemctl --user enable --now bea-discovery.timer
systemctl --user enable --now openclaw-gateway.service
```

### Verify everything is running

```bash
systemctl --user list-timers --all
journalctl --user -u bea-heartbeat.service --since today
journalctl --user -u bea-replies.service --since today
```

## Step 10 — OpenClaw Gateway & Dashboard

The gateway is a persistent service that:

- Serves a web dashboard at `http://localhost:18789`
- Manages agent sessions via WebSocket
- Loads SOUL.md and AGENTS.md into the system prompt
- Loads skills from the workspace
- Routes chat messages to the configured LLM

### Dashboard sections

| Section | What It Does |
|---------|-------------|
| **Overview** | Agent health, uptime, recent activity |
| **Channels** | Communication channels (webchat, WhatsApp, Telegram) |
| **Instances** | Running agent instances |
| **Sessions** | Active chat sessions with history |
| **Cron Jobs** | Gateway-managed scheduled wakeups |
| **Agents** | Agent configurations |
| **Skills** | Installed skills (like farcaster-agent) |
| **Config** | Gateway settings (port, auth, model) |
| **Debug / Logs** | Diagnostics and raw logs |

### Access remotely

```bash
# From your LOCAL machine (not the VPS):
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3
# Then open http://localhost:18789
```

### Gateway config (`~/.openclaw/openclaw.json`)

Key settings:
- `agents.defaults.model.primary` — which LLM to use (we use `openrouter/anthropic/claude-3.5-haiku`)
- `gateway.port` — default 18789
- `gateway.auth.token` — auth token for dashboard access

> **Lesson learned**: The gateway was initially set to `claude-opus-4` which is expensive and may have caused empty responses. Switching to `claude-3.5-haiku` fixed the dashboard chat.

## Step 11 — HEARTBEAT.md & Cron Jobs

### HEARTBEAT.md

`HEARTBEAT.md` lives in the workspace root alongside SOUL.md. It tells the agent what to do when it wakes up from a cron job or scheduled event. Without this file, cron jobs fail with `empty-heartbeat-file`.

```markdown
# HEARTBEAT

I am Based East Africa Builds, an autonomous community agent on Farcaster.

## On Wake
1. Read my discovery notes (memory/DISCOVERY.md) for recent Base ecosystem news
2. Check my last post time — avoid posting more than once every 2 hours
3. Think about what Base East Africa builders need right now
4. Decide whether to post, share a tip, or stay quiet

## Guidelines
- Only post if I have something worth saying
- Reference real news from discovery notes when possible
- Keep posts under 280 characters
- Max one emoji per post
```

### Gateway Cron Jobs

Gateway cron jobs are different from systemd timers. Systemd timers run deterministic Node scripts. Cron jobs wake the **LLM agent** through the gateway pipeline — the agent reads its HEARTBEAT.md, SOUL.md, and memory files, then freely decides what to do.

Create cron jobs in the dashboard under **Control → Cron Jobs**:

| Field | Value |
|-------|-------|
| Name | `community-pulse` |
| Schedule | Every 30 min |
| Session | Main |
| Wake Mode | Next heartbeat |
| Payload | System event |
| System text | "You just woke up for your community check. Look at recent activity, think about what Base East Africa builders need, and decide if you want to post an encouraging message, share a building tip, or stay quiet." |

> **Known issue**: If `HEARTBEAT.md` doesn't exist or is empty, cron jobs fail with `empty-heartbeat-file`. Make sure the file has content.

---

## What Worked & What Didn't

### Worked

| Step | Notes |
|------|-------|
| Manual Farcaster setup | `register-fid` → `add-signer` → `post-cast` — reliable |
| systemd user timers | Agent posts autonomously, survives SSH disconnects |
| x402 payments | Agent pays 0.001 USDC per API call, fully automatic |
| Deterministic tipping | `keccak256(blockHash + castHash + timestamp)` — fair and verifiable |
| Verified wallet lookup | Tips go to Farcaster verified wallet — no address pasting needed |
| Tip reply with tx hash | Agent replies to winner with basescan link — transparent |
| Contextual replies | LLM generates warm, relevant responses to community replies |
| Multi-cast reply checking | Agent fetches its own casts from Neynar — fully autonomous |
| Conversation threading | `reply_depth=2` enables back-and-forth conversations |
| Web research for builders | Brave Search finds project info, LLM gives specific feedback |
| 4 reply styles | Casual, builder+research, builder, thread continuation |
| Discovery job | Brave Search surfaces Base ecosystem news twice daily |
| HEARTBEAT.md | Gateway cron jobs wake the LLM to freely decide actions |
| Similarity check | Jaccard on tokenized text prevents repetitive posts |

### Didn't Work (and how we fixed it)

| Issue | What Happened | Fix |
|-------|---------------|-----|
| `npx clawhub install` | Only downloads SKILL.md, not full code | `git clone` the full repo |
| `auto-setup.js` bridge | Base→Optimism bridge reverted | Use manual flow instead |
| `auto-setup.js` funds check | "No sufficient funds" with $0.50 | Manual flow works fine |
| Shell vars invisible to Node | `read` without `export` | Always `export` before scripts |
| Credentials not auto-saved | Manual flow skips save step | Write credentials JSON manually |
| Signer key doubled | Copy-paste duplicated the key | Careful paste + verify JSON |
| Dashboard empty output | Gateway set to expensive Opus model | Switch to `claude-3.5-haiku` |
| `postCast()` no reply support | Function doesn't accept parentCastId | Build CastAdd directly with hub-nodejs |
| Dry-run saved state | Reply script saved to replies.json during dry run | Guard writes with `if (!isDryRun)` |
| Heredoc corruption on VPS | Large scripts get mangled when pasted via terminal | Use `scp` to copy files instead |
| Brave API 429 rate limit | Discovery job fired searches too fast | Add 1.5s `sleep()` between Brave API calls |
| LLM extra quotes | Replies wrapped in `""` or `''` | `cleanText()` strips surrounding quotes |
| LLM mid-word truncation | Replies cut at exact char limit mid-word | `truncateAtWord()` cuts at last space |
| Reply only checked latest cast | Old casts with unanswered replies were ignored | `fetchAgentCasts()` queries Neynar directly for recent casts |
| Cron job `empty-heartbeat-file` | Gateway cron failed when HEARTBEAT.md missing | Create HEARTBEAT.md with content in workspace root |

---

## OpenClaw Deep Dive

### What is OpenClaw?

OpenClaw (v2026.2.2-3) is an open-source AI agent framework. It provides:

- **Gateway** — persistent WebSocket service managing sessions, routing, channels (port 18789)
- **Skills** — modular capabilities described by `SKILL.md`, installed via ClawHub or git
- **SOUL.md** — agent personality, injected into the system prompt
- **AGENTS.md** — operating instructions and rules
- **BOOTSTRAP.md** — first-run conversation script for agent identity discovery
- **Dashboard** — web UI for chat, configuration, logs, cron jobs
- **Security** — sandboxed execution, DM policies, credential storage in `~/.openclaw/secrets/`

### Key Files

| File | Purpose |
|------|---------|
| `~/.openclaw/openclaw.json` | Gateway config (model, port, auth) |
| `~/.openclaw/workspace/SOUL.md` | Agent personality |
| `~/.openclaw/workspace/AGENTS.md` | Operating rules |
| `~/.openclaw/workspace/BOOTSTRAP.md` | First-run identity discovery |
| `~/.openclaw/workspace/skills/*/SKILL.md` | Skill descriptors |
| `~/.openclaw/secrets/` | API keys, wallets (not in git) |

### Skills System

Skills are folders with a `SKILL.md` that describes capabilities the agent can use. Load precedence: workspace skills override global skills. Install via:
- `npx clawhub@latest install <skill-name>` (gets SKILL.md only)
- `git clone` (gets full source code — recommended)

### Gateway Cron Jobs

The gateway has a built-in cron scheduler for "wakeups" — scheduled agent runs through the LLM pipeline. This is different from our systemd timers which run Node scripts directly. Gateway cron jobs appear in the dashboard under Control → Cron Jobs.

---

## Key Concepts (x402, ERC-8004)

### x402 — HTTP 402 Payment Protocol

x402 enables **pay-per-request** for AI agents:

```
Agent                          Neynar Hub
  │                                │
  │  POST /v1/submitMessage        │
  │  X-PAYMENT: <base64 payload>   │
  │  Content-Type: octet-stream    │
  │ ─────────────────────────────► │
  │                                │
  │  The X-PAYMENT header contains:│
  │  - EIP-3009 signature          │
  │  - USDC transfer authorization │
  │  - from: agent wallet          │
  │  - to: Neynar payment address  │
  │  - value: 1000 (0.001 USDC)    │
  │                                │
  │  200 OK (cast submitted)       │
  │ ◄───────────────────────────── │
```

Key details:
- Uses **EIP-3009 `transferWithAuthorization`** — gasless USDC authorization
- Payment is **0.001 USDC per API call** (both reads and writes)
- Signed with the custody wallet's private key on Base (chain ID 8453)
- USDC contract on Base: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- Neynar payment address: `0xA6a8736f18f383f1cc2d938576933E5eA7Df01A1`

### ERC-8004 — Agent Discovery & Trust

ERC-8004 proposes three onchain registries:

1. **Identity Registry** — agent addresses, capabilities, metadata
2. **Reputation Registry** — onchain track record
3. **Validation Registry** — verify agent claims

Future work: register our agent for discoverability.

---

## File Structure (on VPS)

```
~/.openclaw/
├── openclaw.json                    ← gateway config
├── farcaster-credentials.json       ← FID, custody key, signer key (chmod 600)
├── secrets/
│   ├── farcaster-wallet.json        ← agent wallet
│   ├── prompt.env                   ← OPENROUTER_API_KEY, PROMPT_PROVIDER, PROMPT_MODEL
│   └── discovery.env                ← BRAVE_API_KEY for web research
└── workspace/
    ├── SOUL.md                      ← agent personality
    ├── AGENTS.md                    ← operating rules
    ├── BOOTSTRAP.md                 ← first-run identity script
    ├── HEARTBEAT.md                 ← cron job wake-up instructions
    └── farcaster-agent/             ← git clone of the skill
        ├── src/
        │   ├── index.js             ← exports: postCast, loadCredentials, etc.
        │   ├── post-cast.js         ← Hub-based cast posting via x402
        │   ├── x402.js              ← x402 payment header + request helper
        │   ├── config.js            ← RPC URLs, Neynar endpoints, USDC address
        │   ├── credentials.js       ← credential storage/loading
        │   ├── register-fid.js      ← FID registration on Optimism
        │   ├── add-signer.js        ← Ed25519 signer management
        │   └── set-profile.js       ← username, display name, bio
        ├── scripts/
        │   ├── daily_prompt.js      ← hourly build-streak posts (tracks recentCasts)
        │   ├── reply_to_replies.js  ← smart reply system (multi-cast, threading, research)
        │   ├── tip_winners.js       ← deterministic USDC tipping + tx reply
        │   └── discovery_job.js     ← Brave Search web research (6AM/6PM)
        ├── memory/
        │   ├── HEARTBEAT.md         ← wake-up instructions
        │   └── DISCOVERY.md         ← latest Base ecosystem news (auto-generated)
        └── .state/
            ├── daily_prompt.json    ← streak, recent prompts, last hash, recentCasts
            ├── replies.json         ← which replies we've responded to + runCount
            ├── tips.json            ← which casts we've tipped for
            └── discovery.json       ← raw discovery results + sparks

~/.config/systemd/user/
├── openclaw-gateway.service         ← gateway (always running)
├── bea-heartbeat.service + .timer   ← hourly posting
├── bea-replies.service + .timer     ← smart reply check every 15 min
├── bea-tips.service + .timer        ← daily tipping at 4 PM
└── bea-discovery.service + .timer   ← web research at 6AM/6PM
```

---

## Cost Budget

With the agent wallet holding USDC on Base:

| Action | Cost | Frequency | Daily Cost |
|--------|------|-----------|------------|
| Heartbeat (post) | 0.001 USDC | ~3/day | 0.003 |
| Reply reads (multi-cast) | 0.001 USDC | ~108/day | 0.108 |
| Reply posts | 0.001 USDC | ~5/day | 0.005 |
| Tip read | 0.001 USDC | 1/day | 0.001 |
| Tip post (reply) | 0.001 USDC | 2/day (2 winners) | 0.002 |
| USDC tips | 0.02 USDC | 2/day | 0.040 |
| LLM (OpenRouter) | varies | ~15 calls/day | ~0.01 |
| Brave Search | free | ~6/day | 0.000 |
| **Total** | | | **~0.18 USDC/day** |

With 1 USDC, the agent runs for ~5.5 days.

---

## Troubleshooting

**"Missing Farcaster credentials"**
→ Check `~/.openclaw/farcaster-credentials.json` exists with `_active` pointing to the right FID.

**"Missing SIGNER_PK or FID"**
→ `export` your shell variables before running Node scripts.

**Agent posts nothing / "Failed to generate prompt"**
→ Check API keys in `~/.openclaw/secrets/prompt.env`. Test with `--dry-run`.

**"Insufficient USDC for tip"**
→ Fund the agent wallet with USDC on Base mainnet.

**x402 submit fails**
→ Agent wallet needs USDC on Base. Check balance: `node -e "..."` (see Step 7).

**Systemd timer not firing**
→ `loginctl enable-linger $USER` + `systemctl --user daemon-reload`

**Dashboard empty / not responding**
→ Check model in `openclaw.json`. Switch to `openrouter/anthropic/claude-3.5-haiku` (cheap, fast).

**Bridge reverts during auto-setup**
→ Use the manual flow (Step 3). It's more reliable.

**postCast() doesn't support replies**
→ Build `CastAdd` directly with `@farcaster/hub-nodejs` and `parentCastId`. See `reply_to_replies.js`.

**Brave Search 429 rate limiting**
→ Free plan allows 1 req/sec. Add `await sleep(1500)` between API calls. See `discovery_job.js`.

**Cron job fails with `empty-heartbeat-file`**
→ Create `HEARTBEAT.md` with content in the workspace root (`~/.openclaw/workspace/farcaster-agent/HEARTBEAT.md`). File must not be empty.

**Reply script only checks latest cast**
→ The upgraded `reply_to_replies.js` fetches agent's own casts directly from Neynar API. No longer depends on `daily_prompt.json`.

**LLM replies have extra quotes or get cut mid-word**
→ `cleanText()` strips surrounding quotes. `truncateAtWord()` cuts at the last space instead of mid-word.

**Large scripts get corrupted via heredoc on VPS**
→ Use `scp` to copy files from your Mac to the VPS instead of pasting via terminal.

---

## Resources

- [OpenClaw Docs](https://docs.openclaw.ai)
- [Farcaster Agent Repo](https://github.com/rishavmukherji/farcaster-agent)
- [Neynar API Docs](https://docs.neynar.com)
- [x402 Protocol](https://www.x402.org)
- [ERC-8004 Draft](https://eips.ethereum.org/EIPS/eip-8004)
- [Base Docs](https://docs.base.org)
- [EIP-3009 (transferWithAuthorization)](https://eips.ethereum.org/EIPS/eip-3009)

---

*Built by Base East Africa DevRel for the Base Builder Quest.*
*Agent powered by OpenClaw + Claude + x402 on Base.*
