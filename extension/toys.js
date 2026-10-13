// Toys for Claude Buddy: saving them, drawing them, and the "give a toy"
// popup that asks your local LM Studio model to draw one.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

const HOME = GLib.get_home_dir();
const BUDDY_DIR = GLib.build_filenamev([HOME, '.config', 'claude-buddy']);
// One drawing per toy, e.g. toys/rubber-duck.txt. Edit these to fix a drawing.
const TOYS_DIR = GLib.build_filenamev([BUDDY_DIR, 'toys']);
// Which toys are out on the taskbar right now, and where.
const TOYS_LIST = GLib.build_filenamev([BUDDY_DIR, 'toys.json']);
// Helper script that talks to LM Studio (in ~/.local/bin).
const CRAFT = GLib.build_filenamev([HOME, '.local', 'bin', 'claude-buddy-craft']);

export const MAX_TOYS = 6;
const TOY_FONT_PX = 10;
const MONO = '"JetBrainsMono Nerd Font", monospace';
// Each toy gets one of these colours, picked from its name.
const COLOURS = ['#e5c07b', '#61afef', '#98c379', '#c678dd', '#56b6c2', '#e06c75', '#d19a66', '#f2f2f2'];
const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

export function slug(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'toy';
}

function colourFor(name) {
    let hash = 0;
    for (const c of name)
        hash = (hash * 31 + c.codePointAt(0)) >>> 0;
    return COLOURS[hash % COLOURS.length];
}

function readText(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
}

function artPath(name) {
    return GLib.build_filenamev([TOYS_DIR, `${slug(name)}.txt`]);
}

export function saveArt(name, art) {
    GLib.mkdir_with_parents(TOYS_DIR, 0o755);
    GLib.file_set_contents(artPath(name), `${art}\n`);
}

// Toys that were out last time: [{name, art, x, place}]. place is 'ground'
// or 'pile'. A toy whose drawing file was deleted is skipped.
export function loadToys() {
    let list = [];
    try {
        list = JSON.parse(readText(TOYS_LIST) ?? '[]');
    } catch (e) {
        console.warn(`claude-buddy: toys.json: ${e.message}`);
    }
    const toys = [];
    for (const {name, x, place} of list) {
        const art = readText(artPath(name))?.replace(/\n+$/, '');
        if (art)
            toys.push({name, art, x: x ?? 0, place: place === 'pile' ? 'pile' : 'ground'});
    }
    return toys.slice(-MAX_TOYS);
}

export function saveToys(toys) {
    // A toy he's holding gets saved as lying where he is.
    const list = toys.map(({name, x, place}) =>
        ({name, x: Math.round(x), place: place === 'pile' ? 'pile' : 'ground'}));
    try {
        GLib.mkdir_with_parents(BUDDY_DIR, 0o755);
        GLib.file_set_contents(TOYS_LIST, `${JSON.stringify(list, null, 1)}\n`);
    } catch (e) {
        console.warn(`claude-buddy: ${e.message}`);
    }
}

export function makeToyActor(toy) {
    const label = new St.Label({
        text: toy.art,
        reactive: true,
        style: `font-family: ${MONO}; font-size: ${TOY_FONT_PX}px; color: ${colourFor(toy.name)};` +
            ' text-shadow: 0 0 2px rgba(0, 0, 0, 0.9);',
    });
    label.clutter_text.line_wrap = false;
    return label;
}

// "a rubber duck" -> "rubber duck", so he can say "Ooh, a rubber duck!"
function cleanName(text) {
    return text.trim().replace(/^(a|an|the|some|my)\s+/i, '').replace(/\s+/g, ' ');
}

// The right-click popup: type a toy, the model draws a few versions, you
// pick the one you like. onChosen(name, art) is called with your pick.
export function openGiveDialog(onChosen) {
    const dialog = new ModalDialog.ModalDialog({styleClass: 'claude-buddy-dialog'});
    let proc = null;
    let spinId = 0;
    let closed = false;

    const box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style: 'spacing: 14px; min-width: 380px;',
    });
    box.add_child(new St.Label({
        text: 'Give Claude a toy',
        style: 'font-weight: bold; font-size: 16px;',
    }));
    const entry = new St.Entry({
        hint_text: 'a rubber duck, a kite, a tiny piano…',
        can_focus: true,
        x_expand: true,
    });
    box.add_child(entry);
    const status = new St.Label({visible: false, style: `font-family: ${MONO};`});
    box.add_child(status);
    const choices = new St.BoxLayout({visible: false, style: 'spacing: 10px;'});
    box.add_child(choices);
    dialog.contentLayout.add_child(box);

    const close = () => dialog.close();
    const cancelButton = {label: 'Cancel', action: close, key: Clutter.KEY_Escape};

    const stopSpinner = () => {
        if (spinId)
            GLib.source_remove(spinId);
        spinId = 0;
    };

    const showChoices = (name, result) => {
        stopSpinner();
        const options = result.options ?? [];
        if (!options.length) {
            status.text = `✗ Couldn't draw one${result.error ? `: ${result.error}` : '.'}`;
            dialog.setButtons([cancelButton, {label: 'Try again', action: () => craft(true)}]);
            return;
        }
        status.text = `Pick a ${name}:`;
        for (const art of options) {
            const button = new St.Button({
                style_class: 'button',
                can_focus: true,
                style: 'padding: 10px 12px;',
                child: new St.Label({
                    text: art,
                    style: `font-family: ${MONO}; font-size: 12px; color: ${colourFor(name)};`,
                }),
            });
            button.connect('clicked', () => {
                onChosen(name, art);
                close();
            });
            choices.add_child(button);
        }
        choices.show();
        choices.get_first_child().grab_key_focus();
        dialog.setButtons([cancelButton, {label: '↻ Draw more', action: () => craft(true)}]);
    };

    // Runs claude-buddy-craft in the background so the desktop never freezes.
    const craft = skipSaved => {
        const name = cleanName(entry.get_text());
        if (!name || proc)
            return;
        entry.text = name;
        choices.destroy_all_children();
        choices.hide();
        status.show();
        let frame = 0;
        const spin = () => {
            status.text = `${SPINNER[frame++ % SPINNER.length]} Crafting a ${name}…`;
            return GLib.SOURCE_CONTINUE;
        };
        spin();
        stopSpinner();
        spinId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, spin);
        dialog.setButtons([cancelButton]);

        const argv = [CRAFT, '--count', '4', ...(skipSaved ? ['--skip-saved'] : []), '--', name];
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            showChoices(name, {error: e.message});
            return;
        }
        proc.communicate_utf8_async(null, null, (p, res) => {
            proc = null;
            if (closed)
                return;
            let result;
            try {
                const [, out] = p.communicate_utf8_finish(res);
                result = JSON.parse(out);
            } catch (e) {
                result = {error: e.message};
            }
            showChoices(name, result);
        });
    };

    entry.clutter_text.connect('activate', () => craft(false));
    dialog.setButtons([cancelButton, {label: 'Craft', action: () => craft(false)}]);
    dialog.connect('closed', () => {
        closed = true;
        stopSpinner();
        proc?.force_exit();
    });
    dialog.setInitialKeyFocus(entry);
    dialog.open();
    return dialog;
}
