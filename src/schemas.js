const { z } = require('zod')

const urlString = z
  .string()
  .trim()
  .url({ message: 'Must be a valid URL' })
  .max(2048)

/** Empty string allowed; if non-empty, must be a valid http(s) URL. */
const optionalUrl = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (val) => {
      if (val === '') return true
      try {
        const u = new URL(val)
        return u.protocol === 'http:' || u.protocol === 'https:'
      } catch {
        return false
      }
    },
    { message: 'Must be a valid URL when provided' },
  )

exports.teamSubmissionSchema = z
  .object({
    teamName: z.string().trim().min(1).max(120),
    leaderName: z.string().trim().min(1).max(120),
    leaderContact: z.string().trim().min(8).max(32),
    githubLink: urlString,
    pptLink: optionalUrl,
    deployedLink: optionalUrl,
  })
  .superRefine((data, ctx) => {
    const hasPpt = data.pptLink.length > 0
    const hasDep = data.deployedLink.length > 0
    if (hasPpt || hasDep) return
    const msg = 'Provide at least a presentation link or a deployed app link.'
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg, path: ['pptLink'] })
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg, path: ['deployedLink'] })
  })

exports.loginSchema = z.object({
  accessKey: z.string().min(1).max(512).transform((s) => s.trim()),
})

exports.entryLookupSchema = z.object({
  teamName: z.string().trim().min(1).max(120),
  leaderContact: z.string().trim().min(8).max(32),
})
