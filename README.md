# Claude Buddy

A little Claude Code mascot that lives on your GNOME taskbar. He wanders back and
forth, says Claude Code's spinner words ("✶ Pondering…") now and then, greets you
by name when you hover over him, and opens Claude Code when you click him.

**Toys:** right-click him to give him a toy. Type anything ("a kite", "a tiny
piano") and a local model running in [LM Studio](https://lmstudio.ai) draws a few
ASCII versions for you to pick from. He'll carry toys around, pile them up and
play with them. Right-click a toy to take it away.

## Install

Needs GNOME Shell 48–50. For toys you'll also need LM Studio with a small chat
model; quick "instruct" models work best. Big "thinking" models spend their
whole answer thinking and never get to the drawing.

```sh
git clone https://github.com/pebdui/claude-buddy.git ~/claude-buddy
~/claude-buddy/install.sh
```

Then log out and back in, and run `gnome-extensions enable claude-buddy@machine_face`.

## Customize

- `~/.config/claude-buddy/phrases.txt`: what he says. Changes show up immediately.
- `~/.config/claude-buddy/model.txt`: put an LM Studio model id here to choose
  which model draws toys.
- `~/.config/claude-buddy/toys/*.txt`: the saved drawings. Edit one to fix a toy.
