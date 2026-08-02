# image-reader-relay

Kilo / opencode plugin that lets **text-only models read pasted images** via a vision-capable model.

When you paste an image into a session whose main model cannot see images, the plugin:

1. **Stashes the image in memory** (never writes to disk). The image stays visible in the chat exactly as you pasted it.
2. Injects a note into the **model's context only** — the model sees `[An image was pasted... Use the read_image tool...]` while you still see the image and your text in the UI.
3. Registers a **`read_image` tool** the main model can call with its own question.
4. Relays the image to a configured **vision model** in a throwaway session, cleans up, and returns the answer as a tool result.

For models that support images natively, the plugin does nothing — the image stays intact.

## Install

Add the plugin to your config (`kilo.json` in a project, or global `~/.config/kilo/kilo.jsonc`):

```jsonc
{
  "plugin": [
    ["massiveits/image-reader-relay", { "model": "clinepass/cline-pass/mimo-v2.5" }]
  ]
}
```

## Options

| Option       | Type     | Default                            | Description                             |
| ------------ | -------- | ---------------------------------- | --------------------------------------- |
| `model`      | `string` | `clinepass/cline-pass/mimo-v2.5`   | Vision model used to read images. `provider/modelID` format. |
| `timeoutMs`  | `number` | `60000`                            | Max time a relay call may take.         |

The model can also be set with the environment variable `IMAGE_READER_MODEL` (takes priority over the `model` option).

Changing the model later is just editing the `model` option — no plugin file changes.

## How it works

- `chat.message` hook detects image parts and stashes them per session (last 10 images, 30-minute expiry; vision-capable models are skipped).
- `experimental.chat.messages.transform` swaps pasted images for a note in the model's context only — the stored message (and the UI) keeps the images and your text untouched.
- `read_image` tool (`question` + optional `imageIndex`, 0 = most recent) sends the image with a system prompt to the configured vision model and returns its answer.
- Everything is in-memory: the relayed image never touches the filesystem.
- A throwaway session is created per call and deleted afterwards.

## Requirements

- A main model that supports tool calls (any Kilo model).
- Access to the configured vision model through one of your providers.
