const markers = /\[((?:[ECR]\d+|H[A-Za-z0-9_-]+)(?:[\s,;]+(?:[ECR]\d+|H[A-Za-z0-9_-]+))*)\]/g;

/** One stable, per-answer wire namespace. The model copies short labels; only
 * the application maps them to admitted original-source references. This does
 * not establish semantic support or admit a reference found inside a quote. */
export function answerReferences(allowed: Set<string>) {
  const labels = new Map([...allowed].map((ref, index) => [ref, `R${index + 1}`]));
  const originals = new Map([...labels].map(([ref, label]) => [label, ref]));
  const referenceFields = new Set(['ref', 'earlier_ref', 'later_refs', 'missing_later_refs', 'evidence']);
  const quoted = (text: string) => text.replace(markers, '(quoted reference $1)');
  function encode(value: unknown, key = ''): unknown {
    if (Array.isArray(value)) return value.map(item => encode(item, key));
    if (typeof value === 'string') {
      if (referenceFields.has(key)) {
        const label = labels.get(value);
        if (!label) throw new Error('Answer evidence contains a reference outside its admitted catalog');
        return label;
      }
      const text = quoted(value.replace('Cite only the supplied H references', 'Cite only the supplied reference_labels'));
      // Preserve an explicit source-read request in the wire namespace without
      // turning any reference quoted by an original source into authorization.
      return key === 'user_question' ? text.replace(/\b(?:[EC]\d+|H[a-f0-9]{24})\b/g, ref => labels.get(ref) || ref) : text;
    }
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, encode(item, name)]));
    return value;
  }
  return {
    labels: [...originals.keys()],
    encode,
    // Unknown labels are left visible for strict validation, never guessed or
    // silently dropped. Canonical citations are still checked against allowed.
    decode: (answer: string) => answer.replace(markers, (_full, group: string) => group.split(/[\s,;]+/).map(label => `[${originals.get(label) || label}]`).join(' ')),
  };
}

export function verdictReferenceIssue(answer: string, allowed: Set<string>): 'outside_catalog' | 'missing' | null {
  const cited = [...answer.matchAll(markers)].flatMap(match => match[1].split(/[\s,;]+/));
  if (cited.some(ref => !allowed.has(ref))) return 'outside_catalog';
  return allowed.size && !cited.length ? 'missing' : null;
}
