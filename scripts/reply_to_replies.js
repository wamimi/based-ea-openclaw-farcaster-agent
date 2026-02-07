#!/usr/bin/env node
'use strict';

/**
 * reply_to_replies.js — Smart reply bot for Based East Africa Builds.
 *
 * Features:
 *   - Checks replies on ALL recent posts (not just the latest)
 *   - Follows conversation threads (reply_depth=2) — keeps convos going
 *   - Researches builder projects via Brave Search before replying
 *   - 4 LLM prompt paths: casual, builder+research, builder, thread continuation
 *   - Tiered checking frequency to manage x402 costs
 *
 * Uses x402 payment flow (0.001 USDC per API call).
 *
 * Run from the farcaster-agent directory:
 *   cd ~/.openclaw/workspace/farcaster-agent
 *   node scripts/reply_to_replies.js
 *   node scripts/reply_to_replies.js --dry-run
 */

const fs = require('fs');
const path = require('path');
const { Wallet, JsonRpcProvider } = require('ethers');
const {
  makeCastAdd,
  NobleEd25519Signer,
  FarcasterNetwork,
  Message
} = require('@farcaster/hub-nodejs');

const { loadCredentials } = require('../src/credentials');
const { RPC, NEYNAR } = require('../src/config');
const { x402Request, submitMessage } = require('../src/x402');

const isDryRun = process.argv.includes('--dry-run');

const STATE_DIR = path.join(__dirname, '..', '.state');
const REPLY_STATE = path.join(STATE_DIR, 'replies.json');
const ENV_FILE = path.join(process.env.HOME, '.openclaw', 'secrets', 'prompt.env');
const DISCOVERY_ENV = path.join(process.env.HOME, '.openclaw', 'secrets', 'discovery.env');

const MAX_REPLIES_PER_RUN = Number(process.env.MAX_REPLIES_PER_RUN || 5);
const MAX_CASTS_TO_CHECK = Number(process.env.MAX_CASTS_TO_CHECK || 5);
const MAX_CAST_AGE_HOURS = Number(process.env.MAX_CAST_AGE_HOURS || 72);
const MAX_SEARCHES_PER_RUN = Number(process.env.MAX_SEARCHES_PER_RUN || 2);
const MAX_THREAD_DEPTH = Number(process.env.MAX_THREAD_DEPTH || 3);

/* ── env loader ─────────────────────────────────────────────── */

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
loadEnvFile(DISCOVERY_ENV);

/* ── helpers ────────────────────────────────────────────────── */

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── Fetch agent's recent casts via x402 ────────────────────── */

async function fetchAgentCasts(wallet, fid) {
  const result = await x402Request(wallet, {
    hostname: NEYNAR.API,
    path: `/v2/farcaster/feed/user/casts?fid=${fid}&limit=10&include_replies=false`,
    method: 'GET'
  });

  if (result.status !== 200) {
    console.error('Failed to fetch agent casts:', result.status);
    return [];
  }

  const casts = result.data?.casts || [];
  const cutoff = Date.now() - MAX_CAST_AGE_HOURS * 3600000;
  return casts
    .filter(c => new Date(c.timestamp).getTime() > cutoff)
    .slice(0, MAX_CASTS_TO_CHECK)
    .map(c => ({ hash: c.hash, text: c.text || '' }));
}

/* ── Fetch conversation via x402 (depth=2 for threading) ───── */

async function fetchConversation(wallet, castHash) {
  const result = await x402Request(wallet, {
    hostname: NEYNAR.API,
    path: `/v2/farcaster/cast/conversation?identifier=${castHash}&type=hash&reply_depth=2&include_chronological_parent_casts=false`,
    method: 'GET'
  });

  if (result.status !== 200) {
    console.error('  Failed to fetch conversation:', result.status);
    return null;
  }

  return result.data;
}

/* ── Extract threaded replies (sub-replies to agent's replies) */

function extractThreadedReplies(convo, agentFid, replyState) {
  const results = [];
  const rootCast = convo?.conversation?.cast;
  if (!rootCast) return results;
  const originalText = rootCast.text || '';

  function visit(cast, depth) {
    const replies = cast.direct_replies || [];
    for (const reply of replies) {
      if (reply.author?.fid === agentFid) {
        // This is the agent's reply — check its sub-replies
        const subReplies = reply.direct_replies || [];
        for (const sub of subReplies) {
          if (sub.author?.fid === agentFid) continue;
          if (replyState.replied[sub.hash]) continue;
          if (depth + 1 > MAX_THREAD_DEPTH) continue;
          results.push({
            hash: sub.hash,
            text: sub.text || '',
            author: sub.author,
            _originalPost: originalText,
            _isThread: true,
            _agentPreviousReply: reply.text || '',
            _threadDepth: depth + 1
          });
        }
      }
      visit(reply, depth + 1);
    }
  }

  visit(rootCast, 0);
  return results;
}

/* ── Post a reply via x402 ──────────────────────────────────── */

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
    throw new Error('Failed to create reply CastAdd: ' + castResult.error);
  }

  const cast = castResult.value;
  const hash = '0x' + Buffer.from(cast.hash).toString('hex');
  const messageBytes = Buffer.from(Message.encode(cast).finish());

  console.log('  Reply hash: ' + hash + ' (' + messageBytes.length + ' bytes)');

  const submitResult = await submitMessage(wallet, messageBytes);

  if (submitResult.status !== 200) {
    throw new Error('Submit failed (' + submitResult.status + '): ' + JSON.stringify(submitResult.data));
  }

  return { hash };
}

/* ── Web research via Brave Search ──────────────────────────── */

function shouldResearch(replyText) {
  const indicators = [
    /\b(built|shipped|launched|deployed|released|created|made|developing|working on|building)\b/i,
    /\b(app|dapp|tool|project|product|contract|protocol|bot|site|platform|marketplace|wallet|game|nft|miniapp|mini-app)\b/i,
    /\bhttps?:\/\//i,
    /\b(github\.com|vercel\.app|netlify\.app|\.xyz|\.io|baseapp)\b/i,
    /\b(check it out|take a look|feedback|what do you think|here it is|link here)\b/i
  ];
  const matchCount = indicators.filter(p => p.test(replyText)).length;
  return matchCount >= 2;
}

async function braveSearch(q) {
  const url = 'https://api.search.brave.com/res/v1/web/search?q=' +
    encodeURIComponent(q) + '&count=3&source=web';
  const res = await fetch(url, {
    headers: { 'X-Subscription-Token': process.env.BRAVE_API_KEY }
  });
  if (!res.ok) throw new Error('Brave error ' + res.status);
  return res.json();
}

async function researchProject(replyText, replyAuthor) {
  if (!process.env.BRAVE_API_KEY) return null;

  const urlMatch = replyText.match(/https?:\/\/[^\s)]+/);
  let query;
  if (urlMatch) {
    try {
      const url = new URL(urlMatch[0]);
      query = (url.hostname + ' ' + url.pathname.replace(/\//g, ' ')).trim();
    } catch {
      query = replyAuthor + ' ' + replyText.slice(0, 80) + ' Base';
    }
  } else {
    query = replyAuthor + ' ' + replyText.slice(0, 80) + ' Base blockchain';
  }

  await sleep(1500);
  try {
    const data = await braveSearch(query);
    const results = (data?.web?.results || []).slice(0, 3);
    if (!results.length) return null;
    return results.map(r => r.title + ': ' + (r.description || '')).join('\n').slice(0, 500);
  } catch (err) {
    console.error('  Web search failed:', err.message);
    return null;
  }
}

/* ── LLM reply generation (4 prompt paths) ──────────────────── */

async function generateReply({ originalPost, replyText, replyAuthor, researchSummary, isThread, agentPreviousReply }) {
  const provider = (process.env.PROMPT_PROVIDER || '').toLowerCase();
  const useOpenRouter = provider === 'openrouter' || process.env.OPENROUTER_API_KEY;
  const useAnthropic = provider === 'anthropic' || process.env.ANTHROPIC_API_KEY;

  if (!useOpenRouter && !useAnthropic) {
    throw new Error('No LLM provider configured (need OPENROUTER_API_KEY or ANTHROPIC_API_KEY)');
  }

  let system, user, maxChars;

  if (isThread) {
    system = [
      'You are Based East Africa Builds, a community agent on Farcaster.',
      'You are continuing a conversation. Someone replied to YOUR previous reply.',
      'Continue the conversation naturally. Be conversational, not repetitive.',
      'Ask a follow-up question or celebrate specifics they mentioned.',
      'Keep it brief (1-2 sentences, max 200 chars). No hashtags. Max one emoji.'
    ].join(' ');
    user = [
      'Original post context: "' + originalPost + '"',
      'Your previous reply: "' + agentPreviousReply + '"',
      'Their response to you (@' + replyAuthor + '): "' + replyText + '"',
      'Continue the conversation naturally.'
    ].join('\n');
    maxChars = 200;
  } else if (researchSummary) {
    system = [
      'You are Based East Africa Builds, a knowledgeable community agent on Farcaster.',
      'A builder shared their project. You have web research about it below.',
      'Give SPECIFIC feedback referencing what you learned. Mention one concrete detail from the research.',
      'Be encouraging but substantive (1-2 sentences, max 320 chars).',
      'No hashtags. Max one emoji.'
    ].join(' ');
    user = [
      'Your original post: "' + originalPost + '"',
      'Reply from @' + replyAuthor + ': "' + replyText + '"',
      'Web research about their project:\n' + researchSummary,
      'Write a specific, informed reply acknowledging what they built.'
    ].join('\n');
    maxChars = 320;
  } else if (shouldResearch(replyText)) {
    system = [
      'You are Based East Africa Builds, a supportive community agent on Farcaster.',
      'A builder shared progress on their project.',
      'Acknowledge specifically what they described. Ask a thoughtful follow-up question about their build.',
      'Be encouraging and curious (1-2 sentences, max 200 chars).',
      'No hashtags. Max one emoji.'
    ].join(' ');
    user = [
      'Your original post: "' + originalPost + '"',
      'Reply from @' + replyAuthor + ': "' + replyText + '"',
      'Write a specific, encouraging reply with a follow-up question.'
    ].join('\n');
    maxChars = 200;
  } else {
    system = [
      'You are Based East Africa Builds, a warm community agent on Farcaster.',
      'Someone replied casually to your build-streak post.',
      'Keep it brief (1 sentence, max 140 chars). Be warm, human.',
      'If they said gm, respond warmly. If brief, invite them to share what they are building.',
      'No hashtags. Max one emoji.'
    ].join(' ');
    user = [
      'Your original post: "' + originalPost + '"',
      'Reply from @' + replyAuthor + ': "' + replyText + '"',
      'Write a short, warm reply.'
    ].join('\n');
    maxChars = 140;
  }

  async function callOpenRouter() {
    const model = process.env.PROMPT_MODEL || 'anthropic/claude-3.5-haiku';
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        temperature: 0.85,
        max_tokens: 160,
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
        model,
        temperature: 0.85,
        max_tokens: 160,
        system,
        messages: [{ role: 'user', content: user }]
      })
    });
    const json = await res.json();
    return json?.content?.[0]?.text?.trim();
  }

  function cleanText(t) {
    if (!t) return t;
    // Strip surrounding quotes the LLM sometimes adds
    t = t.replace(/^["'"]+|["'"]+$/g, '').trim();
    return t;
  }

  function truncateAtWord(t, max) {
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    let text = useOpenRouter ? await callOpenRouter() : await callAnthropic();
    text = cleanText(text);
    if (text && text.length <= maxChars) return text;
    if (text && text.length > maxChars && text.length <= 320) return truncateAtWord(text, maxChars);
  }

  return null;
}

/* ── main ───────────────────────────────────────────────────── */

(async () => {
  const creds = loadCredentials();
  if (!creds || !creds.fid || !creds.signerPrivateKey || !creds.custodyPrivateKey) {
    throw new Error('Missing Farcaster credentials');
  }

  const agentFid = Number(creds.fid);
  const baseProvider = new JsonRpcProvider(RPC.BASE);
  const wallet = new Wallet(creds.custodyPrivateKey, baseProvider);

  const signerKey = creds.signerPrivateKey.startsWith('0x')
    ? creds.signerPrivateKey.slice(2)
    : creds.signerPrivateKey;
  const signer = new NobleEd25519Signer(Buffer.from(signerKey, 'hex'));

  // Fetch agent's recent casts directly from Neynar (fully autonomous)
  console.log('Fetching agent casts for FID ' + agentFid + '...');
  const castsToCheck = await fetchAgentCasts(wallet, agentFid);

  if (!castsToCheck.length) {
    console.log('No recent casts found (within ' + MAX_CAST_AGE_HOURS + 'h)');
    return;
  }

  // Load reply state
  const replyState = readJson(REPLY_STATE, { replied: {}, runCount: 0 });
  replyState.runCount = (replyState.runCount || 0) + 1;
  const runCount = replyState.runCount;

  // Tiered frequency: check all on first run, then latest every run,
  // 2nd every other, 3rd+ every 4th
  const castsThisRun = castsToCheck.filter((_, idx) => {
    if (runCount <= 1) return true;  // First run: check everything
    if (idx === 0) return true;
    if (idx === 1) return runCount % 2 === 0;
    return runCount % 4 === 0;
  });

  console.log('Run #' + runCount + ' — checking ' + castsThisRun.length + ' of ' + castsToCheck.length + ' recent casts');

  // Collect all new replies across all casts
  const allNewReplies = [];
  let readsCount = 0;

  for (const cast of castsThisRun) {
    console.log('\nFetching replies to: ' + cast.hash);
    const convo = await fetchConversation(wallet, cast.hash);
    readsCount++;

    if (!convo) continue;

    const originalText = convo?.conversation?.cast?.text || cast.text || '';
    const directReplies = convo?.conversation?.cast?.direct_replies || [];

    // Direct replies (depth 1)
    for (const r of directReplies) {
      if (r.author?.fid === agentFid) continue;
      if (replyState.replied[r.hash]) continue;
      allNewReplies.push({
        hash: r.hash,
        text: r.text || '',
        author: r.author,
        _originalPost: originalText,
        _isThread: false,
        _agentPreviousReply: null,
        _threadDepth: 0
      });
    }

    // Threaded replies (depth 2 — replies to agent's replies)
    const threadedReplies = extractThreadedReplies(convo, agentFid, replyState);
    allNewReplies.push(...threadedReplies);

    if (directReplies.length) {
      console.log('  ' + directReplies.length + ' direct replies, ' + threadedReplies.length + ' threaded');
    }
  }

  if (!allNewReplies.length) {
    console.log('\nNo new replies to respond to');
    if (!isDryRun) writeJson(REPLY_STATE, replyState);
    return;
  }

  console.log('\n' + allNewReplies.length + ' new replies to process (max ' + MAX_REPLIES_PER_RUN + ' per run)');

  let repliedCount = 0;
  let searchesThisRun = 0;

  for (const reply of allNewReplies.slice(0, MAX_REPLIES_PER_RUN)) {
    const replyText = reply.text;
    const replyAuthor = reply.author?.username || reply.author?.display_name || 'fid:' + reply.author?.fid;
    const replyHash = reply.hash;
    const replyFid = reply.author?.fid;
    const isThread = reply._isThread;

    const label = isThread ? '[THREAD]' : (shouldResearch(replyText) ? '[BUILDER]' : '[CASUAL]');
    console.log('\n' + label + ' @' + replyAuthor + ': "' + replyText.slice(0, 80) + (replyText.length > 80 ? '...' : '') + '"');

    // Web research for builder replies
    let researchSummary = null;
    if (!isThread && shouldResearch(replyText) && searchesThisRun < MAX_SEARCHES_PER_RUN) {
      console.log('  Researching project...');
      researchSummary = await researchProject(replyText, replyAuthor);
      searchesThisRun++;
      if (researchSummary) {
        console.log('  Found research: ' + researchSummary.slice(0, 100) + '...');
      } else {
        console.log('  No research results found');
      }
    }

    // Generate reply via LLM
    const responseText = await generateReply({
      originalPost: reply._originalPost,
      replyText,
      replyAuthor,
      researchSummary,
      isThread,
      agentPreviousReply: reply._agentPreviousReply
    });

    if (!responseText) {
      console.log('  Could not generate reply, skipping');
      continue;
    }

    console.log('  Generated: "' + responseText + '"');

    let ourReplyHash = null;
    if (isDryRun) {
      console.log('  [DRY RUN] Would post reply');
    } else {
      try {
        const result = await postReply(
          wallet, signer, agentFid,
          responseText,
          replyHash,
          replyFid
        );
        console.log('  Posted! Hash: ' + result.hash);
        ourReplyHash = result.hash;
      } catch (err) {
        console.error('  Failed to post reply:', err.message);
        continue;
      }
    }

    // Track that we responded (only if not dry run)
    if (!isDryRun) {
      replyState.replied[replyHash] = {
        at: new Date().toISOString(),
        author: replyAuthor,
        response: responseText,
        ourReplyHash,
        isThread,
        researched: !!researchSummary
      };
    }
    repliedCount++;
  }

  // Save state
  if (!isDryRun) {
    writeJson(REPLY_STATE, replyState);
  }

  console.log('\nDone. Replied to ' + repliedCount + ' new replies.');
  console.log('Cost: ~' + ((readsCount + repliedCount) * 0.001).toFixed(3) + ' USDC (' + readsCount + ' reads + ' + repliedCount + ' posts)');
  if (searchesThisRun) console.log('Brave searches: ' + searchesThisRun);

})().catch(err => {
  console.error(err);
  process.exit(1);
});
