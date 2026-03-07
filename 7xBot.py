from dotenv import load_dotenv
import os
import discord
from discord.ext import commands, tasks
import asyncio
import random
from datetime import datetime, timedelta
import pytz

load_dotenv()

TOKEN = os.getenv("DISCORD_TOKEN")
if TOKEN is None:
    raise ValueError("DISCORD_TOKEN environment variable is not set.")

CHANNEL_ID = int(os.getenv("WYD_CHANNEL_ID") or 0)
if CHANNEL_ID == 0:
    raise ValueError("WYD_CHANNEL_ID environment variable is not set or invalid.")

TIMEZONE = pytz.timezone('America/New_York')

intents = discord.Intents.default()
intents.message_content = True
intents.members = True

bot = commands.Bot(command_prefix='!', intents=intents)

pending_users = set()
photo_session_active = False
reminder_task = None


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


async def send_photo_prompt():
    global pending_users, photo_session_active, reminder_task

    channel = bot.get_channel(CHANNEL_ID)
    if channel is None:
        print("Channel not found.")
        return
    if not isinstance(channel, discord.TextChannel):
        print("Channel is not a text channel.")
        return
    guild = channel.guild
    pending_users = set()

    for member in guild.members:
        if not member.bot:
            pending_users.add(member.id)

    photo_session_active = True

    await channel.send(
        f"@everyone 📸 WYD RN SEND A PHOTOOOOO"
    )

    # Wait 5 minutes for initial responses
    await asyncio.sleep(300)

    if pending_users:
        mentions = ' '.join([f'<@{uid}>' for uid in pending_users])
        await channel.send(
            f"⏰ Yo you guys missed it wyd {mentions}"
        )
        # reminder_task = asyncio.create_task(reminder_loop(channel))


async def reminder_loop(channel):
    global pending_users, photo_session_active

    while pending_users and photo_session_active:
        mentions = ' '.join([f'<@{uid}>' for uid in pending_users])
        await channel.send(
            f"⏰ Yo what y'all doin rn send a photo {mentions}"
        )
        await asyncio.sleep(900)  # 15 minutes


@bot.event
async def on_ready():
    print(f'Logged in as {bot.user}')
    scheduler.start()


@bot.event
async def on_message(message):
    global pending_users, photo_session_active, reminder_task

    if message.author.bot:
        return

    if photo_session_active and message.channel.id == CHANNEL_ID:
        if message.attachments:
            for attachment in message.attachments:
                if any(attachment.filename.lower().endswith(ext) for ext in ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'mp4', 'mov']):
                    if message.author.id in pending_users:
                        pending_users.discard(message.author.id)
                        await message.add_reaction('✅')

                        if not pending_users:
                            photo_session_active = False
                            if reminder_task:
                                reminder_task.cancel()
                            await message.channel.send("🎉 Great job guys")

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

# Admin command to clear pending users
@bot.command()
@commands.has_permissions(administrator=True)
async def clear(ctx):
    await pending_users.clear()
    
# Admin command to check who hasn't responded
@bot.command()
@commands.has_permissions(administrator=True)
async def pending(ctx):
    if pending_users:
        mentions = ' '.join([f'<@{uid}>' for uid in pending_users])
        await ctx.send(f"Still waiting on: {mentions}")
    else:
        await ctx.send("No pending users!")


bot.run(TOKEN)