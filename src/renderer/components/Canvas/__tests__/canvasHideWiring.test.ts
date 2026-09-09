import path from 'path';
import { readSource } from '../../../utils/readSource';

const MODE = readSource(path.resolve(__dirname, '../CanvasMode.tsx'));

describe('hidden canvas consumers', () => {
  it('keeps off-screen wire geometry while excluding USER-hidden endpoints', () => {
    // CanvasWiresProps.rects deliberately includes culled endpoints: filtering those wires
    // makes connections blink during a pan. Only the user's hide decision owns this filter.
    expect(MODE).toContain('edges={edges.filter((e) => !userHidden(e.from) && !userHidden(e.to))}');
    expect(MODE).not.toContain('isHidden(e.from)');
  });

  it('keeps hidden membership and the paintable node list memoised on the hot path', () => {
    expect(MODE).toContain('const hiddenNodeIds = useMemo(');
    expect(MODE).toContain('const paintedNodes = useMemo(');
    expect(MODE).toContain('hiddenNodeIds.has(id)');
    expect(MODE).not.toContain("model.nodes.find((n) => n.terminalId === id)?.hidden");
  });

  it('keeps the toolbar and its recovery action after the final node is hidden', () => {
    expect(MODE).toContain('{!overlayId && (model.groups.length > 0 || hiddenCount > 0) && (');
    expect(MODE).toContain('Hidden{hiddenCount > 0 ? ` (${hiddenCount})` : \'\'}');
    expect(MODE).toContain('{!model.nodes.length && !model.groups.length && (');
  });
});
