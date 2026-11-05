import { parseFloorplanRgbaBuffer } from './floorplanParser.ts';
import type { ParseRequest, ParseResponse } from './parseClient.ts';

// Runs the wall/door/window extraction off the main thread so the UI stays responsive.
self.onmessage = (e: MessageEvent<ParseRequest>) => {
  const { id, rgba, w, h, options, ocrCandidates, useOcrScale, roomCandidates, ocrTextBoxes, masks } =
    e.data;
  let response: ParseResponse;
  try {
    // The masks are large and the caller already has them; don't send them back.
    const { masks: _masks, ...result } = parseFloorplanRgbaBuffer(
      rgba,
      w,
      h,
      options,
      ocrCandidates,
      useOcrScale,
      roomCandidates,
      ocrTextBoxes,
      masks
    );
    response = { id, ok: true, result };
  } catch (err) {
    response = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(response);
};
