# 7xBot

## Commands

### `!streak`
- Shows your current streak.

### `!streak @member`
- Shows streak for a tagged member.

## Environment Variables

Create a `.env` file with:

```env
DISCORD_TOKEN=your_bot_token
WYD_CHANNEL_ID=your_photo_channel_id
GROQ_API_KEY=your_groq_api_key
# Optional, defaults to llama-3.1-8b-instant
GROQ_SUMMARY_MODEL=llama-3.1-8b-instant
```

## Install and Run

```bash
pip install -r requirements.txt
python 7xBot.py
```

## Dev Note

- Work in your own branch for new changes.
