/** Map cooked template characters back to UTF-16 offsets in the authored source. */
export function templateOffsets(raw: string, start: number, cooked: string): number[] {
  const result: number[] = [];
  for (let i = 0; i < raw.length;) {
    const at = i;
    let width = 1;
    if (raw[i] === "\\") {
      i++;
      const c = raw[i++];
      if (c === "\n" || c === "\r") {
        if (c === "\r" && raw[i] === "\n") i++;
        continue;
      }
      if (c === "x") i += 2;
      else if (c === "u") {
        if (raw[i] === "{") {
          const end = raw.indexOf("}", i);
          const point = Number.parseInt(raw.slice(i + 1, end), 16);
          width = point > 0xffff ? 2 : 1;
          i = end + 1;
        } else i += 4;
      }
    } else {
      i++;
      if (raw[at] === "\r" && raw[i] === "\n") i++;
    }
    for (let j = 0; j < width; j++) result.push(start + at);
  }
  // Invalid escapes are parser errors. Never guess an offset if cooking changed.
  return result.length === cooked.length ? result : [];
}
