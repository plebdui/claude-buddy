import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Cairo from 'cairo';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {MAX_TOYS, loadToys, makeToyActor, openGiveDialog, saveArt, saveToys} from './toys.js';

const HOME = GLib.get_home_dir();
const PHRASES_PATH = GLib.build_filenamev([HOME, '.config', 'claude-buddy', 'phrases.txt']);
const CLAUDE_CONFIG_PATH = GLib.build_filenamev([HOME, '.claude.json']);
// Create this file to log where he is every few seconds (journalctl --user -b | grep claude-buddy).
const DEBUG_FLAG = GLib.build_filenamev([HOME, '.config', 'claude-buddy', 'debug']);

// Mascot size: one terminal cell, matching kitty's JetBrains Mono 9pt
// (about 7 x 17 px), so he has the same shape as the logo in your terminal.
const CELL_W = 7;
const CELL_H = 17;
const TICK_MS = 110;   // animation speed
const STEP_PX = 2;     // how far he moves each tick

// Wandering chatter: every so often he says a spinner word for a few seconds.
const TALK_TICKS = 36;                 // how long a spinner word stays up (~4 s)
const TALK_GAP_TICKS = [180, 540];     // wait between words (~20-60 s)
// Claude Code's spinner glyphs; it plays them forwards then backwards.
const SPINNER_GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽'];
const SPINNER_FRAMES = [...SPINNER_GLYPHS, ...SPINNER_GLYPHS.slice(1, -1).reverse()];

// Toys (right-click him to give one). Now and then, instead of just
// stopping for a rest, he goes off and does something with a toy:
// plays with it, carries it around for a while, or tidies it onto his pile.
const ERRAND_CHANCE = 0.5;             // of his rests that become a toy errand
const PLAY_TICKS = 50;                 // how long he plays (~5 s)
const CARRY_TICKS = [150, 450];        // how long he carries one (~15-50 s)
const PILE_AT = 0.12;                  // where his pile is, along the taskbar
const PILE_OVERLAP = 0.7;              // pile toys overlap a little

// The mascot, taken from Claude Code's own drawing code (and its colours).
// Rows are built the same way: arms + eyes, arms + body + arms, feet.
const BODY = '#D77757';
const DARK = '#000000';
const ARMS = {
    down: {r1L: ' ▐', r1R: ' ', r2L: '▝▜', r2R: '█▀'},
    up: {r1L: '▗▟', r1R: '▄', r2L: ' ▜', r2R: '█▘'},
};
// [glyphs, isLid]. Eye glyphs sit on a dark background (the dark bits are the
// eyes); lids are drawn the other way round.
const EYES = {
    open: [['▛███▛█']],
    left: [['▟███▟█']],
    right: [['█▟███▟']],
    closed: [['▂', true], ['███'], ['▂', true], ['█']],
};
const FEET = {
    both: ' ▝▝   ▝▝ ',
    left: ' ▝▝      ',
    right: '      ▝▝ ',
};
const WALK_FEET = ['left', 'both', 'right', 'both'];

// Each block character is a 2-wide x 4-tall grid of pixels (a terminal cell
// is twice as tall as it is wide). [column, row] of the filled pixels:
const UL = [[0, 0], [0, 1]], UR = [[1, 0], [1, 1]];
const LL = [[0, 2], [0, 3]], LR = [[1, 2], [1, 3]];
const GLYPH_PIXELS = {
    ' ': [], '▘': UL, '▝': UR, '▖': LL, '▗': LR,
    '▌': [...UL, ...LL], '▐': [...UR, ...LR], '▀': [...UL, ...UR], '▄': [...LL, ...LR],
    '▛': [...UL, ...UR, ...LL], '▜': [...UL, ...UR, ...LR],
    '▙': [...UL, ...LL, ...LR], '▟': [...UR, ...LL, ...LR],
    '█': [...UL, ...UR, ...LL, ...LR], '▂': [[0, 3], [1, 3]],
};
const COLS = 9, ROWS = 3;
const CLEAR = 0, ORANGE = 1, EYE = 2;
// His feet only use the top half of the last row, so drop the empty bottom.
const GRID_W = COLS * 2, GRID_H = ROWS * 4 - 2;

// Turns his block-character rows into a pixel grid with only two colours.
// kind 'body': filled = orange, empty = see-through
// kind 'eye':  filled = orange, empty = dark (that's how his eyes are cut out)
// kind 'lid':  filled = dark,   empty = orange (closed eyelids)
function drawMascot({eyes, arms, feet}) {
    const a = ARMS[arms];
    const rows = [
        [[a.r1L, 'body'], ...EYES[eyes].map(([glyphs, lid]) => [glyphs, lid ? 'lid' : 'eye']), [a.r1R, 'body']],
        [[a.r2L, 'body'], ['█████', 'eye'], [a.r2R, 'body']],
        [[FEET[feet], 'body']],
    ];

    const grid = Array.from({length: ROWS * 4}, () => new Array(COLS * 2).fill(CLEAR));
    rows.forEach((spans, row) => {
        let col = 0;
        for (const [glyphs, kind] of spans) {
            for (const glyph of glyphs) {
                if (col >= COLS)
                    break;
                const filled = new Set((GLYPH_PIXELS[glyph] ?? []).map(([x, y]) => `${x},${y}`));
                for (let y = 0; y < 4; y++) {
                    for (let x = 0; x < 2; x++) {
                        const on = filled.has(`${x},${y}`);
                        let colour = on ? ORANGE : CLEAR;
                        if (kind === 'eye' && !on)
                            colour = EYE;
                        else if (kind === 'lid')
                            colour = on ? EYE : ORANGE;
                        grid[row * 4 + y][col * 2 + x] = colour;
                    }
                }
                col++;
            }
        }
    });
    return grid.slice(0, GRID_H);
}

// Speech bubble: text on dark "terminal cells" in his mono font.
const BUBBLE_FONT_PX = 12;
const BUBBLE_WRAP = 34;     // longest line before wrapping
const BUBBLE_GAP = 4;       // px between the bubble and his head
const TEXT = '#f2f2f2';
const CELL = 'background="#141414" bgalpha="90%"';

// Wraps long lines; a literal \n in a phrase forces a line break.
function wrapText(text) {
    const lines = [];
    for (const paragraph of text.split('\\n')) {
        let line = '';
        for (const word of paragraph.trim().split(/\s+/)) {
            if (line && line.length + 1 + word.length > BUBBLE_WRAP) {
                lines.push(line);
                line = word;
            } else {
                line = line ? `${line} ${word}` : word;
            }
        }
        lines.push(line);
    }
    return lines;
}

// Minimal bubble: just the words on dark terminal cells, one space of
// padding, no border or tail. It's centred over his head.
function drawBubble(text) {
    const lines = wrapText(text);
    const width = Math.max(...lines.map(l => [...l].length));
    const columns = width + 2;
    const rows = lines.map(l => `<span foreground="${TEXT}" ${CELL}> ${
        GLib.markup_escape_text(l + ' '.repeat(width - [...l].length), -1)} </span>`);
    return {markup: rows.join('\n'), tailCol: (columns - 1) / 2, columns};
}

function timeGreeting() {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12)
        return 'Good morning';
    if (hour >= 12 && hour < 18)
        return 'Good afternoon';
    if (hour >= 18 && hour < 23)
        return 'Good evening';
    return 'Hello, night owl';
}

// Your Claude account's display name (what claude.ai greets you with), as
// Claude Code saved it. Falls back to your Linux name.
function userName() {
    try {
        const [, bytes] = GLib.file_get_contents(CLAUDE_CONFIG_PATH);
        const name = JSON.parse(new TextDecoder().decode(bytes)).oauthAccount?.displayName;
        if (name)
            return name;
    } catch (e) {
        console.warn(`claude-buddy: ${e.message}`);
    }
    const realName = GLib.get_real_name();
    return realName && realName !== 'Unknown' ? realName : GLib.get_user_name();
}

// Installed Claude Code version, from mise's "latest" link (e.g. v2.1.296).
function claudeVersion() {
    const link = GLib.build_filenamev([HOME, '.local', 'share', 'mise', 'installs', 'claude', 'latest']);
    try {
        return `v${GLib.path_get_basename(GLib.file_read_link(link))}`;
    } catch {
        return '';
    }
}

// Read ~/.config/claude-buddy/phrases.txt fresh every time, so edits show up
// straight away. [welcome] lines are for hovering, [spinner] words for wandering.
function readPhrases() {
    const sections = {welcome: [], spinner: [], toy: [], play: []};
    try {
        const [, bytes] = GLib.file_get_contents(PHRASES_PATH);
        let section = 'welcome';
        for (let line of new TextDecoder().decode(bytes).split('\n')) {
            line = line.trim();
            if (!line || line.startsWith('#'))
                continue;
            const header = line.match(/^\[(\w+)\]$/);
            if (header)
                section = header[1];
            else
                sections[section]?.push(line);
        }
    } catch (e) {
        console.warn(`claude-buddy: ${e.message}`);
    }
    return sections;
}

const randomItem = list => list[Math.floor(Math.random() * list.length)];

function welcomePhrase() {
    const line = randomItem(readPhrases().welcome) ?? '{greeting}, {name}!';
    return line
        .replaceAll('{greeting}', timeGreeting())
        .replaceAll('{name}', userName())
        .replaceAll('{version}', claudeVersion())
        .replaceAll('  ', ' ');
}

function spinnerWord() {
    return randomItem(readPhrases().spinner) ?? null;
}

// A [toy] or [play] line with {toy} and {name} filled in.
function toyPhrase(section, toy, fallback) {
    return (randomItem(readPhrases()[section]) ?? fallback)
        .replaceAll('{toy}', toy.name)
        .replaceAll('{name}', userName());
}

const clamp = (v, min, max) => Math.max(min, Math.min(v, Math.max(min, max)));

export default class ClaudeBuddyExtension extends Extension {
    enable() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // Each block character is 2 x 4 "pixels", so these are taller than wide.
        this._pixelW = CELL_W / 2 * scale;
        this._pixelH = CELL_H / 4 * scale;
        this._buddy = new St.DrawingArea({
            reactive: true,
            track_hover: true,
            width: Math.round(GRID_W * this._pixelW),
            height: Math.round(GRID_H * this._pixelH),
        });
        this._buddy.connect('repaint', area => this._paint(area));
        // If GNOME destroys him first (e.g. while logging out), stop ticking.
        this._buddy.connect('destroy', () => {
            if (this._tickId)
                GLib.source_remove(this._tickId);
            this._tickId = null;
            this._buddy = null;
        });

        this._bubble = new St.Label({
            visible: false,
            style: `font-family: "JetBrainsMono Nerd Font", monospace; font-size: ${BUBBLE_FONT_PX}px;`,
        });
        this._bubble.clutter_text.line_wrap = false;

        // No trackFullscreen: GNOME would then force both visible itself,
        // fighting the show/hide below. _tick() hides them in fullscreen.
        Main.layoutManager.addTopChrome(this._buddy);
        Main.layoutManager.addTopChrome(this._bubble);

        this._buddy.connect('notify::hover', () => this._onHover());
        this._buddy.connect('button-release-event', (_actor, event) => {
            if (event.get_button() === Clutter.BUTTON_PRIMARY)
                this._startChat();
            else if (event.get_button() === Clutter.BUTTON_SECONDARY)
                this._openGiveDialog();
            else
                return Clutter.EVENT_PROPAGATE;
            return Clutter.EVENT_STOP;
        });

        this._toys = [];
        this._carrying = null;
        this._carryTicks = 0;
        this._errand = null;
        for (const toy of loadToys())
            this._addToyActor(toy);

        this._x = 40;
        this._dir = 1;
        this._step = 0;
        this._pause = 0;
        this._idleEyes = 'open';
        this._markup = null;
        this._talkTicks = 0;
        this._debugTicks = 0;
        this._nextTalk = 90;    // first word ~10 s after login

        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
        this._tick();
    }

    // Where the taskbar is: Dash to Panel's primary panel, or GNOME's own.
    _panelRect() {
        const panels = global.dashToPanel?.panels ?? [];
        const panel = panels.find(p => p.isPrimary) ?? panels[0];
        const box = panel?.panelBox ?? Main.layoutManager.panelBox;
        if (!box.mapped)
            return null;
        const [x, y] = box.get_transformed_position();
        const [width, height] = box.get_transformed_size();
        return {x, y, width, height};
    }

    // Hide only when the window you're using is fullscreen on his monitor.
    // (GNOME's own "monitor is fullscreen" flag is also set by the Hanabi
    // live-wallpaper window, which would hide him all the time.)
    _fullscreenFocused() {
        const win = global.display.get_focus_window();
        return !!win && win.is_fullscreen() &&
            win.get_monitor() === Main.layoutManager.primaryIndex;
    }

    _tick() {
        if (!this._buddy)
            return;
        const rect = this._panelRect();
        const hidden = !rect || this._fullscreenFocused();
        if (this._debugTicks++ % 40 === 0 && GLib.file_test(DEBUG_FLAG, GLib.FileTest.EXISTS)) {
            console.log(`claude-buddy: panel=${JSON.stringify(rect)} hidden=${hidden} ` +
                `monitorFullscreen=${Main.layoutManager.primaryMonitor?.inFullscreen} ` +
                `pos=${Math.round(this._buddy.x)},${Math.round(this._buddy.y)} ` +
                `size=${this._buddy.width}x${this._buddy.height} pose=${this._markup} ` +
                `toys=${this._toys.length} errand=${this._errand?.kind ?? '-'}/${this._errand?.stage ?? '-'}`);
        }
        this._buddy.visible = !hidden;
        for (const toy of this._toys)
            toy.actor.visible = !hidden;
        if (hidden) {
            this._bubble.hide();
            this._talkTicks = 0;
            return;
        }

        let pose;
        if (this._buddy.hover) {
            // Wave while you're pointing at him.
            pose = {eyes: 'open', arms: 'up', feet: 'both'};
        } else if (this._errand) {
            pose = this._runErrand(rect);
        } else if (this._pause > 0) {
            this._pause--;
            if (Math.random() < 0.06)
                this._idleEyes = ['open', 'left', 'right', 'closed'][Math.floor(Math.random() * 4)];
            pose = {eyes: this._idleEyes, arms: this._carrying ? 'up' : 'down', feet: 'both'};
        } else {
            this._x += this._dir * STEP_PX;
            this._step++;
            const maxX = rect.width - this._buddy.width;
            if (this._x <= 0 || this._x >= maxX || Math.random() < 0.004)
                this._dir = -this._dir;
            this._x = Math.max(0, Math.min(this._x, maxX));
            if (Math.random() < 0.012 && !(Math.random() < ERRAND_CHANCE && this._startErrand())) {
                this._pause = 15 + Math.floor(Math.random() * 40);
                this._idleEyes = 'open';
            }
            pose = this._walkPose();
        }

        // Carried toys get put down again after a while.
        if (this._carrying && !this._errand && --this._carryTicks <= 0)
            this._drop('ground', rect);

        const key = `${pose.eyes}/${pose.arms}/${pose.feet}`;
        if (key !== this._markup) {
            this._grid = drawMascot(pose);
            this._buddy.queue_repaint();
            this._markup = key;
        }

        // Stand on the taskbar's top edge (or hang under it if it's at the top).
        const monitor = Main.layoutManager.primaryMonitor;
        const atTop = rect.y < monitor.y + monitor.height / 2;
        const y = atTop ? rect.y + rect.height : rect.y - this._buddy.height;
        this._buddy.set_position(Math.round(rect.x + this._x), Math.round(y));
        this._placeToys(rect, atTop);

        if (!this._buddy.hover)
            this._chatter();

        if (this._bubble.visible)
            this._placeBubble(atTop);
    }

    // While wandering, now and then show a spinner word ("✶ Pondering…")
    // with the glyph animating like Claude Code's own spinner.
    _chatter() {
        if (this._talkTicks > 0) {
            this._talkTicks--;
            if (this._talkTicks === 0) {
                this._bubble.hide();
                return;
            }
            if (this._talkWord) {
                this._spinFrame++;
                this._phrase = this._spinnerText();
            }
            return;
        }

        if (--this._nextTalk > 0)
            return;
        const [min, max] = TALK_GAP_TICKS;
        this._nextTalk = min + Math.floor(Math.random() * (max - min));
        this._talkWord = spinnerWord();
        if (!this._talkWord)
            return;
        this._talkTicks = TALK_TICKS;
        this._spinFrame = 0;
        this._phrase = this._spinnerText();
        this._bubbleSide = null;
        this._bubble.show();
    }

    // Show a fixed line (not a spinner word) for a few seconds.
    _say(text) {
        this._talkWord = null;
        this._talkTicks = TALK_TICKS;
        this._phrase = text;
        this._bubbleSide = null;
        this._bubble.show();
    }

    _spinnerText() {
        return `${SPINNER_FRAMES[this._spinFrame % SPINNER_FRAMES.length]} ${this._talkWord}…`;
    }

    _paint(area) {
        const cr = area.get_context();
        const colours = {
            [ORANGE]: [215 / 255, 119 / 255, 87 / 255],
            [EYE]: [0, 0, 0],
        };
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        this._grid?.forEach((line, y) => line.forEach((colour, x) => {
            if (colour === CLEAR)
                return;
            cr.setSourceRGB(...colours[colour]);
            // Round the edges so neighbouring pixels meet without seams.
            const x0 = Math.round(x * this._pixelW), x1 = Math.round((x + 1) * this._pixelW);
            const y0 = Math.round(y * this._pixelH), y1 = Math.round((y + 1) * this._pixelH);
            cr.rectangle(x0, y0, x1 - x0, y1 - y0);
            cr.fill();
        }));
        cr.$dispose();
    }

    _onHover() {
        if (!this._buddy.hover) {
            this._bubble.hide();
            return;
        }
        this._talkTicks = 0;    // hovering interrupts any spinner word
        this._phrase = welcomePhrase();
        this._bubbleSide = null;
        this._bubble.show();
        const rect = this._panelRect();
        const monitor = Main.layoutManager.primaryMonitor;
        this._placeBubble(rect && rect.y < monitor.y + monitor.height / 2);
    }

    _drawBubble(side, below) {
        if (this._bubbleSide === side && this._bubbleBelow === below &&
            this._bubbleText === this._phrase)
            return;
        this._bubbleSide = side;
        this._bubbleBelow = below;
        this._bubbleText = this._phrase;
        this._bubbleShape = drawBubble(this._phrase);
        this._bubble.clutter_text.set_markup(this._bubbleShape.markup);
    }

    // Centre the bubble over his head, kept on screen.
    _placeBubble(below) {
        if (!this._phrase)
            return;
        below = !!below;
        const monitor = Main.layoutManager.primaryMonitor;
        const head = this._buddy.x + this._buddy.width / 2;

        let x;
        const sides = this._bubbleSide ? [this._bubbleSide] : ['left', 'right'];
        for (const side of sides) {
            this._drawBubble(side, below);
            const [, width] = this._bubble.get_preferred_width(-1);
            const cell = width / this._bubbleShape.columns;
            x = head - (this._bubbleShape.tailCol + 0.5) * cell;
            if (x + width <= monitor.x + monitor.width - 4)
                break;
        }
        const [, width] = this._bubble.get_preferred_width(-1);
        const [, height] = this._bubble.get_preferred_height(-1);
        x = Math.max(monitor.x + 4, Math.min(x, monitor.x + monitor.width - width - 4));
        const y = below ? this._buddy.y + this._buddy.height + BUBBLE_GAP : this._buddy.y - height - BUBBLE_GAP;
        this._bubble.set_position(Math.round(x), Math.round(y));
    }

    _walkPose() {
        return {
            eyes: this._dir > 0 ? 'right' : 'left',
            arms: this._carrying ? 'up' : 'down',
            feet: WALK_FEET[Math.floor(this._step / 2) % WALK_FEET.length],
        };
    }

    // Take one step towards x. True once he's there.
    _walkTo(target) {
        const dx = target - this._x;
        if (Math.abs(dx) <= STEP_PX) {
            this._x = target;
            return true;
        }
        this._dir = Math.sign(dx);
        this._x += this._dir * STEP_PX;
        this._step++;
        return false;
    }

    // ---- Toys ----

    _toyWidth(toy) {
        return toy.actor.get_preferred_width(-1)[1];
    }

    _addToyActor(toy) {
        toy.bob = 0;
        toy.actor = makeToyActor(toy);
        Main.layoutManager.addTopChrome(toy.actor);
        // Toys sit behind him, so he walks in front of them.
        Main.layoutManager.uiGroup.set_child_below_sibling(toy.actor, this._buddy);
        // Right-click a toy to take it away.
        toy.actor.connect('button-release-event', (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;
            this._removeToy(toy);
            return Clutter.EVENT_STOP;
        });
        this._toys.push(toy);
    }

    _removeToy(toy, quiet = false) {
        if (this._carrying === toy)
            this._carrying = null;
        if (this._errand?.toy === toy)
            this._errand = null;
        this._toys = this._toys.filter(t => t !== toy);
        Main.layoutManager.removeChrome(toy.actor);
        toy.actor.destroy();
        saveToys(this._toys);
        if (!quiet)
            this._say(`✻ Bye, ${toy.name}!`);
    }

    _openGiveDialog() {
        this._bubble.hide();
        if (this._dialog)
            return;
        this._dialog = openGiveDialog((name, art) => this._giveToy(name, art));
        this._dialog.connect('closed', () => (this._dialog = null));
    }

    // You picked a drawing: it lands next to him and he plays with it.
    _giveToy(name, art) {
        if (!this._buddy)
            return;
        saveArt(name, art);
        let toy = this._toys.find(t => t.name.toLowerCase() === name.toLowerCase());
        if (toy) {
            toy.art = art;
            toy.actor.text = art;
        } else {
            const oldest = this._toys.find(t => t !== this._carrying);
            if (this._toys.length >= MAX_TOYS && oldest)
                this._removeToy(oldest, true);
            toy = {name, art, x: 0, place: 'ground'};
            this._addToyActor(toy);
            const rect = this._panelRect();
            const width = this._toyWidth(toy);
            const bw = this._buddy.width;
            toy.x = clamp(this._dir > 0 ? this._x + bw + 6 : this._x - width - 6,
                0, (rect?.width ?? 0) - width);
        }
        saveToys(this._toys);
        this._pause = 0;
        this._errand = this._carrying ? null : {kind: 'play', toy, stage: 'goto'};
        this._say(toyPhrase('toy', toy, '✻ Ooh, a {toy}!'));
    }

    // Pick a toy and something to do with it. False if there's nothing to do.
    _startErrand() {
        if (this._carrying)
            return false;
        const toy = randomItem(this._toys);
        if (!toy)
            return false;
        const kinds = toy.place === 'pile' ? ['play', 'carry'] : ['play', 'carry', 'pile'];
        this._errand = {kind: randomItem(kinds), toy, stage: 'goto'};
        return true;
    }

    _runErrand(rect) {
        const e = this._errand;
        const bw = this._buddy.width;
        const tw = this._toyWidth(e.toy);
        const maxX = rect.width - bw;

        if (e.stage === 'goto') {
            // To play he stands beside the toy; to pick it up he stands on it.
            let target = e.toy.x + tw / 2 - bw / 2;
            if (e.kind === 'play')
                target = this._x + bw / 2 < e.toy.x + tw / 2 ? e.toy.x - bw + 2 : e.toy.x + tw - 2;
            if (!this._walkTo(clamp(target, 0, maxX)))
                return this._walkPose();
            if (e.kind === 'play') {
                e.stage = 'play';
                e.ticks = PLAY_TICKS;
                this._dir = e.toy.x + tw / 2 > this._x + bw / 2 ? 1 : -1;
                if (Math.random() < 0.4 && !this._bubble.visible)
                    this._say(toyPhrase('play', e.toy, '✻ Wheee!'));
            } else {
                this._pickUp(e.toy);
                if (e.kind === 'carry') {
                    const [min, max] = CARRY_TICKS;
                    this._carryTicks = min + Math.floor(Math.random() * (max - min));
                    this._errand = null;
                } else {
                    e.stage = 'topile';
                }
            }
            return this._walkPose();
        }

        if (e.stage === 'play') {
            // Bounce the toy and wave his arms.
            const up = Math.floor(--e.ticks / 4) % 2 === 0;
            e.toy.bob = up ? 3 : 0;
            if (e.ticks <= 0) {
                e.toy.bob = 0;
                this._errand = null;
                this._pause = 10;
            }
            return {eyes: this._dir > 0 ? 'right' : 'left', arms: up ? 'up' : 'down', feet: 'both'};
        }

        // 'topile': carry it over to the pile and put it down.
        const target = this._pileEnd(rect) + tw / 2 - bw / 2;
        if (this._walkTo(clamp(target, 0, maxX))) {
            this._drop('pile', rect);
            this._errand = null;
            this._pause = 20;
        }
        return this._walkPose();
    }

    // Where the next toy on the pile goes.
    _pileEnd(rect) {
        let x = rect.width * PILE_AT;
        for (const toy of this._toys) {
            if (toy.place === 'pile')
                x += this._toyWidth(toy) * PILE_OVERLAP;
        }
        return x;
    }

    _pickUp(toy) {
        toy.place = 'carried';
        this._carrying = toy;
        // Held toys go in front of him.
        Main.layoutManager.uiGroup.set_child_above_sibling(toy.actor, this._buddy);
    }

    _drop(place, rect) {
        const toy = this._carrying;
        this._carrying = null;
        const width = this._toyWidth(toy);
        if (place === 'pile')
            toy.x = this._pileEnd(rect);
        else
            toy.x = clamp(this._x + this._buddy.width / 2 - width / 2, 0, rect.width - width);
        toy.place = place;
        Main.layoutManager.uiGroup.set_child_below_sibling(toy.actor, this._buddy);
        saveToys(this._toys);
    }

    _placeToys(rect, atTop) {
        // Pile toys sit side by side, overlapping a bit.
        let pileX = rect.width * PILE_AT;
        for (const toy of this._toys) {
            const width = this._toyWidth(toy);
            const [, height] = toy.actor.get_preferred_height(-1);
            if (toy.place === 'pile') {
                toy.x = pileX;
                pileX += width * PILE_OVERLAP;
            }
            let x, y;
            if (toy.place === 'carried') {
                // Held up over his head (or under him if the bar is at the top).
                x = this._buddy.x + this._buddy.width / 2 - width / 2;
                y = atTop ? this._buddy.y + this._buddy.height - 2 : this._buddy.y - height + 4;
            } else {
                toy.x = clamp(toy.x, 0, rect.width - width);
                x = rect.x + toy.x;
                y = atTop ? rect.y + rect.height + toy.bob : rect.y - height - toy.bob;
            }
            toy.actor.set_position(Math.round(x), Math.round(y));
        }
    }

    _startChat() {
        this._bubble.hide();
        const claude = GLib.find_program_in_path('claude') ??
            GLib.build_filenamev([HOME, '.local', 'share', 'mise', 'installs', 'claude', 'latest', 'claude']);
        try {
            const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
            launcher.set_cwd(HOME);
            const proc = launcher.spawnv(['xdg-terminal-exec', claude]);
            proc.wait_async(null, null);
        } catch (e) {
            Main.notifyError('Claude Buddy', `Couldn't start Claude Code: ${e.message}`);
        }
    }

    disable() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = null;
        this._dialog?.close();
        this._dialog = null;
        if (this._toys?.length)
            saveToys(this._toys);
        for (const actor of [this._buddy, this._bubble, ...(this._toys ?? []).map(t => t.actor)]) {
            if (!actor)
                continue;
            Main.layoutManager.removeChrome(actor);
            actor.destroy();
        }
        this._buddy = null;
        this._bubble = null;
        this._toys = [];
        this._carrying = null;
        this._errand = null;
    }
}
