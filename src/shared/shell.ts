const MAX_SHELL_VALUE_LENGTH = 16_384

/** POSIX single-quote escaping for embedding a value in a shell command. */
export function shellQuote(value: string): string {
  if (!value || value.includes('\0') || value.length > MAX_SHELL_VALUE_LENGTH) {
    throw new Error('Unsafe or empty command value')
  }
  return `'${value.replaceAll("'", `'\\''`)}'`
}
