/**
 * Draws the mermaid blocks of a doc in the browser. Mermaid is large, so it
 * is only loaded on pages that have a diagram.
 */
let ready: Promise<typeof import('mermaid').default> | undefined;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

async function load() {
  const mermaid = (await import('mermaid')).default;
  const font = cssVar('--font-body');
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: font,
    themeVariables: {
      fontFamily: font,
      fontSize: '14px',
      background: cssVar('--surface'),
      primaryColor: cssVar('--raise'),
      primaryTextColor: cssVar('--ink'),
      primaryBorderColor: cssVar('--accent'),
      secondaryColor: cssVar('--surface-2'),
      tertiaryColor: cssVar('--surface'),
      lineColor: cssVar('--mute'),
      textColor: cssVar('--ink-2'),
      clusterBkg: cssVar('--surface-2'),
      clusterBorder: cssVar('--line-strong'),
      edgeLabelBackground: cssVar('--surface'),
      noteBkgColor: cssVar('--raise'),
      noteTextColor: cssVar('--ink'),
      actorBkg: cssVar('--raise'),
      actorBorder: cssVar('--accent'),
      actorTextColor: cssVar('--ink'),
      signalColor: cssVar('--ink-2'),
      signalTextColor: cssVar('--ink-2'),
    },
  });
  return mermaid;
}

export async function renderMermaid(root: HTMLElement): Promise<void> {
  const nodes = [...root.querySelectorAll<HTMLElement>('pre.mermaid:not([data-processed])')];
  if (nodes.length === 0) {
    return;
  }
  try {
    ready ??= load();
    const mermaid = await ready;
    await mermaid.run({ nodes });
    for (const node of nodes) {
      keepReadable(node.querySelector('svg'));
    }
  } catch (error) {
    // The source stays visible as a fallback.
    console.warn('Could not draw a diagram', error);
  }
}

/**
 * Wide diagrams (a left-to-right flowchart is ~1500 px) would shrink to
 * unreadable text in the content column. Below 75 % of their natural size
 * they scroll sideways instead.
 */
function keepReadable(svg: SVGSVGElement | null): void {
  const natural = svg?.viewBox.baseVal?.width;
  if (svg && natural) {
    svg.style.minWidth = `${Math.round(natural * 0.75)}px`;
  }
}
