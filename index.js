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

const pendingImages = new Map()
const MAX_PENDING_IMAGES = 10
const PENDING_TTL_MS = 30 * 60 * 1000

const isImagePart = (p) =>
  p.type === "file" && typeof p.mime === "string" && p.mime.startsWith("image/")

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

  await log("info", "image-reader-relay loaded", { model: modelSpec, timeoutMs })

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
        const supports = !!(found?.capabilities?.attachment ?? found?.capabilities?.input?.image)
        visionCache.set(key, supports)
        return supports
      }
    } catch {
      // provider lookup failed; treat as non-vision
    }
    visionCache.set(key, false)
    return false
  }

  const relayImage = async (filePart, question) => {
    let sessionID = null
    try {
      const created = await client.session.create({ body: { title: "image-reader-relay" } })
      sessionID = created?.data?.id ?? created?.id
      if (!sessionID) throw new Error("could not create relay session")
      relaySessionIDs.add(sessionID)

      return await Promise.race([
        (async () => {
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
        })(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs),
        ),
      ])
    } finally {
      if (sessionID) {
        relaySessionIDs.delete(sessionID)
        client.session.delete({ path: { id: sessionID } }).catch(() => {})
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
          const target = entry.images[Math.min(Math.max(idx, 0), entry.images.length - 1)]
          if (!target) return "No pasted image is available in this session."
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
      if (imageParts.length === 0) return

      if (await modelSupportsImages(input.model)) {
        await log("info", "skip: model supports images", { model: input.model })
        return
      }

      prune()
      const entry = pendingImages.get(input.sessionID)
      const images = [
        ...imageParts.map((p) => ({ mime: p.mime, filename: p.filename, url: p.url })),
        ...(entry?.images ?? []),
      ].slice(0, MAX_PENDING_IMAGES)
      pendingImages.set(input.sessionID, {
        images,
        ts: Date.now(),
      })

      await log("info", "hook: stashed pasted image", {
        sessionID: input.sessionID,
        images: imageParts.length,
        total: images.length,
        model: input.model,
        textParts: parts.filter((p) => p.type === "text").length,
      })

      const count = imageParts.length
      const note =
        count > 1
          ? `[${count} images were pasted in this message. The main model cannot see them directly. Use the read_image tool to inspect them: pass the exact question you want answered about them, and imageIndex 0 for the most recent image.]`
          : "[An image was pasted in this message. The main model cannot see it directly. " +
            "Use the read_image tool to inspect it: pass the exact question you want answered " +
            "about the image, and imageIndex 0 for this (most recent) image.]"

      const result = parts.map((p) => {
        if (!isImagePart(p)) return p
        return {
          id: p.id,
          sessionID: p.sessionID ?? input.sessionID,
          messageID: p.messageID ?? input.messageID,
          type: "text",
          text: note,
        }
      })
      output.parts.splice(0, output.parts.length, ...result)

      await log("info", "hook: parts rebuilt", {
        before: parts.length,
        after: result.length,
        notes: imageParts.length,
        keptTextParts: result.filter((p) => p.type === "text" && p.text !== note).length,
      })
    },
  }
}

export default { id: "image-reader-relay", server: ImageReaderRelay }
