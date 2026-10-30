import { NodeKind, NodeSummary, TopicGroups } from '../types';

/** Short, invocation-local labels on the wire; canonical IDs remain in snapshots/cache.
 * Only typed reference fields are rewritten, never prose, logs, or code containing IDs.
 */
export function prepareModelInput(kind: NodeKind, payload: unknown, sources: Set<string>) {
  const prefix = kind === 'topics' ? 'O' : 'S';
  const toSource = new Map([...sources].map((source, index) => [`${prefix}${index + 1}`, source]));
  const toLocal = new Map([...toSource].map(([local, source]) => [source, local]));
  const local = (source: string) => {
    const value = toLocal.get(source);
    if (!value) throw new Error('Input references a source outside its node');
    return value;
  };
  let input: unknown;
  if (kind === 'chunk') {
    const data = payload as { evidence: { id: string }[]; background: { id: string }[] };
    input = { ...data, evidence: data.evidence.map(item => ({ ...item, id: local(item.id) })),
      background: data.background.map(item => ({ ...item, id: local(item.id) })) };
  } else if (kind === 'topics') {
    const data = payload as { observations: { id: string }[] };
    input = { ...data, observations: data.observations.map(item => ({ ...item, id: local(item.id) })) };
  } else {
    const data = payload as { children: { id: string; summary: NodeSummary }[] };
    input = { ...data, children: data.children.map((child, index) => ({ ...child, id: `child${index + 1}`,
      summary: { ...child.summary, observations: child.summary.observations.map(observation => ({
        ...observation, evidence: observation.evidence.map(local),
      })) } })) };
  }
  return {
    input, allowed: new Set(toSource.keys()),
    // Validate against allowed first. No fuzzy matching or guessing which source was intended.
    decode(output: NodeSummary | TopicGroups): NodeSummary | TopicGroups {
      const canonical = (ref: string) => {
        const source = toSource.get(ref);
        if (!source) throw new Error('Output references an unknown local label');
        return source;
      };
      return 'groups' in output
        ? { groups: output.groups.map(group => ({ ...group, members: group.members.map(canonical) })) }
        : { ...output, observations: output.observations.map(observation => ({ ...observation, evidence: observation.evidence.map(canonical) })) };
    },
  };
}
