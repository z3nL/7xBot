from dotenv import load_dotenv
import os
import asyncio
import json
import discord
from discord.ext import commands, tasks
import random
from datetime import datetime, timedelta
from collections import Counter
import re
import pytz

load_dotenv()

TOKEN = os.getenv("DISCORD_TOKEN")
if TOKEN is None:
    raise ValueError("DISCORD_TOKEN environment variable is not set.")

CHANNEL_ID = int(os.getenv("WYD_CHANNEL_ID") or 0)
if CHANNEL_ID == 0:
    raise ValueError("WYD_CHANNEL_ID environment variable is not set or invalid.")

SUMMARY_CHANNEL_ID = 1433550440649199879
SUMMARY_TRIGGER_COUNT = 25

TIMEZONE = pytz.timezone('America/New_York')

intents = discord.Intents.default()
intents.message_content = True
intents.members = True

bot = commands.Bot(command_prefix='!', intents=intents)

photo_session_active = False
submitted_users = set()
user_streaks = {}
STREAKS_FILE = "photo_streaks.json"
summary_message_count = 0
summary_lock = asyncio.Lock()

STOPWORDS = {
    "the", "and", "for", "that", "this", "with", "you", "your", "are", "but", "not", "have",
    "was", "were", "they", "their", "from", "just", "about", "what", "when", "where", "how",
    "why", "can", "cant", "could", "would", "should", "will", "im", "its", "dont", "did", "didnt",
    "got", "get", "like", "lol", "lmao", "bro", "nah", "yes", "no", "too", "very", "then",
    "there", "here", "into", "out", "our", "yall", "rn", "wyd", "send", "photo", "photos", "a",
    "an", "to", "of", "in", "on", "at", "is", "it", "be", "as", "or", "if", "we", "i", "u",
    "me", "my", "so", "up", "do", "does", "did", "had", "has"
}


def get_random_ping_time():
    now = datetime.now(TIMEZONE)
    target = now.replace(
        hour=random.randint(18, 22),
        minute=random.randint(0, 59),
        second=0,
        microsecond=0
    )
    # If hour is 22, cap minutes to keep it before 23:00
    if target.hour == 22:
        target = target.replace(minute=random.randint(0, 59))
    # If the time has already passed today, schedule for tomorrow
    if target <= now:
        target += timedelta(days=1)
    return target


def load_streaks():
    if not os.path.exists(STREAKS_FILE):
        return {}

    try:
        with open(STREAKS_FILE, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}

    if not isinstance(raw, dict):
        return {}

    parsed = {}
    for key, value in raw.items():
        try:
            uid = int(key)
            streak_value = int(value)
        except (TypeError, ValueError):
            continue

        parsed[uid] = max(0, streak_value)

    return parsed


def save_streaks(streaks):
    serializable = {str(uid): int(value) for uid, value in streaks.items()}
    with open(STREAKS_FILE, "w", encoding="utf-8") as f:
        json.dump(serializable, f, indent=2, sort_keys=True)


def build_activity_summary(messages):
    authors = Counter(msg.author.display_name for msg in messages)

    words = []
    for msg in messages:
        cleaned = re.findall(r"[A-Za-z']{3,}", msg.content.lower())
        words.extend([word for word in cleaned if word not in STOPWORDS])

    top_people = authors.most_common(3)
    top_words = Counter(words).most_common(5)
    media_count = sum(len(msg.attachments) for msg in messages)

    people_line = ", ".join([f"{name} ({count})" for name, count in top_people]) or "No clear leaders"
    words_line = ", ".join([word for word, _ in top_words]) or "No strong keywords"

    return (
        "📝 **Chat Summary (last 20 messages)**\n"
        f"- Active people: {people_line}\n"
        f"- Main topics/keywords: {words_line}\n"
        f"- Media shared: {media_count} file(s)"
    )


async def maybe_post_channel_summary(message):
    global summary_message_count

    if message.author.bot or message.channel.id != SUMMARY_CHANNEL_ID:
        return

    summary_message_count += 1
    if summary_message_count < SUMMARY_TRIGGER_COUNT:
        return

    async with summary_lock:
        if summary_message_count < SUMMARY_TRIGGER_COUNT:
            return

        recent_messages = []
        async for msg in message.channel.history(limit=75):
            if msg.author.bot:
                continue
            recent_messages.append(msg)
            if len(recent_messages) == SUMMARY_TRIGGER_COUNT:
                break

        if not recent_messages:
            summary_message_count = 0
            return

        summary_text = build_activity_summary(list(reversed(recent_messages)))
        await message.channel.send(summary_text)
        summary_message_count = 0


async def send_photo_prompt():
    global photo_session_active, submitted_users, user_streaks

    channel = bot.get_channel(CHANNEL_ID)
    if channel is None:
        print("Channel not found.")
        return
    if not isinstance(channel, discord.TextChannel):
        print("Channel is not a text channel.")
        return
    guild = channel.guild

    # Close the previous cycle before opening a new one.
    if photo_session_active:
        current_member_ids = {member.id for member in guild.members if not member.bot}

        # Keep streak records only for current non-bot members.
        user_streaks = {uid: user_streaks.get(uid, 0) for uid in current_member_ids}

        for uid in current_member_ids:
            if uid in submitted_users:
                user_streaks[uid] = user_streaks.get(uid, 0) + 1
            else:
                user_streaks[uid] = 0

        save_streaks(user_streaks)

    photo_session_active = True
    submitted_users = set()

    await channel.send(
        f"@everyone 📸 WYD RN SEND A PHOTOOOOO"
    )


@bot.event
async def on_ready():
    global user_streaks

    user_streaks = load_streaks()
    print(f"Loaded {len(user_streaks)} streak records.")
    print(f'Logged in as {bot.user}')
    scheduler.start()


@bot.event
async def on_message(message):
    global submitted_users

    if message.author.bot:
        return

    if photo_session_active and message.channel.id == CHANNEL_ID and message.attachments:
        valid_exts = {'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'mp4', 'mov'}
        has_media = any(
            attachment.filename.lower().rsplit('.', 1)[-1] in valid_exts
            for attachment in message.attachments
            if '.' in attachment.filename
        )

        if has_media and message.author.id not in submitted_users:
            submitted_users.add(message.author.id)
            preview_streak = user_streaks.get(message.author.id, 0) + 1
            await message.add_reaction('✅')
            await message.channel.send(
                f"Nice <@{message.author.id}>. If you keep this up, your streak will be **{preview_streak}** after the next prompt."
            )

    await maybe_post_channel_summary(message)

    await bot.process_commands(message)


@tasks.loop(minutes=1)
async def scheduler():
    global next_ping_time

    now = datetime.now(TIMEZONE)

    if now >= next_ping_time:
        await send_photo_prompt()
        next_ping_time = get_random_ping_time()
        print(f"Next ping scheduled for: {next_ping_time}")


@scheduler.before_loop
async def before_scheduler():
    global next_ping_time
    await bot.wait_until_ready()
    next_ping_time = get_random_ping_time()
    print(f"First ping scheduled for: {next_ping_time}")


# Admin command to manually trigger the photo prompt
@bot.command()
@commands.has_permissions(administrator=True)
async def forceprompt(ctx):
    await send_photo_prompt()


# Admin command to check who hasn't responded
@bot.command()
@commands.has_permissions(administrator=True)
async def pending(ctx):
    if not photo_session_active:
        await ctx.send("No active photo cycle right now.")
        return

    channel = bot.get_channel(CHANNEL_ID)
    if channel is None or not isinstance(channel, discord.TextChannel):
        await ctx.send("Photo channel is unavailable.")
        return

    member_ids = {member.id for member in channel.guild.members if not member.bot}
    missing_ids = sorted(member_ids - submitted_users)

    if missing_ids:
        mentions = ' '.join([f'<@{uid}>' for uid in missing_ids])
        await ctx.send(f"Still waiting on: {mentions}")
    else:
        await ctx.send("Everyone has submitted for this cycle.")


@bot.command()
async def streak(ctx, member: discord.Member = None):
    target = member or ctx.author
    current = user_streaks.get(target.id, 0)

    if photo_session_active and target.id in submitted_users:
        current += 1

    await ctx.send(f"🔥 {target.display_name}'s current streak: **{current}**")


bot.run(TOKEN)