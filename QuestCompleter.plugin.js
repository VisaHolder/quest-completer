/**
 * @name QuestCompleter
 * @author GamingSandals
 * @description Set-and-forget Discord Quest completer. Finishes every quest and claims the reward for you - one at a time, at a human pace, pausing while you're away - and auto-does new quests on their own. No installs, no sites, no tokens.
 * @version 1.5.4
 * @website https://t.me/GamingSandals
 * @source https://github.com/VisaHolder/quest-completer
 * @updateUrl https://raw.githubusercontent.com/VisaHolder/quest-completer/main/QuestCompleter.plugin.js
 */

/*
 * How it works (all through Discord's OWN quest API - nothing leaves your client):
 *   WATCH_VIDEO / WATCH_VIDEO_ON_MOBILE -> POST /quests/{id}/video-progress, timestamp climbing
 *                                          no faster than real wall-clock time (that's the tell).
 *   PLAY_ON_DESKTOP (+ any PLAY_* task)  -> fake the game as running; Discord's own client sends
 *                                          the heartbeats. Everything is completed as PC.
 *   PLAY_ACTIVITY                        -> POST /quests/{id}/heartbeat on a real interval.
 *   STREAM_ON_DESKTOP                    -> fake stream metadata (you must be in a voice call).
 *
 * One quest at a time, with a randomised human gap between them - no bursts, even spacing.
 * A watcher re-scans on Discord's quest-fetch / enroll events plus a light timer, so brand-new
 * quests get done on their own (on login or whenever).
 *
 * Heads up: automating quests breaks Discord's Terms of Service and Discord flags it. Getting caught
 * bans you from Quests - you lose quest access and rewards. You accept that risk by enabling this.
 */

const { Webpack, Patcher, Data, UI } = new BdApi("QuestCompleter");
const VERSION = "1.5.4"; // keep in sync with @version above - used for the self-updater
const UPDATE_URL = "https://raw.githubusercontent.com/VisaHolder/quest-completer/main/QuestCompleter.plugin.js";

module.exports = class QuestCompleter {
    constructor() {
        this.processing = new Set();      // quest ids currently being worked
        this.fakeGames = new Map();       // questId -> fake running-game object (PLAY_*)
        this.fakeStreams = new Map();     // questId -> fake stream metadata (STREAM_*)
        this.waiters = new Map();         // questId -> resolve fn (play/stream wait for completion)
        this.timeouts = new Map();        // questId -> safety-timeout handle
        this.subs = [];                   // [ [event, handler] ] flux subs to clean up
        this.timer = null;
        this.pumpT = null;
        this.busy = false;                // only one quest is ever worked at a time
        this.session = 0;                 // quests completed since this load
        this.settings = Object.assign(
            {
                enabled: true, autoEnroll: true, autoClaim: true, notify: true, hideCompleted: true, checkUpdates: true,
                activeOnly: true, batchRest: true,
                activeHours: false, hourStart: 10, hourEnd: 2,       // only run within this window
                dailyCap: 0,                                          // max quests/day (0 = no limit)
                doVideo: true, doPlay: true, doActivity: true, doStream: true, // per-type switches
                gapMin: 40, gapMax: 90,          // seconds between quests within a sitting
                perSitting: 2, restMin: 60, restMax: 120, // do a couple, then rest this many minutes (spreads a set over ~2-4h)
            },
            Data.load("settings") || {}
        );
        this.stats = Object.assign(
            { completed: 0, nextAllowedAt: 0, orbs: 0, day: "", dayCount: 0, history: [] },
            Data.load("stats") || {}
        );
        this.sitting = 0; // quests done in the current sitting
    }

    // -- lifecycle ----------------------------------------------------------------
    start() {
        try { this.resolveModules(); } catch (e) { console.error("[QC] module resolve failed", e); }
        if (!this.QuestsStore || !this.QuestsStore.quests || !this.Api || !this.Flux) {
            UI.showToast?.("QuestCompleter: couldn't hook Discord's quest API (a Discord update may have moved it).", { type: "error" });
            return;
        }
        this.patchStores();
        this.installHide();
        // Re-scan when Discord (re)fetches quests or enrolls you; watch heartbeats for completion.
        this.subscribe("QUESTS_FETCH_CURRENT_QUESTS_SUCCESS", () => this.schedulePump(this.humanGap()));
        this.subscribe("QUESTS_ENROLL_SUCCESS", () => this.schedulePump(2000));
        this.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", () => this.onHeartbeat());
        this.timer = setInterval(() => this.schedulePump(0), 5 * 60_000);
        // Human warm-up: don't start grinding the instant Discord opens - wait a believable few minutes.
        this.schedulePump(60_000 + Math.random() * 180_000);
        // Self-update: check GitHub shortly after load, then every 6 hours.
        if (this.settings.checkUpdates !== false) {
            setTimeout(() => this.checkUpdate(), 12_000);
            this.updTimer = setInterval(() => this.checkUpdate(), 6 * 3600_000);
        }
    }

    stop() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this.updTimer) { clearInterval(this.updTimer); this.updTimer = null; }
        if (this.pumpT) { clearTimeout(this.pumpT); this.pumpT = null; }
        if (this.panelIv) { clearInterval(this.panelIv); this.panelIv = null; }
        for (const t of this.timeouts.values()) clearTimeout(t);
        this.timeouts.clear();
        for (const [ev, fn] of this.subs) { try { this.Flux.unsubscribe(ev, fn); } catch { /* */ } }
        this.subs = [];
        const removed = [...this.fakeGames.values()];
        this.fakeGames.clear(); this.fakeStreams.clear();
        for (const w of this.waiters.values()) { try { w(); } catch { /* */ } }
        this.waiters.clear();
        try { this.dispatchGames([], removed); } catch { /* */ }
        try { this.uninstallHide(); } catch { /* */ }
        Patcher.unpatchAll();
    }

    // -- module wiring (BdApi named lookups - far stabler than minified-export probing) --
    resolveModules() {
        // Discord renamed the store "QuestsStore" -> "QuestStore" (singular). Prefer the current
        // name, fall back to a property signature (survives future renames), then the legacy name.
        this.QuestsStore = Webpack.getStore("QuestStore")
            || Webpack.getModule(m => m && m.quests && typeof m.getQuest === "function")
            || Webpack.getStore("QuestsStore");
        this.RunningGameStore = Webpack.getModule(m => m?.getRunningGames && m?.getGameForPID);
        this.StreamingStore = Webpack.getModule(m => m?.getStreamerActiveStreamMetadata);
        this.ChannelStore = Webpack.getStore("ChannelStore");
        this.IdleStore = Webpack.getStore("IdleStore"); // isAFK / isIdle / getSystemLocked / getSystemSuspended
        // The Flux dispatcher is a nested export in current builds - needs searchExports to surface.
        this.Flux = Webpack.getModule(m => m?.dispatch && m?.subscribe && m?.unsubscribe)
            || Webpack.getModule(m => m?.dispatch && m?.subscribe, { searchExports: true });
        // The high-level REST client (accepts {url, body}) is the `Bo` export - exactly what the
        // canonical public scripts grab. Several other modules also expose get/post/del but are the
        // low-level client that wants (url, body) and throws on an object, so prefer `.Bo`, then fall
        // back to a client that also has getAPIBaseURL, then any get+post+del as a last resort.
        const hasVerbs = o => { try { return typeof o?.get === "function" && typeof o?.post === "function" && typeof o?.del === "function"; } catch { return false; } };
        this.Api = Webpack.getModule(m => { try { return hasVerbs(m?.Bo); } catch { return false; } })?.Bo
            || Webpack.getModule(m => { try { return hasVerbs(m) && typeof m.getAPIBaseURL === "function"; } catch { return false; } })
            || Webpack.getModule(m => hasVerbs(m));
    }

    subscribe(ev, fn) { this.Flux.subscribe(ev, fn); this.subs.push([ev, fn]); }

    patchStores() {
        if (this.RunningGameStore) {
            Patcher.instead(this.RunningGameStore, "getRunningGames", () => [...this.fakeGames.values()]);
            Patcher.instead(this.RunningGameStore, "getGameForPID", (_, [pid]) => [...this.fakeGames.values()].find(g => g.pid === pid) || null);
        }
        if (this.StreamingStore) {
            Patcher.instead(this.StreamingStore, "getStreamerActiveStreamMetadata", (self, args, orig) => {
                for (const meta of this.fakeStreams.values()) return meta;
                return orig.apply(self, args);
            });
        }
    }

    dispatchGames(added = [], removed = []) {
        const games = [...this.fakeGames.values()];
        this.Flux.dispatch({ type: "RUNNING_GAMES_CHANGE", removed, added, games });
    }

    // -- hide completed quests from the Quests tab --------------------------------
    // The UI reads store.quests (a getter); getQuest(id) reads a separate private map, so filtering
    // the getter hides finished quests from the tab without touching anything the plugin relies on.
    installHide() {
        const store = this.QuestsStore;
        let target = store, desc = Object.getOwnPropertyDescriptor(store, "quests");
        if (!desc) { target = Object.getPrototypeOf(store); desc = Object.getOwnPropertyDescriptor(target, "quests"); }
        if (!desc || typeof desc.get !== "function") return;
        this._hideTarget = target;
        this._hideOrig = desc;
        const origGet = desc.get, self = this;
        Object.defineProperty(target, "quests", {
            configurable: true,
            enumerable: desc.enumerable,
            get() {
                const real = origGet.call(this);
                if (!self.settings.hideCompleted) return real;
                try {
                    const src = real instanceof Map ? real : new Map(Object.entries(real || {}));
                    // Cheap memo so the UI's store-selectors don't see a brand-new Map every render.
                    let done = 0; for (const q of src.values()) if (q?.userStatus?.completedAt) done++;
                    const sig = src.size + ":" + done;
                    if (self._hideCache && self._hideBase === src && self._hideSig === sig) return self._hideCache;
                    const filtered = new Map();
                    for (const [k, q] of src) if (!q?.userStatus?.completedAt) filtered.set(k, q);
                    self._hideCache = filtered; self._hideBase = src; self._hideSig = sig;
                    return filtered;
                } catch { return real; }
            },
        });
    }

    uninstallHide() {
        if (this._hideTarget && this._hideOrig) Object.defineProperty(this._hideTarget, "quests", this._hideOrig);
        this._hideTarget = this._hideOrig = this._hideCache = this._hideBase = null;
    }

    // -- quest selection ----------------------------------------------------------
    allQuests() {
        // Read the unfiltered map straight from getQuest's backing store so our own logic still sees
        // completed quests even while the UI-facing getter is hiding them.
        const q = this.QuestsStore.quests;
        return q?.values ? [...q.values()] : Object.values(q || {});
    }

    eligibleQuests() {
        const out = [];
        for (const q of this.allQuests()) {
            const cfg = q?.config, us = q?.userStatus;
            if (!cfg) continue;
            if (us?.completedAt) continue;                        // already done
            const exp = new Date(cfg.expiresAt).getTime();
            if (exp && exp < Date.now()) continue;                // expired
            if (!this.taskOf(q)?.target) continue;                // nothing we can drive
            out.push(q);
        }
        return out;
    }

    // Which per-type switch governs a task name.
    typeEnabled(n) {
        const key = /VIDEO/.test(n) ? "doVideo" : /ACTIVITY/.test(n) ? "doActivity" : /STREAM/.test(n) ? "doStream" : "doPlay";
        return this.settings[key] !== false;
    }

    taskOf(quest) {
        const tasks = (quest.config.taskConfig ?? quest.config.taskConfigV2)?.tasks || {};
        // Prefer the quickest fully-automatable task, always completing as PC (incl. mobile video),
        // and only pick task types the user has left enabled.
        const order = ["WATCH_VIDEO", "WATCH_VIDEO_ON_MOBILE", "PLAY_ON_DESKTOP", "PLAY_ACTIVITY", "STREAM_ON_DESKTOP"];
        for (const name of order) if (tasks[name] && this.typeEnabled(name)) return { name, target: tasks[name].target ?? tasks[name].amount ?? 0 };
        const first = Object.keys(tasks).find(n => this.typeEnabled(n));
        return first ? { name: first, target: tasks[first].target ?? tasks[first].amount ?? 0 } : null;
    }

    questName(quest) { return quest?.config?.messages?.questName || quest?.config?.application?.name || "quest"; }
    progress(quest, taskName) { return this.QuestsStore.getQuest(quest.id)?.userStatus?.progress?.[taskName]?.value ?? 0; }
    humanGap() { const lo = this.settings.gapMin * 1000, hi = this.settings.gapMax * 1000; return lo + Math.random() * Math.max(0, hi - lo); }

    // -- the driver: one quest at a time, evenly spaced ---------------------------
    schedulePump(delay = 0) { clearTimeout(this.pumpT); this.pumpT = setTimeout(() => this.pump(), delay); }

    // Is the user actually at the machine? Uses Discord's own idle/AFK + OS lock/suspend signals.
    isActive() {
        const I = this.IdleStore; if (!I) return true;
        try {
            if (I.getSystemLocked?.()) return false;   // screen locked
            if (I.getSystemSuspended?.()) return false; // machine asleep
            if (I.isAFK?.()) return false;              // Discord marked you away
            if (I.isIdle?.()) return false;             // no input for a while
        } catch { /* */ }
        return true;
    }

    restDelay() {
        const lo = Math.max(0, this.settings.restMin) * 60_000;
        const hi = Math.max(this.settings.restMin, this.settings.restMax) * 60_000;
        return lo + Math.random() * Math.max(0, hi - lo);
    }

    // A quest that would expire during a rest gets done now regardless, so we never miss one.
    hasUrgent(byTime) {
        return this.eligibleQuests().some(q => {
            const e = new Date(q.config.expiresAt).getTime();
            return e && e < byTime + 2 * 3600_000;
        });
    }

    // Active-hours window; handles windows that cross midnight (e.g. 10 -> 2).
    inHours() {
        if (!this.settings.activeHours) return true;
        const h = new Date().getHours();
        const s = ((this.settings.hourStart % 24) + 24) % 24, e = ((this.settings.hourEnd % 24) + 24) % 24;
        return s === e ? true : s < e ? (h >= s && h < e) : (h >= s || h < e);
    }

    // Daily cap - reset the per-day counter when the calendar day rolls over.
    dayRoll() {
        const today = new Date().toDateString();
        if (this.stats.day !== today) { this.stats.day = today; this.stats.dayCount = 0; Data.save("stats", this.stats); }
    }
    capReached() { return this.settings.dailyCap > 0 && (this.stats.dayCount || 0) >= this.settings.dailyCap; }

    // How many orbs a quest pays out (for the running total + history).
    orbsOf(quest) {
        try {
            const rw = quest?.config?.rewardsConfig?.rewards || quest?.config?.rewards || [];
            for (const r of rw) { const n = r.orbQuantity ?? r.orb_quantity; if (n) return +n; }
        } catch { /* */ }
        return 0;
    }

    async pump() {
        if (this.busy || !this.settings.enabled) return;
        const now = Date.now();
        // Day-scale rest between sittings (persisted in stats.nextAllowedAt so it survives restarts).
        if (this.settings.batchRest && this.stats.nextAllowedAt && now < this.stats.nextAllowedAt && !this.hasUrgent(this.stats.nextAllowedAt)) {
            this.schedulePump(Math.min(this.stats.nextAllowedAt - now, 20 * 60_000));
            return;
        }
        // Only work while you're actually around.
        if (this.settings.activeOnly && !this.isActive()) {
            this.schedulePump(150_000 + Math.random() * 120_000); // re-check every ~2.5-4.5 min
            return;
        }
        // Only during your active hours.
        if (!this.inHours()) { this.schedulePump(5 * 60_000 + Math.random() * 5 * 60_000); return; }
        // Daily cap - stop once you've hit it, pick up again tomorrow.
        this.dayRoll();
        if (this.capReached()) { this.schedulePump(20 * 60_000); return; }
        const next = this.eligibleQuests().find(q => !this.processing.has(q.id));
        if (!next) return; // nothing to do; an event or the timer re-triggers later
        this.busy = true;
        let worked = false;
        try { worked = await this.completeQuest(next); }
        catch (e) { console.error("[QC] pump", e); }
        this.busy = false;
        if (worked) { this.dayRoll(); this.stats.dayCount = (this.stats.dayCount || 0) + 1; Data.save("stats", this.stats); }
        if (worked && this.settings.batchRest && ++this.sitting >= Math.max(1, this.settings.perSitting)) {
            this.sitting = 0;
            this.stats.nextAllowedAt = Date.now() + this.restDelay(); // rest for hours before the next few
            Data.save("stats", this.stats);
            this.refreshPanel();
            this.schedulePump(Math.min(this.stats.nextAllowedAt - Date.now(), 20 * 60_000));
            return;
        }
        this.schedulePump(this.humanGap()); // short, human spacing within a sitting
    }

    runAll() { this.stats.nextAllowedAt = 0; this.sitting = 0; Data.save("stats", this.stats); this.schedulePump(0); } // "Run now" ignores the rest

    async completeQuest(quest) {
        const id = quest.id, name = this.questName(quest);
        const task = this.taskOf(quest);
        if (!task || !task.target) return false;
        this.processing.add(id);
        this.refreshPanel();
        try {
            await sleep(1200 + Math.random() * 2600); // a beat, like a person clicking in
            if (this.settings.autoEnroll && !this.QuestsStore.getQuest(id)?.userStatus?.enrolledAt) {
                await this.enroll(id).catch(() => { /* not enrollable this way - user can Accept in UI */ });
            }
            const n = task.name;
            if (/VIDEO/.test(n)) await this.doVideo(quest, task);
            else if (/STREAM/.test(n)) await this.doStream(quest, task, name);
            else if (/ACTIVITY/.test(n)) await this.doActivity(quest, task);
            else if (/PLAY|DESKTOP|CONSOLE|XBOX|PLAYSTATION/.test(n)) await this.doPlay(quest, task, name);
            else { console.warn("[QC] unsupported task", n, "for", name); this.processing.delete(id); return false; }
            return true;
        } catch (e) {
            console.error("[QC] complete failed for", name, e);
            this.processing.delete(id);
            return false;
        }
    }

    async enroll(id) {
        // Best-effort auto-accept. If Discord rejects the shape, the user accepts in the Quests tab.
        return this.Api.post({ url: `/quests/${id}/enroll`, body: { location: 0 } });
    }

    // Claim the reward once the quest is complete. Discord sometimes gates claiming behind a captcha,
    // which no script can bypass (it's an hCaptcha) - so we claim when we can, and when a captcha is
    // required we tell you to press Claim yourself instead of failing silently.
    async claim(id, name) {
        if (!this.settings.autoClaim) return;
        for (let i = 0; i < 5; i++) { // wait for Discord to register completion, then claim once
            const us = this.QuestsStore.getQuest(id)?.userStatus;
            if (us?.claimedAt) return;      // already claimed
            if (us?.completedAt) break;     // ready to claim
            await sleep(2500);
        }
        if (this.QuestsStore.getQuest(id)?.userStatus?.claimedAt) return;
        try {
            await this.Api.post({ url: `/quests/${id}/claim-reward`, body: { platform: 0, location: 11, is_targeted: false, metadata_raw: null, metadata_sealed: null, traffic_metadata_raw: null, traffic_metadata_sealed: null } });
        } catch (e) {
            // Detect the captcha specifically and nudge the user; anything else is just logged.
            if (e?.body?.captcha_key || e?.body?.captcha_sitekey || e?.body?.captcha_service) {
                UI.showToast?.(`Captcha needed to claim "${name || "reward"}" - open the Quests tab and press Claim.`, { type: "warn" });
            } else {
                console.error("[QC] claim failed - you can claim it manually in the Quests tab", e);
            }
        }
    }

    finish(id, name, success = true) {
        if (!this.processing.has(id) && !this.waiters.has(id)) return; // idempotent
        this.processing.delete(id);
        const game = this.fakeGames.get(id);
        this.fakeGames.delete(id); this.fakeStreams.delete(id);
        const t = this.timeouts.get(id); if (t) { clearTimeout(t); this.timeouts.delete(id); }
        try { this.dispatchGames([], game ? [game] : []); } catch { /* */ }
        if (success) {
            const orbs = this.orbsOf(this.QuestsStore.getQuest(id));
            this.stats.completed = (this.stats.completed || 0) + 1; this.session++;
            this.stats.orbs = (this.stats.orbs || 0) + orbs;
            this.stats.history = [{ name, orbs, at: Date.now() }, ...(this.stats.history || [])].slice(0, 20);
            Data.save("stats", this.stats);
            this.claim(id, name); // grab the reward (best-effort; no-op if autoClaim is off or already claimed)
            if (this.settings.notify) UI.showToast?.(`Quest complete: ${name}${orbs ? ` (+${orbs} orbs)` : ""}`, { type: "success" });
        }
        this.refreshPanel();
        const w = this.waiters.get(id); if (w) { this.waiters.delete(id); w(); }
    }

    // Resolves when finish() runs for this quest, or after a safety timeout.
    awaitDone(id, name, timeout) {
        return new Promise(resolve => {
            this.waiters.set(id, resolve);
            this.timeouts.set(id, setTimeout(() => this.finish(id, name, false), timeout));
        });
    }

    // WATCH_VIDEO / WATCH_VIDEO_ON_MOBILE - climb the timestamp, but never faster than real time.
    async doVideo(quest, task) {
        const id = quest.id, name = this.questName(quest), target = task.target;
        if (this.settings.notify) UI.showToast?.(`Working on: ${name}`, { type: "info" });
        const startedAt = Date.now();
        let ts = this.progress(quest, task.name);
        while (ts < target) {
            await sleep(5000 + Math.random() * 4000); // a real viewer pings every few seconds
            const elapsed = (Date.now() - startedAt) / 1000 + ts;
            ts = Math.min(target, Math.max(ts + 1, Math.floor(elapsed) - Math.floor(Math.random() * 2)));
            try { await this.Api.post({ url: `/quests/${id}/video-progress`, body: { timestamp: Number(ts.toFixed(2)) } }); }
            catch (e) { console.error("[QC] video-progress", e); break; }
            if (this.QuestsStore.getQuest(id)?.userStatus?.completedAt) break;
        }
        this.finish(id, name, true);
    }

    // PLAY_* - pretend the game is running; Discord's own client sends the heartbeats.
    async doPlay(quest, task, name) {
        const appId = quest.config.application?.id;
        const pid = 3000 + Math.floor(Math.random() * 27000); // realistic-looking PID
        const folder = (name || "Game").replace(/[^a-z0-9 ]/gi, "").trim() || "Game";
        const exeName = `${folder.replace(/\s+/g, "")}.exe`;
        const dir = `C:\\Program Files (x86)\\Steam\\steamapps\\common\\${folder}`;
        // Shape matches what Discord's own game scanner emits - the session-decider needs pidPath /
        // isLauncher / cmdLine to accept it as the primary running game. Paths look like a real Steam
        // install and the start time is a little in the past, like a game you've been in for a minute.
        const game = {
            cmdLine: `"${dir}\\${exeName}"`,
            exeName,
            exePath: `${dir}\\${exeName}`,
            hidden: false,
            isLauncher: false,
            id: appId,
            name,
            pid,
            pidPath: [pid],
            processName: name,
            start: Date.now() - (20_000 + Math.floor(Math.random() * 130_000)),
        };
        this.fakeGames.set(quest.id, game);
        this.dispatchGames([game], []);
        if (this.settings.notify) UI.showToast?.(`Working on: ${name}`, { type: "info" });
        await this.awaitDone(quest.id, name, 30 * 60_000); // completion detected in onHeartbeat()
    }

    // PLAY_ACTIVITY - heartbeat on a real cadence using a DM/call channel as the stream key.
    async doActivity(quest, task) {
        const id = quest.id, name = this.questName(quest);
        if (this.settings.notify) UI.showToast?.(`Working on: ${name}`, { type: "info" });
        const ch = this.ChannelStore?.getSortedPrivateChannels?.()?.[0]?.id || "0";
        const streamKey = `call:${ch}:1`;
        while (true) {
            const cur = this.progress(quest, task.name);
            const terminal = cur >= task.target;
            try { await this.Api.post({ url: `/quests/${id}/heartbeat`, body: { stream_key: streamKey, terminal } }); }
            catch (e) { console.error("[QC] activity heartbeat", e); break; }
            if (terminal || this.QuestsStore.getQuest(id)?.userStatus?.completedAt) break;
            await sleep(20000 + Math.random() * 4000);
        }
        this.finish(id, name, true);
    }

    // STREAM_ON_DESKTOP - fake the stream metadata. Discord only counts it if you're in a voice call.
    async doStream(quest, task, name) {
        const appId = quest.config.application?.id;
        const pid = 10000 + Math.floor(Math.random() * 40000);
        this.fakeStreams.set(quest.id, { id: appId, pid, sourceName: null });
        if (this.settings.notify) UI.showToast?.(`Working on: ${name} - join any voice call so Discord counts it.`, { type: "info" });
        await this.awaitDone(quest.id, name, 30 * 60_000);
    }

    // Fired on every heartbeat Discord sends for a faked game/stream - finish anything that's done.
    onHeartbeat() {
        for (const id of [...this.fakeGames.keys(), ...this.fakeStreams.keys()]) {
            const q = this.QuestsStore.getQuest(id);
            const us = q?.userStatus, task = q && this.taskOf(q);
            if (!us || !task) continue;
            const cur = us.progress?.[task.name]?.value ?? us.streamProgressSeconds ?? 0;
            if (us.completedAt || (task.target && cur >= task.target)) this.finish(id, this.questName(q), true);
        }
    }

    // -- self-update: compare GitHub's @version to ours, offer to replace this file ----
    isNewer(a, b) {
        const pa = String(a).split(".").map(n => parseInt(n, 10) || 0);
        const pb = String(b).split(".").map(n => parseInt(n, 10) || 0);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const x = pa[i] || 0, y = pb[i] || 0;
            if (x > y) return true;
            if (x < y) return false;
        }
        return false;
    }

    async fetchText(url) {
        if (BdApi.Net?.fetch) { const r = await BdApi.Net.fetch(url, { cache: "no-cache" }); return r.text(); }
        return new Promise((res, rej) => {
            try { require("request").get({ url, headers: { "User-Agent": "QuestCompleter" } }, (e, _, b) => e ? rej(e) : res(b)); }
            catch (err) { rej(err); }
        });
    }

    async checkUpdate(manual) {
        let text = "";
        try { text = await this.fetchText(UPDATE_URL + "?t=" + Date.now()); }
        catch (e) { if (manual) UI.showToast?.("Update check failed - try again later.", { type: "error" }); return; }
        const remote = (text.match(/@version\s+([0-9.]+)/) || [])[1];
        if (!remote) { if (manual) UI.showToast?.("Couldn't read the latest version.", { type: "error" }); return; }
        if (!this.isNewer(remote, VERSION)) { if (manual) UI.showToast?.(`You're up to date (v${VERSION}).`, { type: "success" }); return; }
        BdApi.UI.showConfirmationModal(
            "QuestCompleter update",
            `Version ${remote} is out (you have ${VERSION}). Update now? It replaces the plugin and reloads.`,
            { confirmText: "Update", cancelText: "Later", onConfirm: () => this.applyUpdate(text, remote) }
        );
    }

    applyUpdate(text, remote) {
        try {
            const fs = require("fs"), path = require("path");
            fs.writeFileSync(path.join(BdApi.Plugins.folder, "QuestCompleter.plugin.js"), text);
            UI.showToast?.(`Updated to v${remote} - reloading.`, { type: "success" });
            // BD's file watcher usually reloads it; force a reload too in case it doesn't fire.
            setTimeout(() => { try { BdApi.Plugins.reload("QuestCompleter"); } catch { /* */ } }, 800);
        } catch (e) {
            console.error("[QC] update write failed", e);
            UI.showToast?.("Update failed - grab the latest from GitHub manually.", { type: "error" });
        }
    }

    // -- settings (plain DOM - no React mount, so it can't silently blank out) -----
    refreshPanel() {
        if (!this._render) return;
        if (!document.contains(this._panel)) { if (this.panelIv) { clearInterval(this.panelIv); this.panelIv = null; } this._render = null; return; }
        try { this._render(); } catch { /* */ }
    }

    getSettingsPanel() {
        const wrap = document.createElement("div");
        wrap.style.cssText = "padding:12px 4px;color:var(--text-normal,#dbdee1);font-family:var(--font-primary),sans-serif;font-size:14px;";

        const warn = document.createElement("div");
        warn.style.cssText = "margin:0 0 14px;padding:10px 12px;border-radius:8px;background:rgba(240,178,50,.10);border:1px solid rgba(240,178,50,.35);color:#f0c674;font-size:12.5px;line-height:1.5;";
        warn.innerHTML = "<b>Heads up</b> - automating quests breaks Discord's Terms of Service and Discord flags it. Getting caught bans you from Quests - you lose quest access and rewards. Use at your own risk.";
        wrap.appendChild(warn);

        const head = document.createElement("div");
        head.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;margin:2px 0 10px;";
        const statBox = document.createElement("div");
        const big = document.createElement("div");
        big.style.cssText = "font-size:28px;font-weight:800;color:var(--text-normal,#fff);line-height:1.1;";
        const small = document.createElement("div");
        small.style.cssText = "font-size:12px;color:var(--text-muted,#b5bac1);margin-top:2px;";
        statBox.append(big, small);
        const btn = document.createElement("button");
        btn.textContent = "Run now";
        btn.style.cssText = "flex:none;cursor:pointer;font-size:13px;font-weight:600;padding:8px 16px;border:none;border-radius:8px;background:#5865f2;color:#fff;";
        btn.addEventListener("click", () => { this.runAll(); UI.showToast?.("Scanning for quests", { type: "info" }); });
        head.append(statBox, btn); wrap.appendChild(head);

        const status = document.createElement("div");
        status.style.cssText = "margin:0 0 6px;padding:10px 12px;border-radius:8px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);font-size:12.5px;line-height:1.6;";
        wrap.appendChild(status);

        const toggle = (key, label, desc, onChange) => {
            const row = document.createElement("label");
            row.style.cssText = "display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-top:1px solid rgba(255,255,255,.06);cursor:pointer;";
            const cb = document.createElement("input");
            cb.type = "checkbox"; cb.checked = !!this.settings[key];
            cb.style.cssText = "margin-top:3px;width:16px;height:16px;accent-color:#5865f2;flex:none;";
            cb.addEventListener("change", () => {
                this.settings[key] = cb.checked; Data.save("settings", this.settings);
                onChange?.(cb.checked);
            });
            const txt = document.createElement("div");
            txt.innerHTML = `<div style="font-weight:600">${label}</div><div style="color:var(--text-muted,#b5bac1);font-size:12.5px;margin-top:2px">${desc}</div>`;
            row.append(cb, txt); wrap.appendChild(row);
        };
        const section = (t) => { const h = document.createElement("div"); h.textContent = t; h.style.cssText = "margin:22px 0 2px;padding-bottom:5px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--header-primary,#f2f3f5);border-bottom:1px solid rgba(255,255,255,.09);"; wrap.appendChild(h); };
        const numField = (key, label, desc, min, max, onChange) => {
            const row = document.createElement("label");
            row.style.cssText = "display:flex;gap:12px;align-items:center;justify-content:space-between;padding:10px 0;border-top:1px solid rgba(255,255,255,.06);";
            const txt = document.createElement("div");
            txt.innerHTML = `<div style="font-weight:600">${label}</div><div style="color:var(--text-muted,#b5bac1);font-size:12.5px;margin-top:2px">${desc}</div>`;
            const inp = document.createElement("input");
            inp.type = "number"; inp.value = this.settings[key]; inp.min = min; inp.max = max;
            inp.style.cssText = "width:60px;flex:none;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.1);background:rgba(0,0,0,.2);color:var(--text-normal,#dbdee1);font-size:13px;text-align:center;";
            inp.addEventListener("change", () => { let v = parseInt(inp.value, 10); if (isNaN(v)) v = min; v = Math.max(min, Math.min(max, v)); this.settings[key] = v; inp.value = v; Data.save("settings", this.settings); onChange?.(v); });
            row.append(txt, inp); wrap.appendChild(row);
        };

        section("Automation");
        toggle("enabled", "Auto-complete quests", "Master switch. On means every current and future quest gets finished for you, one at a time.", v => { if (v) this.schedulePump(0); });
        toggle("autoEnroll", "Auto-accept new quests", "Enrolls you so you don't have to click Accept first.");
        toggle("autoClaim", "Claim rewards automatically", "Grabs the reward as soon as a quest is done. If Discord throws a captcha, this skips quietly and you press Claim yourself.");
        toggle("hideCompleted", "Hide completed quests", "Clears finished quests off Discord's Quests page so the list only shows what's left. Turn off to see everything you've done.", () => { this._hideCache = null; try { this.QuestsStore.emitChange?.(); } catch { /* */ } });

        section("Quest types");
        toggle("doPlay", "Play a game", "Quests that ask you to play a game.");
        toggle("doVideo", "Watch a video", "Watch-video quests, including mobile-video ones.");
        toggle("doActivity", "Activity", "In-call activity quests.");
        toggle("doStream", "Stream", "Stream quests (needs you in a voice call).");

        section("Pacing");
        toggle("activeOnly", "Only while you're active", "Pauses on its own when you're idle, AFK, or your screen is locked.");
        toggle("batchRest", "Spread quests out", "Do a couple, then wait 1-2 hours before the next few, so a full set finishes over a few hours instead of all at once. Anything about to expire is still done right away.", () => this.schedulePump(0));
        toggle("activeHours", "Only during set hours", "Limit it to a daily time window.", () => this.schedulePump(0));
        (() => {
            const row = document.createElement("div");
            row.style.cssText = "display:flex;gap:12px;align-items:center;justify-content:space-between;padding:10px 0;border-top:1px solid rgba(255,255,255,.06);";
            const txt = document.createElement("div");
            txt.innerHTML = `<div style="font-weight:600">Active window</div><div style="color:var(--text-muted,#b5bac1);font-size:12px;margin-top:2px;line-height:1.45">Hours it may run (24h). Wraps past midnight, e.g. 10 to 2.</div>`;
            const box = document.createElement("div"); box.style.cssText = "display:flex;gap:6px;align-items:center;flex:none;color:var(--text-muted,#b5bac1);font-size:13px;";
            const mk = (key) => { const inp = document.createElement("input"); inp.type = "number"; inp.min = 0; inp.max = 23; inp.value = this.settings[key]; inp.style.cssText = "width:52px;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.1);background:rgba(0,0,0,.2);color:var(--text-normal,#dbdee1);font-size:13px;text-align:center;"; inp.addEventListener("change", () => { let v = parseInt(inp.value, 10); if (isNaN(v)) v = 0; v = Math.max(0, Math.min(23, v)); this.settings[key] = v; inp.value = v; Data.save("settings", this.settings); this.schedulePump(0); }); return inp; };
            const s1 = document.createElement("span"); s1.textContent = "from"; const s2 = document.createElement("span"); s2.textContent = "to";
            box.append(s1, mk("hourStart"), s2, mk("hourEnd"));
            row.append(txt, box); wrap.appendChild(row);
        })();
        numField("dailyCap", "Max per day", "Stop after this many each day. 0 means no limit.", 0, 99, () => this.schedulePump(0));

        section("Notifications");
        toggle("notify", "Toast on each completion", "A small popup when a quest is done.");

        section("Updates");
        toggle("checkUpdates", "Check for updates automatically", "Checks GitHub now and then; if a newer version is out it offers to update and replaces itself.");
        (() => {
            const b = document.createElement("button");
            b.textContent = "Check now";
            b.style.cssText = "margin:10px 0 2px;cursor:pointer;font-size:12.5px;font-weight:600;padding:6px 12px;border:1px solid rgba(255,255,255,.15);border-radius:8px;background:transparent;color:var(--text-normal,#dbdee1);";
            b.addEventListener("click", () => { UI.showToast?.("Checking for updates", { type: "info" }); this.checkUpdate(true); });
            wrap.appendChild(b);
        })();

        const hist = document.createElement("div");
        hist.style.cssText = "margin-top:16px;font-size:12px;color:var(--text-muted,#b5bac1);line-height:1.7;";
        wrap.appendChild(hist);
        this._hist = hist;

        this._panel = wrap;
        this._render = () => {
            big.textContent = String(this.stats.completed || 0);
            small.textContent = `quests all-time  -  ${this.stats.orbs || 0} orbs earned  -  ${this.session} this session`;
            let working = [], pending = "none";
            try {
                working = [...this.processing].map(id => {
                    const q = this.QuestsStore.getQuest(id); if (!q) return null;
                    const t = this.taskOf(q); const cur = t ? this.progress(q, t.name) : 0;
                    const pct = t && t.target ? Math.min(100, Math.round(cur / t.target * 100)) : 0;
                    return `${this.questName(q)} (${pct}%)`;
                }).filter(Boolean);
                const p = this.eligibleQuests().filter(q => !this.processing.has(q.id)).map(q => this.questName(q));
                if (p.length) pending = p.join(", ");
            } catch { /* */ }
            let state;
            const now = Date.now();
            if (!this.settings.enabled) state = "Off";
            else if (working.length) state = working.join(", ");
            else if (this.settings.activeOnly && !this.isActive()) state = "Paused - you're away";
            else if (this.settings.batchRest && this.stats.nextAllowedAt && now < this.stats.nextAllowedAt && !this.hasUrgent(this.stats.nextAllowedAt))
                state = "Resting until " + new Date(this.stats.nextAllowedAt).toLocaleTimeString();
            else state = "idle - nothing to do";
            status.innerHTML = `<div><b>Status:</b> ${esc(state)}</div><div style="margin-top:2px"><b>Waiting:</b> ${esc(pending)}</div>`;
            const items = (this.stats.history || []).slice(0, 6).map(e => `${esc(e.name)}${e.orbs ? ` (+${e.orbs} orbs)` : ""} <span style="opacity:.7">- ${esc(new Date(e.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }))}</span>`).join("<br>");
            this._hist.innerHTML = items ? `<div style="font-weight:700;text-transform:uppercase;font-size:11px;letter-spacing:.04em;margin-bottom:4px">Recent</div>${items}` : "";
        };
        this._render();
        if (this.panelIv) clearInterval(this.panelIv);
        this.panelIv = setInterval(() => this.refreshPanel(), 2000);
        return wrap;
    }
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
