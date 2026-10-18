export const releaseMarkdownClass = `
  text-xs text-muted-foreground leading-relaxed
  [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:text-foreground [&_h1]:mb-2 [&_h1]:mt-3 [&_h1:first-child]:mt-0
  [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-foreground [&_h2]:mb-1.5 [&_h2]:mt-3 [&_h2:first-child]:mt-0
  [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:text-foreground [&_h3]:mb-1 [&_h3]:mt-2 [&_h3:first-child]:mt-0
  [&_p]:mb-2 [&_p:last-child]:mb-0 [&_p]:break-words
  [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-4 [&_ul:last-child]:mb-0 [&_li]:mb-0.5 [&_li]:break-words
  [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-4 [&_ol:last-child]:mb-0
  [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[10px] [&_code]:font-mono [&_code]:wrap-anywhere
  [&_pre]:bg-muted [&_pre]:p-2 [&_pre]:rounded [&_pre]:mb-2 [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_pre]:max-w-full
  [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:break-normal
  [&_a]:text-blue-400 [&_a]:underline [&_a]:underline-offset-2 [&_a]:wrap-anywhere
  [&_strong]:text-foreground [&_strong]:font-semibold
  [&_hr]:border-ring/20 [&_hr]:my-2
  [&_blockquote]:border-l-2 [&_blockquote]:border-ring/40 [&_blockquote]:pl-3 [&_blockquote]:italic
`.trim()
