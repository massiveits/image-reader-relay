const DEFAULT_MODEL = "clinepass/cline-pass/mimo-v2.5"

const IMAGE_READER_SYSTEM_PROMPT = `You are a vision-capable image reader agent. Your only job is to read images and report what you see.

How to work:
1. The attached image is visible to you in your context.
2. Answer the user's question plainly and completely, based only on what is actually visible in the image.

Rules:
- Describe what is actually in the image. Do not infer, guess, or embellish details you cannot see.
- If the question asks for text in the image, transcribe it verbatim, exactly as written, including typos.
- If part of the image is unreadable, blurry, or cut off, say so instead of guessing.
- Keep the answer conversational and direct. No markdown tables, no JSON, no structured formats unless explicitly asked.`

const relaySessionIDs = new Set()
const visionCache = new Map()
const sessionModels = new Map()

const pendingImages = new Map()
const MAX_PENDING_IMAGES = 10
const PENDING_TTL_MS = 30 * 60 * 1000

const isImagePart = (p) =>
  p.type === "file" && typeof p.mime === "string" && p.mime.startsWith("image/")

const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

const newPartID = () => {
  const now = BigInt(Date.now() + 1) * BigInt(0x1000) + 1n
  let hex = ""
  for (let i = 0; i < 6; i++) {
    const b = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff))
    hex += b.toString(16).padStart(2, "0")
  }
  let r = ""
  const bytes = crypto.getRandomValues(new Uint8Array(14))
  for (let i = 0; i < 14; i++) r += ID_CHARS[bytes[i] % 62]
  return `prt_${hex}${r}`
}

const makeNote = (count, indices) => {
  const indexText =
    indices && indices.length > 0
      ? indices.length === 1
        ? `imageIndex ${indices[0]}`
        : `imageIndex ${indices.join(" or ")}`
      : "imageIndex 0 for the most recent image"
  return count > 1
    ? `[${count} images were pasted in this message. The main model cannot see them directly. Use the read_image tool to inspect them: pass the exact question you want answered about them, and ${indexText}.]`
    : "[An image was pasted in this message. The main model cannot see it directly. " +
      `Use the read_image tool to inspect it: pass the exact question you want answered about the image, and ${indexText}.]`
}

const parseModel = (spec) => {
  const idx = spec.indexOf("/")
  if (idx <= 0 || idx === spec.length - 1) {
    throw new Error(`invalid model spec "${spec}", expected "provider/modelID"`)
  }
  return { providerID: spec.slice(0, idx), modelID: spec.slice(idx + 1) }
}

const ImageReaderRelay = async ({ client }, rawOptions) => {
  const options = rawOptions ?? {}
  const modelSpec = process.env.IMAGE_READER_MODEL ?? options.model ?? DEFAULT_MODEL
  const timeoutMs = options.timeoutMs ?? 60_000

  const log = (level, message, extra) =>
    client.app.log({ body: { service: "image-reader-relay", level, message, extra } })

  await log("info", "image-reader-relay v7 loaded (images stay in chat)", {
    model: modelSpec,
    timeoutMs,
  })

  const modelSupportsImages = async (model) => {
    if (!model) return false
    const key = `${model.providerID}/${model.modelID}`
    if (visionCache.has(key)) return visionCache.get(key)
    try {
      const res = await client.config.providers()
      const providers = res?.data?.providers ?? res?.providers ?? []
      for (const provider of providers) {
        if (provider.id !== model.providerID) continue
        const found = (provider.models ?? []).find((m) => m.id === model.modelID)
        if (found) {
          const supports = !!(found?.capabilities?.attachment ?? found?.capabilities?.input?.image)
          visionCache.set(key, supports)
          return supports
        }
      }
    } catch {
      // provider lookup failed; treat as non-vision and retry on the next message (not cached)
    }
    return false
  }

  const relayImage = async (filePart, question) => {
    const created = await client.session.create({ body: { title: "image-reader-relay" } })
    const sessionID = created?.data?.id ?? created?.id
    if (!sessionID) throw new Error("could not create relay session")
    relaySessionIDs.add(sessionID)

    const prompt = (async () => {
      const res = await client.session.prompt({
        path: { id: sessionID },
        body: {
          model: parseModel(modelSpec),
          system: IMAGE_READER_SYSTEM_PROMPT,
          parts: [
            { type: "file", mime: filePart.mime, filename: filePart.filename, url: filePart.url },
            { type: "text", text: `Answer this question about the attached image:\n\n${question}` },
          ],
        },
      })
      const parts = res?.data?.parts ?? res?.parts ?? []
      return parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n")
        .trim()
    })()

    const cleanup = () => {
      relaySessionIDs.delete(sessionID)
      client.session.delete({ path: { id: sessionID } }).catch(() => {})
    }

    let timedOut = false
    try {
      return await Promise.race([
        prompt,
        new Promise((_, reject) =>
          setTimeout(() => {
            timedOut = true
            client.session.abort({ path: { id: sessionID } }).catch(() => {})
            reject(new Error(`timed out after ${timeoutMs}ms`))
          }, timeoutMs),
        ),
      ])
    } finally {
      if (timedOut) {
        prompt.catch(() => {}).finally(cleanup)
      } else {
        cleanup()
      }
    }
  }

  const prune = (sessionID) => {
    const now = Date.now()
    if (sessionID) {
      const entry = pendingImages.get(sessionID)
      if (entry && now - entry.ts > PENDING_TTL_MS) pendingImages.delete(sessionID)
      return
    }
    for (const [sid, entry] of pendingImages) {
      if (now - entry.ts > PENDING_TTL_MS) pendingImages.delete(sid)
    }
  }

  return {
    tool: {
      read_image: {
        description:
          "Inspect an image the user pasted in this session. The main model cannot see pasted images directly, so call this tool whenever the conversation requires knowing what an image contains. Pass the exact question you want answered about the image.",
        args: {
          question: {
            type: "string",
            description: "The specific question to answer about the pasted image",
          },
          imageIndex: {
            type: "number",
            description: "Which pasted image to read: 0 = most recent (default).",
          },
        },
        async execute(args, ctx) {
          prune(ctx.sessionID)
          const entry = pendingImages.get(ctx.sessionID)
          if (!entry || entry.images.length === 0) {
            return "No pasted image is available in this session (none found, or it expired)."
          }
          const idx = args?.imageIndex ?? 0
          if (!Number.isInteger(idx) || idx < 0 || idx >= entry.images.length) {
            return `No pasted image at imageIndex ${idx}. Available: 0-${entry.images.length - 1} (0 = most recent).`
          }
          const target = entry.images[idx]
          const question = String(args?.question ?? "").trim() || "Describe the image plainly."
          try {
            const answer = await relayImage(target, question)
            if (!answer) return "[Image Reader] The subagent returned no answer."
            return `[Image Reader] Answer about the pasted image:\n\n${answer}`
          } catch (err) {
            const message = String(err)
            await log("error", "read_image relay failed", { sessionID: ctx.sessionID, error: message })
            return `[Image Reader] Failed to read the pasted image: ${message}`
          }
        },
      },
    },
    "chat.message": async (input, output) => {
      if (relaySessionIDs.has(input.sessionID)) return

      const parts = output.parts
      const imageParts = parts.filter(isImagePart)
      if (imageParts.length === 0) {
        sessionModels.set(input.sessionID, input.model)
        return
      }

      sessionModels.set(input.sessionID, input.model)

      if (await modelSupportsImages(input.model)) {
        await log("info", "skip: model supports images", { model: input.model })
        return
      }

      prune()
      const entry = pendingImages.get(input.sessionID)
      const incoming = imageParts.map((p) => ({ mime: p.mime, filename: p.filename, url: p.url }))
      const byMessage = new Map()
      if (entry?.byMessage) {
        for (const [mid, idxs] of entry.byMessage) {
          byMessage.set(mid, idxs.map((i) => i + incoming.length))
        }
      }
      byMessage.set(input.messageID, incoming.map((_, i) => i))
      const images = [...incoming, ...(entry?.images ?? [])].slice(0, MAX_PENDING_IMAGES)
      pendingImages.set(input.sessionID, {
        images,
        byMessage,
        ts: Date.now(),
      })

      await log("info", "hook: stashed pasted image (kept in chat)", {
        sessionID: input.sessionID,
        images: imageParts.length,
        total: images.length,
        model: input.model,
      })
    },
    "experimental.chat.messages.transform": async (input, output) => {
      for (const message of output.messages ?? []) {
        const sessionID = message?.info?.sessionID
        if (sessionID && relaySessionIDs.has(sessionID)) continue
        if (message?.info?.role !== "user" && message?.info?.role !== "local") continue

        const model = sessionModels.get(sessionID)
        if (model && (await modelSupportsImages(model))) continue

        const parts = message.parts
        if (!Array.isArray(parts)) continue
        const imageParts = parts.filter(isImagePart)
        if (imageParts.length === 0) continue

        const stashEntry = pendingImages.get(sessionID)
        const indices = stashEntry?.byMessage?.get(message.info.id)
        const note = makeNote(imageParts.length, indices)
        parts.splice(
          0,
          parts.length,
          ...parts.filter((p) => !isImagePart(p)),
          { type: "text", text: note },
        )

        await log("info", "transform: swapped images for note (model view only)", {
          sessionID,
          images: imageParts.length,
        })
      }
    },
  }
}

export default { id: "image-reader-relay", server: ImageReaderRelay }
