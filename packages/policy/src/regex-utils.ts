export function toGlobal(regex: RegExp): RegExp {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  return new RegExp(regex.source, flags);
}
