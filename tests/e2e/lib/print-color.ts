export const escape = String.fromCharCode(27);

export const stripSgr = (frame: string): string =>
  frame.replaceAll(new RegExp(`${escape}\\[[0-9;]*m`, "gu"), "");
