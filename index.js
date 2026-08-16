import { appendFile, readFile, stat } from "node:fs/promises"
import { resolve } from "node:path"

const DEFAULT_MODEL = "clinepass/cline-pass/mimo-v2.5"
const PLUGIN_VERSION = "1.1.4"
const DEBUG_LOG = "/tmp/image-reader-relay-debug.log"

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
  if (!indices || indices.length === 0) {
    return count > 1
      ? `[image-reader-relay v${PLUGIN_VERSION}] ${count} images were pasted in this message. The main model cannot see them directly, and they are no longer available for inspection.`
      : `[image-reader-relay v${PLUGIN_VERSION}] An image was pasted in this message. The main model cannot see it directly, and it is no longer available for inspection.`
  }
  const indexText =
    indices.length === 1
      ? `imageIndex ${indices[0]}`
      : `imageIndex ${indices.join(" or ")}`
  return count > 1
    ? `[image-reader-relay v${PLUGIN_VERSION}] ${count} images were pasted in this message. The main model cannot see them directly. Use the read_image tool to inspect them: pass the exact question you want answered about them, and ${indexText}.`
    : `[image-reader-relay v${PLUGIN_VERSION}] An image was pasted in this message. The main model cannot see it directly. ` +
      `Use the read_image tool to inspect it: pass the exact question you want answered about the image, and ${indexText}.`
}

const parseModel = (spec) => {
  const idx = spec.indexOf("/")
  if (idx <= 0 || idx === spec.length - 1) {
    throw new Error(`invalid model spec "${spec}", expected "provider/modelID"`)
  }
  return { providerID: spec.slice(0, idx), modelID: spec.slice(idx + 1) }
}

const IMAGE_MIME_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  avif: "image/avif",
}
const MAX_FILE_BYTES = 20 * 1024 * 1024

const filePartFromPath = async (filePath, baseDir) => {
  const abs = resolve(baseDir ?? process.cwd(), filePath)
  const ext = abs.split(".").pop().toLowerCase()
  const mime = IMAGE_MIME_BY_EXT[ext]
  if (!mime) throw new Error(`unsupported image type ".${ext}" for "${filePath}"`)
  const info = await stat(abs).catch(() => null)
  if (!info || !info.isFile()) throw new Error(`file not found: "${filePath}"`)
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(`file too large: ${info.size} bytes (max ${MAX_FILE_BYTES})`)
  }
  const data = await readFile(abs)
  return {
    type: "file",
    mime,
    filename: abs.split("/").pop(),
    url: `data:${mime};base64,${data.toString("base64")}`,
  }
}

const makeToolNote = (count) =>
  count > 1
    ? `[image-reader-relay v${PLUGIN_VERSION}] ${count} images appear in this message. The main model cannot see them directly. Use the read_image tool with the filePath argument to inspect them.`
    : `[image-reader-relay v${PLUGIN_VERSION}] An image appears in this message. The main model cannot see it directly. Use the read_image tool with its filePath argument to inspect it.`

const writeDebug = async (event, data = {}) => {
  try {
    await appendFile(
      DEBUG_LOG,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        version: PLUGIN_VERSION,
        event,
        ...data,
      })}\n`,
    )
  } catch {
    // Diagnostics must never affect plugin behavior.
  }
}

const ImageReaderRelay = async ({ client }, rawOptions) => {
  const options = rawOptions ?? {}
  const modelSpec = process.env.IMAGE_READER_MODEL ?? options.model ?? DEFAULT_MODEL
  const timeoutMs = options.timeoutMs ?? 60_000

  await writeDebug("loaded", { modelSpec })

  const log = (level, message, extra) =>
    client.app.log({ body: { service: "image-reader-relay", level, message, extra } })

  await log("info", "image-reader-relay v11 loaded (images stay in chat)", {
    model: modelSpec,
    timeoutMs,
  })

  const modelSupportsImages = async (model) => {
    if (!model) return false
    const key = `${model.providerID}/${model.modelID}`
    if (visionCache.has(key)) return visionCache.get(key)
    const describeCapabilities = (value) => ({
      keys: value && typeof value === "object" ? Object.keys(value) : [],
      input: value?.input,
      attachment: value?.attachment,
      modalities: value?.modalities,
    })
    await log("info", "checking model image capability", {
      model: {
        providerID: model.providerID,
        modelID: model.modelID,
        keys: Object.keys(model),
        capabilities: describeCapabilities(model.capabilities),
      },
    })
    await writeDebug("checking-model", {
      model: {
        providerID: model.providerID,
        modelID: model.modelID,
        keys: Object.keys(model),
        capabilities: describeCapabilities(model.capabilities),
        modalities: model.modalities,
      },
    })
    const directCapabilities = model.capabilities
    if (directCapabilities) {
      const supports = !!(
        directCapabilities.input?.image ||
        directCapabilities.attachment
      )
      visionCache.set(key, supports)
      await writeDebug("direct-result", { supportsImages: supports })
      return supports
    }
    const cacheNegative = () => {
      visionCache.set(key, false)
      setTimeout(() => visionCache.delete(key), 60_000)
    }
    try {
      const res = await client.config.providers()
      const providers = res?.data?.providers ?? res?.providers ?? []
      for (const provider of providers) {
        if (provider.id !== model.providerID) continue
        const found = (provider.models ?? []).find((m) => m.id === model.modelID)
        if (found) {
          const supports = !!(
            found?.capabilities?.input?.image ||
            found?.capabilities?.attachment
          )
          await log("info", "resolved model image capability", {
            model: `${model.providerID}/${model.modelID}`,
            capabilities: describeCapabilities(found.capabilities),
            supportsImages: supports,
          })
          visionCache.set(key, supports)
          await writeDebug("provider-result", {
            capabilities: describeCapabilities(found.capabilities),
            supportsImages: supports,
          })
          return supports
        }
      }
    } catch {
      // provider lookup failed
    }
    cacheNegative()
    await writeDebug("negative-result", { supportsImages: false })
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
        Promise.race([prompt, new Promise((r) => setTimeout(r, timeoutMs))])
          .catch(() => {})
          .finally(cleanup)
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
          "Inspect an image the user pasted in this session, or an image file on disk. The main model cannot see images directly, so call this tool whenever the conversation requires knowing what an image contains. Pass the exact question you want answered about the image. For an image pasted in this session, omit filePath (or pass an empty string) and pass imageIndex (0 = most recent). Pass filePath ONLY to read an image file from disk (e.g. a tool's screenshot).",
        args: {
          question: {
            type: "string",
            description: "The specific question to answer about the image",
          },
          filePath: {
            type: "string",
            description: "Absolute path to an image file on disk. Omit, or pass an empty string, to use a pasted image instead.",
          },
          imageIndex: {
            type: "number",
            description: "Which pasted image to read: 0 = most recent (default).",
          },
        },
        async execute(args, ctx) {
          const question = String(args?.question ?? "").trim() || "Describe the image plainly."
          const filePathArg = typeof args?.filePath === "string" ? args.filePath.trim() : ""
          const entry = () => {
            prune(ctx.sessionID)
            return pendingImages.get(ctx.sessionID)
          }
          const pastedImage = (idx) => {
            const e = entry()
            if (!e || e.images.length === 0) return null
            if (!Number.isInteger(idx) || idx < 0 || idx >= e.images.length) return null
            return e.images[idx]
          }

          let filePart
          try {
            if (filePathArg !== "") {
              try {
                filePart = await filePartFromPath(filePathArg, ctx.directory)
              } catch (err) {
                const fallback = pastedImage(args?.imageIndex ?? 0)
                if (fallback) {
                  filePart = fallback
                } else {
                  const e = entry()
                  const avail =
                    e && e.images.length > 0
                      ? ` Available pasted images: 0-${e.images.length - 1}.`
                      : " No pasted image is available in this session."
                  return `[Image Reader] "${filePathArg}" is not a readable image file (${String(err)}).${avail}`
                }
              }
            } else {
              const idx = args?.imageIndex ?? 0
              const pasted = pastedImage(idx)
              if (!pasted) {
                const e = entry()
                if (!e || e.images.length === 0) {
                  return "No pasted image is available in this session (none found, or it expired). Pass filePath to read an image from disk instead."
                }
                return `No pasted image at imageIndex ${idx}. Available: 0-${e.images.length - 1} (0 = most recent).`
              }
              filePart = pasted
            }
          } catch (err) {
            return `[Image Reader] ${String(err)}`
          }
          try {
            const answer = await relayImage(filePart, question)
            if (!answer) return "[Image Reader] The subagent returned no answer."
            return `[Image Reader] Answer about the image:\n\n${answer}`
          } catch (err) {
            const message = String(err)
            await log("error", "read_image relay failed", { sessionID: ctx.sessionID, error: message })
            return `[Image Reader] Failed to read the image: ${message}`
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
      for (const [mid, idxs] of byMessage) {
        const kept = idxs.filter((i) => i < images.length)
        if (kept.length === 0) byMessage.delete(mid)
        else byMessage.set(mid, kept)
      }
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
        const role = message?.info?.role
        const isUser = role === "user" || role === "local"
        if (!isUser && role !== "assistant" && role !== "tool") continue

        const model = sessionModels.get(sessionID)
        if (model && (await modelSupportsImages(model))) continue

        const parts = message.parts
        if (!Array.isArray(parts)) continue
        const imageParts = parts.filter(isImagePart)
        if (imageParts.length === 0) continue

        const stashEntry = pendingImages.get(sessionID)
        const indices = isUser ? stashEntry?.byMessage?.get(message.info.id) : undefined
        const note = isUser ? makeNote(imageParts.length, indices) : makeToolNote(imageParts.length)
        parts.splice(
          0,
          parts.length,
          ...parts.filter((p) => !isImagePart(p)),
          { type: "text", text: note },
        )

        await log("info", "transform: swapped images for note (model view only)", {
          sessionID,
          role,
          images: imageParts.length,
        })
      }
    },
  }
}

export default { id: "image-reader-relay", server: ImageReaderRelay }
