/**
 * One snapshot out of the per-frame results of injecting the runtime into every frame of a tab.
 *
 * Shared by the extension's dispatcher and by snapshot-capture (the census's page recorder), so a recorded page is
 * merged by exactly the code that merges it live — iframes included. No imports: the capture script bundles it.
 */
export interface FrameSnapshotResult {
  frameId: number;
  result?: unknown;
}

interface FrameSnapshot {
  url: string; title: string; moreBelow: boolean;
  elements: { ref: string; parentRef?: string; controls?: string[] }[];
  docId?: string;
}

export function mergeFrameSnapshots(tabId: number, results: FrameSnapshotResult[]) {
  const merged = {
    tabId, url: "", title: "", elements: [] as unknown[], moreBelow: false,
    docs: {} as Record<string, string>,
  };
  for (const res of results) {
    const r = res.result as { value?: FrameSnapshot } | undefined;
    if (!r?.value) continue;
    const pfx = (ref: string): string => (res.frameId === 0 ? ref : `${res.frameId}_${ref}`);
    if (res.frameId === 0) {
      merged.url = r.value.url;
      merged.title = r.value.title;
    }
    merged.moreBelow ||= r.value.moreBelow; // any frame with more content below counts
    for (const el of r.value.elements) {
      // Sub-frame refs are namespaced with the frameId; every ref an element names (parentRef, controls) must be too.
      merged.elements.push(
        res.frameId === 0
          ? el
          : { ...el, ref: pfx(el.ref), parentRef: el.parentRef ? pfx(el.parentRef) : undefined, ...(el.controls && { controls: el.controls.map(pfx) }) },
      );
    }
    // Each frame is its own document with its own ref numbering, keyed the
    // same way its refs are prefixed, so a frame that navigated on its own
    // can be told apart from the rest of the page.
    if (r.value.docId) merged.docs[String(res.frameId)] = r.value.docId;
  }
  return merged;
}
