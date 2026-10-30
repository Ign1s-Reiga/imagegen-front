/**
 * Lower-cases a label's first word for use mid-sentence, keeping acronyms:
 * "API key" stays "API key", "Endpoint ID" becomes "endpoint ID".
 */
export const midSentence = (label: string) =>
  label.replace(/^([A-Za-z])([A-Za-z]*)/, (word, first: string, rest: string) =>
    rest && rest === rest.toUpperCase() ? word : first.toLowerCase() + rest,
  );
