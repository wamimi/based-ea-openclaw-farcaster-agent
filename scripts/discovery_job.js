#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(process.env.HOME, '.openclaw', 'secrets', 'prompt.env');
const DISCOVERY_ENV = path.join(process.env.HOME, '.openclaw', 'secrets', 'discovery.env');
const STATE_DIR = path.join(__dirname, '..', '.state');
const DISCOVERY_JSON = path.join(STATE_DIR, 'discovery.json');
const DISCOVERY_MD = path.join(__dirname, '..', 'memory', 'DISCOVERY.md');

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

const BRAVE_KEY = process.env.BRAVE_API_KEY;
if (!BRAVE_KEY) {
  console.error('Missing BRAVE_API_KEY');
  process.exit(1);
}

function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function braveSearch(q) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=5&source=web`;
  const res = await fetch(url, {
    headers: { 'X-Subscription-Token': BRAVE_KEY }
  });
  if (!res.ok) throw new Error(`Brave error ${res.status}`);
  return res.json();
}

async function callLLM(system, user) {
  const provider = (process.env.PROMPT_PROVIDER || '').toLowerCase();
  const useOpenRouter = provider === 'openrouter' || process.env.OPENROUTER_API_KEY;
  const useAnthropic = provider === 'anthropic' || process.env.ANTHROPIC_API_KEY;

  if (!useOpenRouter && !useAnthropic) return null;

  if (useOpenRouter) {
    const model = process.env.PROMPT_MODEL || 'anthropic/claude-3.5-haiku';
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        temperature: 0.6,
        max_tokens: 200,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    });
    const json = await res.json();
    return json?.choices?.[0]?.message?.content?.trim();
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.PROMPT_MODEL || 'claude-3-5-haiku-20241022',
      temperature: 0.6,
      max_tokens: 200,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });
  const json = await res.json();
  return json?.content?.[0]?.text?.trim();
}

(async () => {
  const queries = [
    'Base chain news',
    'Base app update',
    'Farcaster Base creators',
    'Base East Africa builders'
  ];

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const items = [];
  for (const q of queries) {
    const data = await braveSearch(q);
    await sleep(1500);
    const results = data?.web?.results || [];
    for (const r of results.slice(0, 2)) {
      items.push({
        title: r.title,
        url: r.url,
        description: r.description || ''
      });
    }
  }

  const system = 'You generate short, practical inspiration sparks. Output JSON array only.';
  const user = `From these items, write 3 short "sparks" (no URLs, no hashtags), each under 140 chars:\n` +
    items.map((i, n) => `${n+1}. ${i.title} - ${i.description}`).join('\n');

  let sparks = [];
  const llm = await callLLM(system, user);
  try {
    sparks = JSON.parse(llm);
  } catch {
    sparks = items.slice(0, 3).map(i => i.title);
  }

  const today = dateKey(new Date());
  const out = { date: today, updatedAt: new Date().toISOString(), sparks, items };

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(DISCOVERY_JSON, JSON.stringify(out, null, 2));

  const md = [
    `# Discovery ${today}`,
    '',
    'Sparks:',
    ...sparks.map(s => `- ${s}`),
    '',
    'Sources:',
    ...items.map(i => `- ${i.title} (${i.url})`)
  ].join('\n');

  fs.mkdirSync(path.dirname(DISCOVERY_MD), { recursive: true });
  fs.writeFileSync(DISCOVERY_MD, md);

  console.log('Discovery updated');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
