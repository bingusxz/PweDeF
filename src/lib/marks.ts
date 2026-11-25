/** Check-mark geometry shared by the on-screen preview and the saved PDF (unit box centred on 0,0, y down). */
export function markStrokes(kind: 'check' | 'cross' | 'dot'): [number, number][][] {
  if (kind === 'check') return [[[-0.42, 0.02], [-0.12, 0.34], [0.44, -0.36]]];
  if (kind === 'cross') return [[[-0.36, -0.36], [0.36, 0.36]], [[0.36, -0.36], [-0.36, 0.36]]];
  return [];
}
