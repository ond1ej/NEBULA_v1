# Voice

Voice works in Telegram (voice notes), the Mini App and the native apps. Speech recognition is local first and never
silently uses a cloud service.

## Speech-to-text

**Status: Experimental.** Implemented and tested with recorded transcripts; real transcription quality was not part of
the release test.

- **Local whisper.cpp (preferred):** audio never leaves the Mac. NEBULA does not install it. Run
  `brew install whisper-cpp` yourself, then download a model in **Voice** settings (tiny, base or small; multilingual,
  including English and Czech). The download comes from the official whisper.cpp model repository on Hugging Face,
  only after you confirm; the size and file header are checked and the SHA-256 is recorded.
- **OpenAI transcription (optional):** only with a connected OpenAI API key **and** your explicit consent in Voice
  settings.
- Without either, voice messages are refused with setup instructions, and nothing is uploaded anywhere.
- Jobs run one at a time; `whisper-cli` exits after each job, so no model stays in memory. Language: automatic,
  English or Czech.

## Language

English is the default everywhere in voice: recognition of commands, spoken status summaries and text-to-speech.
Czech is used only when NEBULA detects it (a letter only Czech uses, or clearly Czech words; common English words
such as "a" or "to" never count) or when you set an agent's voice language to Czech. The text-to-speech API also
defaults to English when a request names no language.

## Text-to-speech

**Status: Stable.**

- **Local macOS `say`**, converted to OGG/Opus with ffmpeg for Telegram voice notes (M4A as a fallback). Free and
  offline; any voice installed on the Mac can be used.
- **OpenAI text-to-speech (optional):** refused by the server without your explicit consent; withdrawing consent falls
  back to local voices.
- Per agent (**Agent → Voice**): reply mode (text, voice, text and voice, or automatic: answer a voice note with a voice
  note), provider, voice, language (`auto` by default: English unless the message is Czech; or fixed English or
  Czech) and speed, with a preview in the dashboard.

## Voice conversations

1. A voice note (at most 20 MB and 10 minutes) is stored as an attachment and transcribed.
2. The transcript is shown, then parsed: who it addresses (an agent's name) and simple intents (status, pause, resume,
   stop, screenshot, team status, company status). These are answered from real data without an AI request and spoken
   back. In Telegram, a voice command needs the same permission as the typed command: pause, resume and stop need
   `commands`, a screenshot needs `screenshot`, and the status questions work for any approved account
   ([telegram.md](../telegram.md#who-can-do-what-in-the-chat)).
3. Anything else becomes a task for the addressed or selected agent (in Telegram this needs the `tasks` permission).
   Follow-ups keep the conversation context. The result is spoken when the reply mode says so.
4. Risky actions inside tasks still need approval, and only the owner can give it. A voice note never decides an
   approval.
