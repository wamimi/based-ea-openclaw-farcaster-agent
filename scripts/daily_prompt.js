#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { postCast, loadCredentials } = require('../src');

const isDryRun = process.argv.includes('--dry-run');
const isForce = process.argv.includes('--force');

const STATE_DIR = path.join(__dirname, '..', '.state');
const STATE_FILE = path.join(STATE_DIR, 'daily_prompt.json');
const DISCOVERY_FILE = path.join(STATE_DIR, 'discovery.json');
const ENV_FILE = path.join(process.env.HOME, '.openclaw', 'secrets', 'prompt.env');

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

const QUIET_START = Number(process.env.QUIET_START || 22);
const QUIET_END = Number(process.env.QUIET_END || 6);
const QUIET_ENABLED = !["0","false","no","off"].includes(String(process.env.QUIET_ENABLED || "").toLowerCase());
const MIN_POSTS = Number(process.env.MIN_POSTS || 1);
const TARGET_POSTS = Number(process.env.TARGET_POSTS || 3);
const MAX_POSTS = Number(process.env.MAX_POSTS || 5);
const COOLDOWN_HOURS = Number(process.env.COOLDOWN_HOURS || 2);
const MUST_POST_BY = Number(process.env.MUST_POST_BY || 20);

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { recentPrompts: [], postsByDate: {} };
  }
}

function readDiscovery(dateKey) {
  try {
    const d = JSON.parse(fs.readFileSync(DISCOVERY_FILE, 'utf8'));
    if (d.date === dateKey) return d;
  } catch {}
  return null;
}

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function yesterdayKey(d) {
  const copy = new Date(d.getTime());
  copy.setDate(copy.getDate() - 1);
  return dateKey(copy);
}

function slotForHour(h) {
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 22) return 'evening';
  return 'night';
}

function isQuietHour(h) {
  if (!QUIET_ENABLED) return false;
  if (QUIET_START < QUIET_END) return h >= QUIET_START && h < QUIET_END;
  return h >= QUIET_START || h < QUIET_END;
}

function tokenize(s) {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
  );
}

function similarity(a, b) {
  const A = tokenize(a);
  const B = tokenize(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

function pick(list, seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return list[h % list.length];
}

async function generatePrompt({ slot, mood, energy, theme, surprise, streakDays, recentPrompts, discovery }) {
  const provider = (process.env.PROMPT_PROVIDER || '').toLowerCase();
  const useOpenRouter = provider === 'openrouter' || process.env.OPENROUTER_API_KEY;
  const useAnthropic = provider === 'anthropic' || process.env.ANTHROPIC_API_KEY;

  const system = [
    'You are Based East Africa Builds, a friendly, witty, community-first agent.',
    'Audience: builders and creators in Base East Africa.',
    'Tone: warm, natural, supportive, lightly playful. Not robotic.',
    '1-2 sentences. Max 240 characters.',
    'No list formatting. No hashtags.',
    'Invite replies with proof (link, demo, screenshot, cast, clip, repo).',
    'Mention builders AND creators in some way.',
    'Mention Base or Base East Africa naturally.',
    'Do not mention rules or winners.',
    'Only mention tipping as "if funds are available".',
    'Avoid emojis unless it truly fits; max one emoji.'
  ].join(' ');

  const slotLead =
    slot === 'morning' ? 'Start with "GM"' :
    slot === 'afternoon' ? 'Start with "BM"' :
    slot === 'evening' ? 'Start with "Evening" or "Evening wrap-up"' :
    'Start with "Late night" or "Night shift"';

  let user = [
    `Write a ${slot} check-in.`,
    `Mood: ${mood}. Energy: ${energy}/5.`,
    `Theme: ${theme}.`,
    surprise ? 'Make it a creative surprise, but still on mission.' : '',
    `Streak momentum: ${streakDays} day(s).`,
    slotLead
  ].join(' ');

  if (discovery?.sparks?.length) {
    user += ` Use these as subtle inspiration (do not quote): ${discovery.sparks.join(' | ')}.`;
  }

  if (!useOpenRouter && !useAnthropic) return null;

  async function callOpenRouter() {
    const model = process.env.PROMPT_MODEL || 'anthropic/claude-3.5-haiku';
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        temperature: 0.95,
        max_tokens: 140,
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
        temperature: 0.95,
        max_tokens: 140,
        system,
        messages: [{ role: 'user', content: user }]
      })
    });
    const json = await res.json();
    return json?.content?.[0]?.text?.trim();
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const text = useOpenRouter ? await callOpenRouter() : await callAnthropic();
    if (!text) continue;
    if (text.length > 240) continue;
    if (recentPrompts.some(p => similarity(p, text) > 0.7)) continue;
    return text;
  }

  return null;
}

(async () => {
  const now = new Date();
  const hour = now.getHours();
  const slot = slotForHour(hour);
  const today = dateKey(now);
  const yesterday = yesterdayKey(now);

  const state = readState();
  state.postsByDate = state.postsByDate || {};

  if (state.lastDateKey !== today) {
    state.streakDays = state.lastDateKey === yesterday ? (state.streakDays || 0) + 1 : 1;
    state.postsByDate[today] = 0;
    state.lastDateKey = today;

    const keep = new Set([today, yesterday]);
    for (const k of Object.keys(state.postsByDate)) {
      if (!keep.has(k)) delete state.postsByDate[k];
    }
  }

  const postsToday = state.postsByDate[today] || 0;
  const lastPostAt = state.lastPostAt ? new Date(state.lastPostAt) : null;
  const minutesSince = lastPostAt ? (now - lastPostAt) / 60000 : 1e9;

  if (!isForce) {
    if (isQuietHour(hour)) return console.log('Quiet hours - skipping');
    if (postsToday >= MAX_POSTS) return console.log('Max posts reached - skipping');
    if (minutesSince < COOLDOWN_HOURS * 60) return console.log('Cooldown active - skipping');
  }

  const baseProb = { morning: 0.25, afternoon: 0.32, evening: 0.30, night: 0.12 }[slot] || 0.2;
  let prob = baseProb;

  if (postsToday === 0 && hour >= 11) prob += 0.25;
  if (postsToday <= 1 && hour >= 16) prob += 0.20;
  if (postsToday < MIN_POSTS && hour >= MUST_POST_BY) prob = 1;
  if ((state.streakDays || 0) >= 3) prob += 0.05;
  prob = Math.min(prob, 0.9);

  if (!isForce && Math.random() > prob) return console.log('Decided not to post this hour');

  const moods = ['hype', 'focused', 'supportive', 'curious', 'playful', 'steady'];
  const energyLevels = [2, 3, 3, 4, 4, 5];
  const themes = [
    'build progress check',
    'creator content check',
    'streak count',
    'small wins',
    'before/after or demo',
    'collaboration invite',
    'problem or blocker',
    'Base app experiment',
    'ZK or privacy builders',
    'launch update',
    'ship something tiny'
  ];

  const seed = `${today}:${hour}`;
  const mood = pick(moods, seed);
  const energy = pick(energyLevels, seed);
  const theme = pick(themes, seed + ':theme');
  const surprise = state.lastSurpriseDate !== today && Math.random() < 0.22;

  const discovery = readDiscovery(today);

  const text = await generatePrompt({
    slot, mood, energy, theme, surprise,
    streakDays: state.streakDays || 1,
    recentPrompts: state.recentPrompts || [],
    discovery
  });

  if (isDryRun) return console.log(`[${slot}] ${text || '(no prompt generated)'}`);

  if (!text) throw new Error('Failed to generate prompt. Check API key and model.');

  const creds = loadCredentials();
  if (!creds || !creds.fid || !creds.signerPrivateKey || !creds.custodyPrivateKey) {
    throw new Error('Missing Farcaster credentials');
  }

  const result = await postCast({
    privateKey: creds.custodyPrivateKey,
    signerPrivateKey: creds.signerPrivateKey,
    fid: Number(creds.fid),
    text
  });

  state.lastPostAt = new Date().toISOString();
  state.postsByDate[today] = (state.postsByDate[today] || 0) + 1;
  state.recentPrompts = [text, ...(state.recentPrompts || [])].slice(0, 8);
  if (surprise) state.lastSurpriseDate = today;
  state.lastHash = result.hash;
  state.recentCasts = [
    { hash: result.hash, text, postedAt: new Date().toISOString() },
    ...(state.recentCasts || [])
  ].slice(0, 10);

  writeState(state);
  console.log('Cast hash:', result.hash);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
