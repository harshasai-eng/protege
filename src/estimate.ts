/** Rough token count: characters / charsPerToken, rounded up */
export function estimateTokens(text: string, charsPerToken: number): number {
  return Math.ceil(text.length / charsPerToken);
}