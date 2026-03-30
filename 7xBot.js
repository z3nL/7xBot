require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    PermissionFlagsBits,
    ChannelType,
} = require('discord.js');
const fs = require('fs');

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) throw new Error('DISCORD_TOKEN environment variable is not set.');

const CHANNEL_ID = process.env.WYD_CHANNEL_ID;
if (!CHANNEL_ID) throw new Error('WYD_CHANNEL_ID environment variable is not set or invalid.');
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_SUMMARY_MODEL = process.env.GROQ_SUMMARY_MODEL || 'llama-3.1-8b-instant';

const STREAKS_FILE = 'photo_streaks.json';
const TIMEZONE = 'America/New_York';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
});

let photoSessionActive = false;
let submittedUsers = new Set();
let userStreaks = {};
let nextPingTime = null;
let isSendingPrompt = false;

// Returns a Date whose local fields reflect the current time in the Eastern timezone.
function getNowET() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
}

function getNextDailyPingTime(forceTomorrow = false) {
    const now = getNowET();
    const hour = Math.floor(Math.random() * 5) + 18; // 18–22
    const minute = Math.floor(Math.random() * 60);

    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);

    // On startup, allow today if still upcoming. After a sent prompt, always use tomorrow.
    if (forceTomorrow || target <= now) {
        target.setDate(target.getDate() + 1);
    }

    return target;
}

function formatEtDate(date) {
    return date.toLocaleString('en-US', {
        timeZone: TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
    });
}

function loadStreaks() {
    if (!fs.existsSync(STREAKS_FILE)) return {};
    try {
        const raw = JSON.parse(fs.readFileSync(STREAKS_FILE, 'utf-8'));
        if (typeof raw !== 'object' || Array.isArray(raw)) return {};
        const parsed = {};
        for (const [key, value] of Object.entries(raw)) {
            const streakValue = parseInt(value, 10);
            if (!isNaN(streakValue)) {
                parsed[key] = Math.max(0, streakValue);
            }
        }
        return parsed;
    } catch {
        return {};
    }
}

function saveStreaks(streaks) {
    const serializable = {};
    for (const [uid, value] of Object.entries(streaks)) {
        serializable[uid] = parseInt(value, 10);
    }
    fs.writeFileSync(STREAKS_FILE, JSON.stringify(serializable, null, 2));
}

function buildSummaryInput(messages) {
    return messages
        .map(msg => {
            const name = msg.member?.displayName ?? msg.author.username;
            const content = (msg.content ?? '').trim();
            return `${name}: ${content}`;
        })
        .filter(line => line.trim().length > 3)
        .join('\n')
        .slice(0, 6000);
}

async function summarizeWithGroq(messages) {
    if (!GROQ_API_KEY) {
        return 'Groq summarizer is not configured. Set GROQ_API_KEY in your .env file.';
    }

    if (typeof fetch !== 'function') {
        return 'Groq summarizer requires Node.js 18+ (global fetch is unavailable).';
    }

    const chatText = buildSummaryInput(messages);
    if (!chatText) {
        return 'No meaningful text was found in the recent messages to summarize.';
    }

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: GROQ_SUMMARY_MODEL,
                temperature: 0.2,
                max_tokens: 120,
                messages: [
                    {
                        role: 'system',
                        content: 'You summarize group chats. Return exactly 1-2 concise sentences and keep slang/context intact.'
                    },
                    {
                        role: 'user',
                        content: `Summarize this Discord chat:\n\n${chatText}`,
                    },
                ],
            }),
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const apiError = data?.error?.message || `HTTP ${response.status}`;
            return `Groq summarization failed: ${apiError}`;
        }

        const summary = data?.choices?.[0]?.message?.content?.trim();
        if (!summary) return 'Groq summarization returned an empty response.';

        return summary;
    } catch (err) {
        return `Groq summarization failed: ${err.message}`;
    }
}

async function buildActivitySummary(messages, scopeLabel) {
    const authorCounts = {};
    for (const msg of messages) {
        const name = msg.member?.displayName ?? msg.author.username;
        authorCounts[name] = (authorCounts[name] ?? 0) + 1;
    }

    const topPeople = Object.entries(authorCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, count]) => `${name} (${count})`);

    const peopleLine = topPeople.join(', ') || 'No clear leaders';

    const summaryLine = await summarizeWithGroq(messages);

    return (
        `📝 **Chat Summary (${scopeLabel})**\n` +
        `- Active people: ${peopleLine}\n` +
        `- Summary: ${summaryLine}`
    );
}

async function fetchRecentUserMessagesByCount(channel, count) {
    const target = Math.max(1, count);
    const out = [];
    let before;

    while (out.length < target) {
        const remaining = target - out.length;
        const batchSize = Math.min(100, Math.max(remaining * 2, 25));
        const fetched = await channel.messages.fetch({ limit: batchSize, before });
        if (!fetched.size) break;

        for (const msg of fetched.values()) {
            if (msg.author.bot) continue;
            out.push(msg);
            if (out.length === target) break;
        }

        before = fetched.last()?.id;
        if (!before) break;
    }

    return out.reverse();
}

async function fetchRecentUserMessagesSince(channel, sinceDate) {
    const out = [];
    let before;

    while (true) {
        const fetched = await channel.messages.fetch({ limit: 100, before });
        if (!fetched.size) break;

        let reachedOlderThanWindow = false;
        for (const msg of fetched.values()) {
            if (msg.createdAt < sinceDate) {
                reachedOlderThanWindow = true;
                continue;
            }
            if (!msg.author.bot) out.push(msg);
        }

        if (reachedOlderThanWindow) break;

        before = fetched.last()?.id;
        if (!before) break;
    }

    return out.reverse();
}

function parseSummaryWindow(args) {
    if (!args.length) {
        return {
            ok: true,
            mode: 'count',
            count: 30,
            scopeLabel: 'last 30 messages',
        };
    }

    const [firstRaw, secondRaw] = args;
    const first = firstRaw.toLowerCase();
    const second = (secondRaw ?? '').toLowerCase();

    if (['30', '60', '120'].includes(first) && args.length === 1) {
        const count = parseInt(first, 10);
        return {
            ok: true,
            mode: 'count',
            count,
            scopeLabel: `last ${count} messages`,
        };
    }

    let amount;
    let unit;

    const compact = first.match(/^(\d+)\s*([a-z]+)$/i);
    if (compact && args.length === 1) {
        amount = parseInt(compact[1], 10);
        unit = compact[2].toLowerCase();
    } else if (/^\d+$/.test(first) && args.length >= 2) {
        amount = parseInt(first, 10);
        unit = second;
    }

    if (!amount || amount <= 0 || !unit) {
        return {
            ok: false,
            error: 'Usage: `!summary 30|60|120` or `!summary <number> <m|min|h|hr|d|day>` (example: `!summary 25 m`, `!summary 2 hr`).',
        };
    }

    let multiplierMs;
    if (['m', 'min', 'mins', 'minute', 'minutes'].includes(unit)) {
        multiplierMs = 60_000;
    } else if (['h', 'hr', 'hrs', 'hour', 'hours'].includes(unit)) {
        multiplierMs = 3_600_000;
    } else if (['d', 'day', 'days'].includes(unit)) {
        multiplierMs = 86_400_000;
    } else {
        return {
            ok: false,
            error: 'Unknown time unit. Use minutes (`m`), hours (`hr`), or days (`d`).',
        };
    }

    const since = new Date(Date.now() - amount * multiplierMs);
    const unitLabel = unit;
    return {
        ok: true,
        mode: 'time',
        since,
        scopeLabel: `since ${amount} ${unitLabel} ago`,
    };
}

async function sendPhotoPrompt() {
    const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) {
        console.log('Channel not found or not a text channel.');
        return false;
    }
    const guild = channel.guild;

    if (photoSessionActive) {
        await guild.members.fetch();
        const currentMemberIds = guild.members.cache
            .filter(m => !m.user.bot)
            .map(m => m.id);

        const newStreaks = {};
        for (const uid of currentMemberIds) {
            // Streaks are awarded immediately on upload; only reset misses at cycle boundary.
            if (!submittedUsers.has(uid)) {
                newStreaks[uid] = 0;
            } else {
                newStreaks[uid] = userStreaks[uid] ?? 0;
            }
        }
        userStreaks = newStreaks;
        saveStreaks(userStreaks);
    }

    photoSessionActive = true;
    submittedUsers = new Set();

    await channel.send('@everyone 📸 WYD RN SEND A PHOTOOOOO');
    return true;
}

client.once('ready', () => {
    userStreaks = loadStreaks();
    console.log(`Loaded ${Object.keys(userStreaks).length} streak records.`);
    console.log(`Logged in as ${client.user.tag}`);

    nextPingTime = getNextDailyPingTime();
    console.log(`First ping scheduled for (ET): ${formatEtDate(nextPingTime)}`);

    setInterval(async () => {
        const now = getNowET();
        if (isSendingPrompt) return;
        if (now >= nextPingTime) {
            isSendingPrompt = true;
            try {
                const sent = await sendPhotoPrompt();
                if (sent) {
                    nextPingTime = getNextDailyPingTime(true);
                    console.log(`Next ping scheduled for (ET): ${formatEtDate(nextPingTime)}`);
                } else {
                    // Keep cadence daily-only. If a send fails, do not create extra cycles.
                    nextPingTime = getNextDailyPingTime(true);
                    console.log(`Prompt send failed; next daily ping remains (ET): ${formatEtDate(nextPingTime)}`);
                }
            } catch (err) {
                console.error('Failed to send photo prompt:', err);
                nextPingTime = getNextDailyPingTime(true);
                console.log(`Send errored; next daily ping remains (ET): ${formatEtDate(nextPingTime)}`);
            } finally {
                isSendingPrompt = false;
            }
        }
    }, 60_000);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (photoSessionActive && message.channel.id === CHANNEL_ID && message.attachments.size > 0) {
        const validExts = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'mp4', 'mov']);
        const hasMedia = message.attachments.some(att => {
            const fileName = att.filename?.toLowerCase() ?? '';
            const ext = fileName.includes('.') ? fileName.split('.').pop() : '';
            const contentType = (att.contentType ?? '').toLowerCase();
            return validExts.has(ext) || contentType.startsWith('image/') || contentType.startsWith('video/');
        });

        if (hasMedia && !submittedUsers.has(message.author.id)) {
            submittedUsers.add(message.author.id);
            userStreaks[message.author.id] = (userStreaks[message.author.id] ?? 0) + 1;
            saveStreaks(userStreaks);
            await message.react('✅');
            await message.channel.send(
                `Nice <@${message.author.id}>. Your streak is now **${userStreaks[message.author.id]}**.`
            );
        }
    }

    // Command handling
    const PREFIX = '!';
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const command = args.shift().toLowerCase();

    if (command === 'forceprompt') {
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return;
        await sendPhotoPrompt();

    } else if (command === 'nextping') {
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return;
        if (!nextPingTime) {
            await message.channel.send('No ping is currently scheduled.');
            return;
        }
        await message.channel.send(`Next prompt is scheduled for **${formatEtDate(nextPingTime)} ET**.`);

    } else if (command === 'pending') {
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return;

        if (!photoSessionActive) {
            await message.channel.send('No active photo cycle right now.');
            return;
        }

        const channel = client.channels.cache.get(CHANNEL_ID);
        if (!channel || channel.type !== ChannelType.GuildText) {
            await message.channel.send('Photo channel is unavailable.');
            return;
        }

        await channel.guild.members.fetch();
        const memberIds = channel.guild.members.cache
            .filter(m => !m.user.bot)
            .map(m => m.id);

        const missingIds = memberIds.filter(id => !submittedUsers.has(id)).sort();

        if (missingIds.length) {
            const mentions = missingIds.map(id => `<@${id}>`).join(' ');
            await message.channel.send(`Still waiting on: ${mentions}`);
        } else {
            await message.channel.send('Everyone has submitted for this cycle.');
        }

    } else if (command === 'streak') {
        let target = message.member;

        if (args.length > 0) {
            const id = args[0].replace(/[<@!>]/g, '');
            const found = message.guild.members.cache.get(id);
            if (found) target = found;
        }

        const current = userStreaks[target.id] ?? 0;

        await message.channel.send(`🔥 ${target.displayName}'s current streak: **${current}**`);

    } else if (command === 'summary') {
        const parsed = parseSummaryWindow(args);
        if (!parsed.ok) {
            await message.channel.send(parsed.error);
            return;
        }

        let messagesToSummarize = [];
        if (parsed.mode === 'count') {
            messagesToSummarize = await fetchRecentUserMessagesByCount(message.channel, parsed.count);
        } else {
            messagesToSummarize = await fetchRecentUserMessagesSince(message.channel, parsed.since);
        }

        if (!messagesToSummarize.length) {
            await message.channel.send('none');
            return;
        }

        const summaryText = await buildActivitySummary(messagesToSummarize, parsed.scopeLabel);
        await message.channel.send(summaryText);
    }
});

client.login(TOKEN);
