# Workshop Commands — Build Your Own Farcaster AI Agent

> Every command from zero to a fully autonomous Farcaster agent on a VPS.
> Works on **Mac**, **Linux**, or **WSL (Windows)**.

---

## Before You Start — What You Need

| Item | Where to Get It | Cost |
|------|----------------|------|
| A VPS (Ubuntu 24.04) | [contabo.com/en/openclaw-hosting](https://contabo.com/en/openclaw-hosting/) or any VPS provider | ~$7/mo |
| ETH on **Optimism** | Bridge from mainnet or buy on an exchange | ~$0.50 (for FID registration) |
| USDC on **Base** | Bridge or buy — this funds your agent's API calls | ~$1+ |
| OpenRouter API key | [openrouter.ai](https://openrouter.ai) (free tier) | Free |
| A terminal | Terminal (Mac), WSL/PowerShell (Windows), or any Linux terminal | — |

---

## Part 1 — Connect to Your VPS

### From Mac / Linux

```bash
ssh root@YOUR_VPS_IP
```

### From Windows (WSL)

Open WSL (Ubuntu) from Start Menu, then:

```bash
ssh root@YOUR_VPS_IP
```

### From Windows (PowerShell — no WSL)

```powershell
ssh root@YOUR_VPS_IP
```

> Replace `YOUR_VPS_IP` with the IP address from your VPS provider (e.g., `81.0`).

---

## Part 2 — Install Node.js on VPS

Run these commands **on the VPS** (after SSH-ing in):

```bash
# Install nvm (Node Version Manager)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash

# Reload shell to pick up nvm
source ~/.bashrc

# Install Node.js 22
nvm install 22

# Verify
node -v
# Should show: v22.x.x
```

---

## Part 3 — Install OpenClaw

Still **on the VPS**:

```bash
# Install OpenClaw globally
npm i -g openclaw

# Verify
openclaw --version
# Should show: 2026.2.x

# Run the setup wizard (sets up config, workspace, etc.)
openclaw setup
```

The setup wizard creates:
- `~/.openclaw/openclaw.json` — config file
- `~/.openclaw/workspace/` — your agent's home directory

### Enable systemd user services (CRITICAL)

This lets your agent's timers keep running after you disconnect from SSH:

```bash
loginctl enable-linger $USER
```

---

## Part 4 — Install the Farcaster Agent Skill

Still **on the VPS**:

```bash
# Go to the OpenClaw workspace
cd ~/.openclaw/workspace

# Clone the farcaster-agent repo (has wallet creation, FID registration, casting, x402)
git clone https://github.com/rishavmukherji/farcaster-agent.git

# Install dependencies
cd farcaster-agent
npm install
```

This gives you:
- `src/auto-setup.js` — wallet creation
- `src/register-fid.js` — Farcaster ID registration
- `src/add-signer.js` — signer key management
- `src/post-cast.js` — post to Farcaster via x402
- `src/x402.js` — payment protocol implementation
- `src/set-profile.js` — set username, display name, bio

---

## Part 5 — Create a Wallet

Still **on the VPS**, inside `~/.openclaw/workspace/farcaster-agent`:

```bash
node src/auto-setup.js
```

This generates a custody wallet and saves it to `~/.openclaw/secrets/farcaster-wallet.json`. **Write down the wallet address!**

> **Important**: `auto-setup.js` may try to swap USDC→ETH and bridge Base→Optimism. If the bridge reverts, don't worry — we'll do the rest manually. The wallet is still created and saved.

### Fund the wallet

Your wallet needs two things:

| Chain | Asset | Amount | Purpose |
|-------|-------|--------|---------|
| **Optimism** | ETH | ~0.0003 ETH | FID registration + signer |
| **Base** | USDC | ~$1+ | x402 API calls (0.001 USDC each) |

Send funds to the wallet address that `auto-setup.js` printed.

> **Tip**: Use [bridge.base.org](https://bridge.base.org) or withdraw from an exchange directly to the right chain. registration costs ~0.0002–0.0003 ETH on Optimism.

### Wait for funds to arrive, then verify

```bash
# Check ETH balance on Optimism (for FID registration)
node -e "
const { ethers } = require('ethers');
const p = new ethers.JsonRpcProvider('https://mainnet.optimism.io');
p.getBalance('YOUR_WALLET_ADDRESS').then(b => console.log('ETH on OP:', ethers.formatEther(b)));
"

# Check USDC balance on Base (for x402 API calls)
node -e "
const { ethers } = require('ethers');
const p = new ethers.JsonRpcProvider('https://mainnet.base.org');
const usdc = new ethers.Contract('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', ['function balanceOf(address) view returns (uint256)'], p);
usdc.balanceOf('YOUR_WALLET_ADDRESS').then(b => console.log('USDC on Base:', ethers.formatUnits(b, 6)));
"
```

---

## Part 6 — Register FID, Add Signer, Save Credentials

This is the most important part. Run these **one by one** on the VPS. Stop if any step errors.

```bash
cd ~/.openclaw/workspace/farcaster-agent

# Load wallet private key from the saved wallet file
export PRIVATE_KEY=$(node -p "require(process.env.HOME + '/.openclaw/secrets/farcaster-wallet.json').privateKey")
```

### Step 1 — Register FID (on Optimism)

```bash
node src/register-fid.js
```

**Write down the FID number** from the output (e.g., `2660927`).

### Step 2 — Add signer (on Optimism)

```bash
node src/add-signer.js
```

**Write down the signer private key** from the output.

### Step 3 — Save credentials

The manual flow does NOT auto-save credentials. Check first:

```bash
node src/credentials.js get
```

If it says "No credentials found", save them with this script:

```bash
read -s -p "Signer private key: " SIGNER_PK; echo
read -p "FID: " FID
export SIGNER_PK FID

node - <<'NODE'
const fs = require('fs');
const path = require('path');

const signer = process.env.SIGNER_PK;
const fid = Number(process.env.FID);
if (!signer || !fid) { console.error('Missing SIGNER_PK or FID'); process.exit(1); }

const walletPath = path.join(process.env.HOME, '.openclaw', 'secrets', 'farcaster-wallet.json');
const wallet = JSON.parse(fs.readFileSync(walletPath, 'utf8'));

const data = {};
data[String(fid)] = {
  fid: String(fid),
  custodyPrivateKey: wallet.privateKey,
  signerPrivateKey: signer,
  fname: null,
  createdAt: new Date().toISOString()
};
data._active = String(fid);

const out = path.join(process.env.HOME, '.openclaw', 'farcaster-credentials.json');
fs.writeFileSync(out, JSON.stringify(data, null, 2), { mode: 0o600 });
console.log('Credentials saved to', out);
NODE

unset SIGNER_PK FID
```

> **Critical**: The `export SIGNER_PK FID` line is what makes these visible to Node.js. Without `export`, the script will say "Missing SIGNER_PK or FID". This is the most common mistake.

### Verify credentials saved

```bash
node src/credentials.js list
node src/credentials.js get
```

You should see your FID and keys.

---

## Part 7 — Test Your First Cast

```bash
cd ~/.openclaw/workspace/farcaster-agent

export PRIVATE_KEY=$(node -p "require(process.env.HOME + '/.openclaw/secrets/farcaster-wallet.json').privateKey")
export SIGNER_PRIVATE_KEY=$(node -p "JSON.parse(require('fs').readFileSync(process.env.HOME+'/.openclaw/farcaster-credentials.json','utf8'))[JSON.parse(require('fs').readFileSync(process.env.HOME+'/.openclaw/farcaster-credentials.json','utf8'))._active].signerPrivateKey")
export FID=$(node -p "JSON.parse(require('fs').readFileSync(process.env.HOME+'/.openclaw/farcaster-credentials.json','utf8'))._active")

node src/post-cast.js "gm from my autonomous agent!"
```

If you see `Submitted successfully` and `Cast verified on network!` — you're live on Farcaster! Each cast costs 0.001 USDC via x402.

---

## Part 8 — Set Your Agent's Profile

```bash
cd ~/.openclaw/workspace/farcaster-agent

node - <<'NODE'
const { setupFullProfile, loadCredentials } = require('./src');

(async () => {
  const creds = loadCredentials();
  await setupFullProfile({
    privateKey: creds.custodyPrivateKey,
    signerPrivateKey: creds.signerPrivateKey,
    fid: Number(creds.fid),
    fname: 'youragentname',
    displayName: 'Your Agent Display Name',
    bio: 'Your agent bio. Built on Base with OpenClaw.',
    pfpUrl: 'https://api.dicebear.com/7.x/bottts/png?seed=youragentname'
  });
  console.log('Profile updated');
})().catch(err => {
  console.error('Profile update failed:', err?.message || err);
  process.exit(1);
});
NODE
```

Replace `youragentname` (lowercase, 1-16 chars), display name, bio, and PFP URL with your own values.

> **Note**: Farcaster usernames can only be changed once every 28 days. Pick one you're happy with.

---

## Part 9 — Define Your Agent's Personality

### SOUL.md — who your agent IS

```bash
cat > ~/.openclaw/workspace/farcaster-agent/config/SOUL.md << 'EOF'
# My Agent Name — Soul

I am [Your Agent Name], an autonomous [role] agent on Farcaster.
My mission: [what your agent does — e.g., "celebrate builders and share daily updates"].

## Personality
- [Trait 1 — e.g., "Warm, supportive, builder-first"]
- [Trait 2 — e.g., "Knows crypto, Base, and Ethereum deeply"]
- [Trait 3 — e.g., "Transparent — if unsure, says so"]

## Voice
- Clear, direct, optimistic.
- Say "onchain," not "on-chain."
- Lead with the benefit, then the tech.

## Community posture
- I'm not an official Base or Coinbase account.
- I exist to uplift builders, not to ask for secrets or funds.
EOF
```

### AGENTS.md — how your agent OPERATES

```bash
cat > ~/.openclaw/workspace/farcaster-agent/config/AGENTS.md << 'EOF'
# AGENTS.md

## Agent: main
Role: autonomous community agent on Farcaster.

### Rules
- Post daily prompts encouraging builders to share progress.
- Reply to community members with warm, contextual responses.
- Keep everything transparent and reproducible.

### Safety
- Never ask for private keys, seed phrases, or secrets.
- Never claim official endorsement by any company.
- If funds are low, say so and pause any tipping.
- If uncertain about a fact, say "I'm not sure."
EOF
```

> **Customize these!** Your agent's personality is what makes it unique. Edit these files to match YOUR community.

---

## Part 10 — Set Up API Keys

### OpenRouter (for LLM — generates your agent's posts and replies)

Get your free API key at [openrouter.ai](https://openrouter.ai), then:

```bash
mkdir -p ~/.openclaw/secrets

cat > ~/.openclaw/secrets/prompt.env << 'EOF'
OPENROUTER_API_KEY=sk-or-v1-YOUR_OPENROUTER_KEY_HERE
PROMPT_PROVIDER=openrouter
PROMPT_MODEL=anthropic/claude-3.5-haiku
EOF

chmod 600 ~/.openclaw/secrets/prompt.env
```

### Verify the key works

```bash
source ~/.openclaw/secrets/prompt.env

curl -s https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"anthropic/claude-3.5-haiku","messages":[{"role":"user","content":"Say gm in 5 words"}],"max_tokens":20}' | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
console.log(d.choices?.[0]?.message?.content || 'ERROR: ' + JSON.stringify(d));
"
```

---

## Part 11 — Create the Daily Prompt Script

This script posts a build-streak prompt every hour (with probability and cooldown logic).

```bash
cd ~/.openclaw/workspace/farcaster-agent
mkdir -p scripts
```

The `daily_prompt.js` script is large — **do NOT paste it via heredoc** (it gets corrupted). Instead, write it to a file on your local machine and `scp` it:

### From your LOCAL machine (Mac/Linux/WSL):

```bash
# Copy the script from your local machine to the VPS
scp /path/to/your/daily_prompt.js root@YOUR_VPS_IP:~/.openclaw/workspace/farcaster-agent/scripts/daily_prompt.js
```

> **I will share the `daily_prompt.js` file. Save it to your local machine, then `scp` it to your VPS.

### Test it

Back **on the VPS**:

```bash
cd ~/.openclaw/workspace/farcaster-agent
node scripts/daily_prompt.js --dry-run
```

`--dry-run` shows what would be posted without actually posting. When you're ready:

```bash
node scripts/daily_prompt.js --force
```

`--force` bypasses cooldown/probability and posts immediately.

---

## Part 12 — Create the Reply Script

The reply script checks for new replies to your agent's casts and responds. It has:
- Multi-cast checking (checks ALL recent posts, not just the latest)
- Conversation threading (follows reply chains)
- Web research (searches Brave for projects people mention)
- 4 different reply styles (casual, builder+research, builder, thread continuation)

### From your LOCAL machine:

```bash
scp /path/to/your/reply_to_replies.js root@YOUR_VPS_IP:~/.openclaw/workspace/farcaster-agent/scripts/reply_to_replies.js
```

### Test it on the VPS

```bash
cd ~/.openclaw/workspace/farcaster-agent
node scripts/reply_to_replies.js --dry-run
```

---

## Part 13 — Set Up Systemd Timers (Automation)

This is what makes the agent truly autonomous — it posts and replies on a schedule, even after you disconnect from SSH.

### Create the systemd directory

```bash
mkdir -p ~/.config/systemd/user
```

### Heartbeat service (hourly posting)

```bash
cat > ~/.config/systemd/user/agent-heartbeat.service << 'EOF'
[Unit]
Description=My Agent — hourly heartbeat post
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=%h/.openclaw/workspace/farcaster-agent
ExecStart=/usr/bin/node scripts/daily_prompt.js
Environment=HOME=%h
TimeoutStartSec=120
EOF
```

```bash
cat > ~/.config/systemd/user/agent-heartbeat.timer << 'EOF'
[Unit]
Description=My Agent — hourly heartbeat

[Timer]
OnCalendar=hourly
RandomizedDelaySec=300
Persistent=true

[Install]
WantedBy=timers.target
EOF
```

### Reply service (every 30 minutes)

```bash
cat > ~/.config/systemd/user/agent-replies.service << 'EOF'
[Unit]
Description=My Agent — reply to replies
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=%h/.openclaw/workspace/farcaster-agent
ExecStart=/usr/bin/node scripts/reply_to_replies.js
Environment=HOME=%h
TimeoutStartSec=120
EOF
```

```bash
cat > ~/.config/systemd/user/agent-replies.timer << 'EOF'
[Unit]
Description=My Agent — check for replies every 30 min

[Timer]
OnCalendar=*:00,30
RandomizedDelaySec=120
Persistent=true

[Install]
WantedBy=timers.target
EOF
```

### OpenClaw Gateway service (web dashboard)

```bash
cat > ~/.config/systemd/user/openclaw-gateway.service << 'EOF'
[Unit]
Description=OpenClaw Gateway
After=network-online.target

[Service]
Type=simple
ExecStart=%h/.local/bin/openclaw gateway
Restart=on-failure
RestartSec=10
Environment=HOME=%h

[Install]
WantedBy=default.target
EOF
```

### Enable everything

```bash
# Reload systemd to pick up new files
systemctl --user daemon-reload

# Enable and start all timers
systemctl --user enable --now agent-heartbeat.timer
systemctl --user enable --now agent-replies.timer
systemctl --user enable --now openclaw-gateway.service
```

### Verify timers are running

```bash
systemctl --user list-timers --all
```

You should see your timers listed with their next trigger time.

### Check logs

```bash
# See heartbeat logs
journalctl --user -u agent-heartbeat.service --since today

# See reply logs
journalctl --user -u agent-replies.service --since today

# See gateway logs
journalctl --user -u openclaw-gateway.service --since today -f
```

---

## Part 14 — Access the Dashboard (from your local machine)

The OpenClaw dashboard runs on port 18789 on the VPS, but it's only accessible locally. Use an SSH tunnel:

### From Mac / Linux / WSL:

```bash
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3
```

Then open **http://localhost:18789** in your browser.

### From Windows (PowerShell):

```powershell
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
```

Then open **http://localhost:18789** in your browser.

The dashboard lets you:
- Chat with your agent directly
- View logs and sessions
- Create cron jobs (scheduled LLM wakeups)
- Configure agent settings

---

## Part 15 — Configure the Gateway LLM

The gateway defaults to an expensive model. Switch to a fast, cheap one:

**On the VPS:**

```bash
# Open the config file
nano ~/.openclaw/openclaw.json
```

Find the `model` section and change it to:

```json
"model": {
  "primary": "openrouter/anthropic/claude-3.5-haiku"
}
```

Then restart the gateway:

```bash
systemctl --user restart openclaw-gateway.service
```

---

## You're Done! 🎉

Your agent is now:
- **Posting** hourly build-streak prompts to Farcaster
- **Replying** to community members every 30 minutes
- **Running 24/7** on your VPS via systemd timers
- **Accessible** via the OpenClaw dashboard

### What it costs

| Action | Cost per call | Daily |
|--------|--------------|-------|
| Post a cast | 0.001 USDC | ~0.003 |
| Read replies | 0.001 USDC | ~0.048 |
| Post replies | 0.001 USDC | ~0.005 |
| LLM (OpenRouter) | varies | ~0.01 |
| **Total** | | **~0.07 USDC/day** |

With $1 USDC, a basic agent runs for **~14 days**.

---

## Optional Extras

### Add USDC Tipping on Base

If you want your agent to tip builders with USDC:

1. Get the `tip_winners.js` script from your instructor
2. `scp` it to `scripts/tip_winners.js` on the VPS
3. Create the timer:

```bash
cat > ~/.config/systemd/user/agent-tips.service << 'EOF'
[Unit]
Description=My Agent — daily tipping
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=%h/.openclaw/workspace/farcaster-agent
ExecStart=/usr/bin/node scripts/tip_winners.js
Environment=HOME=%h
Environment=TIP_MAX_WINNERS=2
Environment=TIP_AMOUNT_USDC=0.02
TimeoutStartSec=180
EOF
```

```bash
cat > ~/.config/systemd/user/agent-tips.timer << 'EOF'
[Unit]
Description=My Agent — daily tipping

[Timer]
OnCalendar=16:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now agent-tips.timer
```

**How tipping works:**
- Reads replies to your latest post
- Gets each replier's verified Farcaster wallet automatically
- Picks winners using `keccak256(blockHash + castHash + timestamp)` — fully deterministic and auditable
- Sends USDC on Base via `usdc.transfer()`
- Replies to the winner with a celebratory message + basescan tx link

**Want to transact with something other than USDC, or on a different chain?** You'll need to write your own transaction logic. The `tip_winners.js` script is a great starting point — replace the USDC transfer section with your own contract calls.

### Add Web Research (Brave Search)

If you want your agent to search the web for Base ecosystem news:

1. Get a free Brave Search API key at [brave.com/search/api](https://brave.com/search/api)
2. Save it:

```bash
cat > ~/.openclaw/secrets/discovery.env << 'EOF'
BRAVE_API_KEY=BSAxxxxxxxxxxxxxxxxxxxxxxxxx
EOF

chmod 600 ~/.openclaw/secrets/discovery.env
```

3. Get the `discovery_job.js` script and `scp` it to `scripts/`
4. Create the timer:

```bash
cat > ~/.config/systemd/user/agent-discovery.service << 'EOF'
[Unit]
Description=My Agent — web research
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=%h/.openclaw/workspace/farcaster-agent
ExecStart=/usr/bin/node scripts/discovery_job.js
Environment=HOME=%h
TimeoutStartSec=180
EOF
```

```bash
cat > ~/.config/systemd/user/agent-discovery.timer << 'EOF'
[Unit]
Description=My Agent — web research twice daily

[Timer]
OnCalendar=06:30,18:30
Persistent=true

[Install]
WantedBy=timers.target
EOF
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now agent-discovery.timer
```

### Add HEARTBEAT.md for Gateway Cron Jobs

If you want the dashboard's cron scheduler to wake your agent:

```bash
cat > ~/.openclaw/workspace/farcaster-agent/HEARTBEAT.md << 'EOF'
# HEARTBEAT

I am [Your Agent Name], an autonomous agent on Farcaster.

## On Wake
1. Check my recent activity and discovery notes
2. Think about what my community needs right now
3. Decide whether to:
   - Post an encouraging message
   - Share a useful tip
   - Stay quiet until next time

## Guidelines
- Only post if I have something worth saying
- Keep posts under 280 characters
- Be warm, genuine, helpful
- Max one emoji per post
EOF
```

Then create a cron job in the dashboard under **Control → Cron Jobs**.

---

## Troubleshooting

### "Missing Farcaster credentials"
```bash
# Check the file exists and has the right format
cat ~/.openclaw/farcaster-credentials.json
# Make sure _active points to the right FID
```

### "command not found: node"
```bash
source ~/.bashrc
# If nvm not found:
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash
source ~/.bashrc
nvm install 22
```

### Shell variables not working with Node.js
```bash
# WRONG — variable is invisible to Node:
CUSTODY_PK="0x..."
node src/register-fid.js

# RIGHT — export makes it visible:
export CUSTODY_PK="0x..."
node src/register-fid.js
```

### Agent posted nothing / "Failed to generate prompt"
```bash
# Check API keys
cat ~/.openclaw/secrets/prompt.env
# Test with dry run
node scripts/daily_prompt.js --dry-run --force
```

### "Insufficient USDC"
Your agent wallet needs USDC on Base. Check balance:
```bash
cd ~/.openclaw/workspace/farcaster-agent
node -e "
const { ethers } = require('ethers');
const p = new ethers.JsonRpcProvider('https://mainnet.base.org');
const usdc = new ethers.Contract('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', ['function balanceOf(address) view returns (uint256)'], p);
usdc.balanceOf('YOUR_WALLET_ADDRESS').then(b => console.log('USDC:', ethers.formatUnits(b, 6)));
"
```

### Timers not firing after SSH disconnect
```bash
# This is the most common issue — you MUST run this:
loginctl enable-linger $USER

# Then reload and re-enable:
systemctl --user daemon-reload
systemctl --user enable --now agent-heartbeat.timer
systemctl --user enable --now agent-replies.timer
```

### Large scripts get corrupted when pasted
**Never paste large scripts via terminal heredoc.** Use `scp` from your local machine:
```bash
# From Mac/Linux/WSL (NOT on the VPS):
scp /path/to/script.js root@YOUR_VPS_IP:~/.openclaw/workspace/farcaster-agent/scripts/script.js
```

### Dashboard empty / not responding
```bash
# Check the model in openclaw.json
nano ~/.openclaw/openclaw.json
# Change to: "primary": "openrouter/anthropic/claude-3.5-haiku"
systemctl --user restart openclaw-gateway.service
```

### Brave Search 429 errors
The free plan allows 1 request per second. The `discovery_job.js` script has a 1.5s delay built in. If you see 429 errors, wait a minute and try again.

---

## Quick Reference — All Commands in Order

```
1.  ssh root@YOUR_VPS_IP
2.  curl ... | bash                    # install nvm
3.  nvm install 22                     # install Node
4.  npm i -g openclaw                  # install OpenClaw
5.  openclaw setup                     # configure
6.  loginctl enable-linger $USER       # enable persistent timers
7.  cd ~/.openclaw/workspace
8.  git clone .../farcaster-agent.git  # clone skill
9.  cd farcaster-agent && npm install  # install deps
10. node src/auto-setup.js             # create wallet
11. [FUND WALLET — ~0.0003 ETH on OP + ~$1 USDC on Base]
12. export PRIVATE_KEY=$(node -p ...)  # load wallet key
13. node src/register-fid.js           # get FID
14. node src/add-signer.js             # get signer key
15. [SAVE credentials via script]      # export SIGNER_PK FID
16. node src/credentials.js get        # verify saved
17. node src/post-cast.js "gm!"        # test cast
18. [SET PROFILE via setupFullProfile] # username, bio, pfp
19. [CREATE SOUL.md + AGENTS.md]
20. [CREATE prompt.env with OpenRouter key]
21. [SCP scripts from local machine]
22. node scripts/daily_prompt.js --dry-run     # test
23. node scripts/daily_prompt.js --force        # first real post
24. [CREATE systemd service + timer files]
25. systemctl --user daemon-reload
26. systemctl --user enable --now agent-heartbeat.timer
27. systemctl --user enable --now agent-replies.timer
28. systemctl --user enable --now openclaw-gateway.service
29. systemctl --user list-timers --all          # verify
30. [SSH TUNNEL from local machine for dashboard]
```

---

*Built at the Base East Africa Workshop, Feb 2026.*
*Powered by OpenClaw + Claude + x402 on Base.*
