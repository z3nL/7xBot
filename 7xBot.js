require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    PermissionFlagsBits,
    ChannelType,
} = require('discord.js');
const fs = require('fs');
const { HfInference } = require('@huggingface/inference');

const hf = new HfInference(process.env.HF_TOKEN);

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) throw new Error('DISCORD_TOKEN environment variable is not set.');

const CHANNEL_ID = process.env.WYD_CHANNEL_ID;
if (!CHANNEL_ID) throw new Error('WYD_CHANNEL_ID environment variable is not set or invalid.');

const CHANNEL_GENERAL = '1433550440649199879';
const SUMMARY_CHANNEL_ID = CHANNEL_GENERAL;
const SUMMARY_TRIGGER_COUNT = 30;
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
let summaryMessageCount = 0;
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

async function buildActivitySummary(messages) {
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

    const chatText = messages
        .map(msg => {
            const name = msg.member?.displayName ?? msg.author.username;
            return `${name}: ${msg.content}`;
        })
        .filter(line => line.trim().length > 3)
        .join(' ');

    let summaryLine = 'No summary available.';
    if (chatText.length > 20) {
        try {
            const result = await hf.summarization({
                model: 'facebook/bart-large-cnn',
                inputs: chatText.slice(0, 1024),
                parameters: { max_length: 60, min_length: 15 },
            });
            summaryLine = result.summary_text;
        } catch (err) {
            console.error('HuggingFace summarization failed:', err.message);
        }
    }

    return (
        `📝 **Chat Summary (last ${messages.length} messages)**\n` +
        `- Active people: ${peopleLine}\n` +
        `- Summary: ${summaryLine}`
    );
}

async function maybePostChannelSummary(message) {
    if (message.author.bot || message.channel.id !== SUMMARY_CHANNEL_ID) return;

    summaryMessageCount++;
    if (summaryMessageCount < SUMMARY_TRIGGER_COUNT) return;

    // Reset before async work to prevent double-triggering.
    summaryMessageCount = 0;

    const fetched = await message.channel.messages.fetch({ limit: 75 });
    const recentMessages = [];
    for (const msg of fetched.values()) {
        if (msg.author.bot) continue;
        recentMessages.push(msg);
        if (recentMessages.length === SUMMARY_TRIGGER_COUNT) break;
    }

    if (!recentMessages.length) return;

    const summaryText = await buildActivitySummary(recentMessages.reverse());
    await message.channel.send(summaryText);
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

    await maybePostChannelSummary(message);

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
    }
});

client.login(TOKEN);
