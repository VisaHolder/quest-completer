# QuestCompleter

A set-and-forget Discord Quest auto-completer for BetterDiscord. Turn it on once and it quietly
finishes every quest for you - video, play-a-game, activity, mobile-video - one at a time, evenly
spaced, and auto-does any new quest the moment it shows up. No installers, no external sites, no
tokens, no accounts. Everything runs through Discord's own quest API and never leaves your client.

Updates and help: [Telegram - @GamingSandals](https://t.me/GamingSandals)

> Heads up: automating quests is against Discord's Terms of Service and Discord does flag it. The
> risk is to your whole account, not just the reward. Use it at your own risk.

## Install

1. Have [BetterDiscord](https://betterdiscord.app) installed.
2. Drop `QuestCompleter.plugin.js` into your plugins folder
   (`User Settings > BetterDiscord > Plugins > Open Plugins Folder`).
3. Enable QuestCompleter in the Plugins list. That's it - it runs on its own from here.

## What it does

- Finds every quest you can complete and does them for you, automatically.
- Works on new quests too - it re-scans on login and whenever Discord hands out a quest, so you
  never have to touch it again.
- Handles every task type as PC: watch-video, play-a-game, activity, and mobile-video (forced
  through as a normal completion).
- Does one quest at a time with a randomised gap between them, at natural speed - no bursts, no
  faster-than-real-time video, nothing that looks scripted.
- Spreads the work out - does a couple, then waits 1-2 hours before the next few, so a full set
  finishes over a few hours rather than all in one sitting.
- Only runs while you are actually at the machine. If you go idle, AFK, or lock your screen, it
  pauses on its own, so nothing fires while you are asleep.
- Keeps a running count of how many quests it has finished, shown in the settings.

## Settings

- Auto-complete quests - the master switch.
- Auto-accept new quests - enrolls you so you don't have to click Accept first.
- Hide completed quests - clears completed quests out of Discord's Quests page so the list only shows
  what is left. Handy for watching it work.
- Quest types - turn each type on or off: play-a-game, watch-video, activity, stream.
- Only run while you're active - pauses when you are idle, AFK, or your screen is locked.
- Spread quests out - do a couple, then wait 1-2 hours before the next few, so a set finishes over a
  few hours. Anything about to expire is still done right away.
- Only during set hours - restrict all activity to a daily time window (can wrap past midnight).
- Max per day - stop after a set number of quests each day (0 means no limit).
- Toast on each completion - a small popup when a quest is done.
- Run now - kick off a scan immediately instead of waiting.

The settings panel also shows the all-time completed count, orbs earned, a recent-completions list,
what it is working on right now, and what is still waiting.

## How it works

Everything goes through Discord's own internal quest endpoints - the plugin only nudges the same
calls Discord already makes:

- Video quests: post climbing watch-progress, but never faster than real wall-clock time.
- Play quests: present the game as running so Discord's own client sends the heartbeats; the plugin
  just waits for the progress to reach the target.
- Activity quests: send heartbeats on a real interval.
- Stream quests: present stream metadata (you need to be in a voice call for Discord to count it).

Quests are handled strictly one at a time because Discord only ever tracks a single active game, and
a randomised human gap sits between each one.

## Notes

- Nothing is sent anywhere except Discord's own API. No third-party servers, no telemetry.
- Stream quests require you to be in a voice call - Discord will not count them otherwise.
- If Discord refuses to auto-enroll a quest, just click Accept on it in the Quests tab; the plugin
  takes over from there.

## Contact

Questions, bugs, or updates: [Telegram - @GamingSandals](https://t.me/GamingSandals)
