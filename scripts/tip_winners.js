#!/usr/bin/env node
'use strict';

/**
 * tip_winners.js — Deterministic USDC tipping for build-streak replies.
 *
 * Uses x402 to read conversation replies (0.001 USDC per read).
 * Uses ethers.js to send USDC tips directly on Base.
 * After tipping, replies to the winner with the tx hash on Farcaster.
 *
 * Winner selection: keccak256(blockHash + castHash + postTimestamp) — fully auditable.
 *
 * Run from the farcaster-agent directory:
 *   cd ~/.openclaw/workspace/farcaster-agent
 *   node scripts/tip_winners.js
 *   node scripts/tip_winners.js --dry-run
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const {
  makeCastAdd,
  NobleEd25519Signer,
  FarcasterNetwork,
  Message
} = require('@farcaster/hub-nodejs');

const { loadCredentials } = require('../src/credentials');
const { RPC, NEYNAR, USDC_BASE } = require('../src/config');
const { x402Request, submitMessage } = require('../src/x402');

const isDryRun = process.argv.includes('--dry-run');

const STATE_DIR = path.join(__dirname, '..', '.state');
const PROMPT_STATE = path.join(STATE_DIR, 'daily_prompt.json');
const TIP_STATE = path.join(STATE_DIR, 'tips.json');
const ENV_FILE = path.join(process.env.HOME, '.openclaw', 'secrets', 'prompt.env');

const TIP_AMOUNT_USDC = process.env.TIP_AMOUNT_USDC || '0.02';
const TIP_MAX_WINNERS = Number(process.env.TIP_MAX_WINNERS || 1);
const TIP_MIN_AGE_MINUTES = Number(process.env.TIP_MIN_AGE_MINUTES || 120);

const USDC_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)'
];

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (key && !process.env[key]) process.env[key] = val;
  }
}
loadEnvFile(ENV_FILE);

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function getEthAddress(author) {
  if (author?.verified_addresses?.primary?.eth_address) {
    return author.verified_addresses.primary.eth_address;
  }
  if (author?.verified_addresses?.eth_addresses?.length) {
    return author.verified_addresses.eth_addresses[0];
  }
  if (author?.custody_address) {
    return author.custody_address;
  }
  return null;
}

async function fetchReplies(wallet, castHash) {
  const result = await x402Request(wallet, {
    hostname: NEYNAR.API,
    path: '/v2/farcaster/cast/conversation?identifier=' + castHash + '&type=hash&reply_depth=2',
    method: 'GET'
  });
  if (result.status !== 200) {
    console.error('Failed to fetch conversation:', result.status, result.data);
    return [];
  }
  const out = [];
  const visit = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (obj.object === 'cast') out.push(obj);
    if (Array.isArray(obj)) {
      for (const item of obj) visit(item);
    } else {
      for (const v of Object.values(obj)) visit(v);
    }
  };
  visit(result.data);
  return out;
}

async function postReply(wallet, signer, fid, text, parentHash, parentFid) {
  const castResult = await makeCastAdd(
    {
      text,
      embeds: [],
      embedsDeprecated: [],
      mentions: [],
      mentionsPositions: [],
      parentCastId: {
        fid: parentFid,
        hash: Uint8Array.from(Buffer.from(parentHash.replace('0x', ''), 'hex'))
      }
    },
    { fid, network: FarcasterNetwork.MAINNET },
    signer
  );
  if (castResult.isErr()) {
    throw new Error('Failed to create reply: ' + castResult.error);
  }
  const cast = castResult.value;
  const hash = '0x' + Buffer.from(cast.hash).toString('hex');
  const messageBytes = Buffer.from(Message.encode(cast).finish());
  const submitResult = await submitMessage(wallet, messageBytes);
  if (submitResult.status !== 200) {
    throw new Error('Submit failed (' + submitResult.status + '): ' + JSON.stringify(submitResult.data));
  }
  return { hash };
}

async function generateTipMessage(username, txHash, amount) {
  const provider = (process.env.PROMPT_PROVIDER || '').toLowerCase();
  const useOpenRouter = provider === 'openrouter' || process.env.OPENROUTER_API_KEY;
  const useAnthropic = provider === 'anthropic' || process.env.ANTHROPIC_API_KEY;

  if (!useOpenRouter && !useAnthropic) {
    return 'You got tipped ' + amount + ' USDC onchain! Keep building.';
  }

  const system = [
    'You are Based East Africa Builds, a friendly community agent on Farcaster.',
    'You just tipped a builder with USDC on Base for sharing their work.',
    'Write a SHORT celebratory reply (1 sentence, max 140 chars, no hashtags).',
    'Be warm, genuine, varied each time. Celebrate their building spirit.',
    'Do NOT include the transaction link — it will be appended automatically.',
    'Max one emoji.'
  ].join(' ');

  const user = 'Write a tip celebration message for @' + username + ' who just got ' + amount + ' USDC for building on Base.';

  async function callOpenRouter() {
    const model = process.env.PROMPT_MODEL || 'anthropic/claude-3.5-haiku';
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model, temperature: 0.95, max_tokens: 80,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    });
    const json = await res.json();
    return json?.choices?.[0]?.message?.content?.trim();
  }

  async function callAnthropic() {
    const model = process.env.PROMPT_MODEL || 'claude-3-5-haiku-20241022';
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model, temperature: 0.95, max_tokens: 80,
        system,
        messages: [{ role: 'user', content: user }]
      })
    });
    const json = await res.json();
    return json?.content?.[0]?.text?.trim();
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const text = useOpenRouter ? await callOpenRouter() : await callAnthropic();
    if (text && text.length <= 140) return text;
  }

  return 'Shipped and tipped! Keep building on Base';
}

(async () => {
  const creds = loadCredentials();
  if (!creds || !creds.custodyPrivateKey || !creds.signerPrivateKey) {
    throw new Error('Missing credentials');
  }

  const agentFid = Number(creds.fid);

  const promptState = readJson(PROMPT_STATE, null);
  if (!promptState?.lastHash || !promptState?.lastPostAt) {
    console.log('No prompt state found, skipping');
    return;
  }

  const lastPostAt = new Date(promptState.lastPostAt);
  const minutesSince = (Date.now() - lastPostAt.getTime()) / 60000;
  if (minutesSince < TIP_MIN_AGE_MINUTES) {
    console.log('Prompt too recent (' + Math.round(minutesSince) + ' min, need ' + TIP_MIN_AGE_MINUTES + '), skipping');
    return;
  }

  const tipsState = readJson(TIP_STATE, { tipped: {} });
  if (tipsState.tipped[promptState.lastHash]) {
    console.log('Already tipped for this cast');
    return;
  }

  const provider = new ethers.JsonRpcProvider(RPC.BASE);
  const wallet = new ethers.Wallet(creds.custodyPrivateKey, provider);

  const signerKey = creds.signerPrivateKey.startsWith('0x')
    ? creds.signerPrivateKey.slice(2)
    : creds.signerPrivateKey;
  const signer = new NobleEd25519Signer(Buffer.from(signerKey, 'hex'));

  console.log('Fetching replies to: ' + promptState.lastHash);
  const replies = await fetchReplies(wallet, promptState.lastHash);

  const eligible = [];
  for (const c of replies) {
    if (c.author?.fid === agentFid) continue;
    const address = getEthAddress(c.author);
    if (!address) continue;
    eligible.push({
      fid: c.author?.fid,
      username: c.author?.username || 'fid:' + c.author?.fid,
      hash: c.hash,
      address,
      text: c.text || ''
    });
  }

  if (!eligible.length) {
    console.log('No eligible replies (no verified Farcaster wallets found)');
    return;
  }

  console.log(eligible.length + ' eligible replies with verified wallets');
  for (const e of eligible) {
    console.log('  @' + e.username + ' -> ' + e.address);
  }

  const block = await provider.getBlock('latest');
  const seed = block.hash + ':' + promptState.lastHash + ':' + promptState.lastPostAt;
  const seedHash = ethers.keccak256(ethers.toUtf8Bytes(seed));

  console.log('\nSelection seed: ' + seed);

  let idx = Number(BigInt(seedHash) % BigInt(eligible.length));
  const winners = [];
  const pool = [...eligible];

  while (winners.length < TIP_MAX_WINNERS && pool.length) {
    winners.push(pool.splice(idx, 1)[0]);
    if (!pool.length) break;
    idx = Number(BigInt(ethers.keccak256(ethers.toUtf8Bytes(seed + winners.length))) % BigInt(pool.length));
  }

  console.log('\nWinners:');
  for (const w of winners) {
    console.log('  @' + w.username + ' -> ' + w.address);
  }

  const usdc = new ethers.Contract(USDC_BASE, USDC_ABI, wallet);
  const decimals = await usdc.decimals();
  const tipAmount = ethers.parseUnits(TIP_AMOUNT_USDC, decimals);
  const totalNeeded = tipAmount * BigInt(winners.length);
  const balance = await usdc.balanceOf(wallet.address);

  console.log('\nTip: ' + TIP_AMOUNT_USDC + ' USDC | Needed: ' + ethers.formatUnits(totalNeeded, decimals) + ' | Balance: ' + ethers.formatUnits(balance, decimals));

  if (balance < totalNeeded) {
    console.log('Insufficient USDC');
    return;
  }

  if (isDryRun) {
    console.log('\n[DRY RUN] Would tip winners and reply with tx hash');
    return;
  }

  const txs = [];
  for (const w of winners) {
    console.log('\nSending ' + TIP_AMOUNT_USDC + ' USDC to @' + w.username + ' (' + w.address + ')...');
    const tx = await usdc.transfer(w.address, tipAmount);
    console.log('  TX hash: ' + tx.hash);
    const receipt = await tx.wait();
    console.log('  Confirmed in block ' + receipt.blockNumber);

    txs.push({ address: w.address, username: w.username, txHash: tx.hash });

    const msg = await generateTipMessage(w.username, tx.hash, TIP_AMOUNT_USDC);
    const fullReply = msg + '\n\nhttps://basescan.org/tx/' + tx.hash;
    console.log('  Reply: ' + fullReply);

    try {
      const replyResult = await postReply(wallet, signer, agentFid, fullReply, w.hash, w.fid);
      console.log('  Posted tip reply: ' + replyResult.hash);
      txs[txs.length - 1].replyHash = replyResult.hash;
    } catch (err) {
      console.error('  Failed to post tip reply:', err.message);
    }
  }

  tipsState.tipped[promptState.lastHash] = {
    at: new Date().toISOString(),
    block: block.number,
    seed,
    seedHash,
    winners: winners.map(w => ({ fid: w.fid, username: w.username, address: w.address })),
    tipAmount: TIP_AMOUNT_USDC,
    txs
  };

  writeJson(TIP_STATE, tipsState);
  console.log('\nTipping complete!');

})().catch(err => {
  console.error(err);
  process.exit(1);
});
