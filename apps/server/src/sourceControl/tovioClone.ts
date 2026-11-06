export function isTovioCloneUrl(url: string): boolean {
  return /^tovio(?:\+https)?:\/\//iu.test(url);
}

export function parseTovioCloneUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw.replace(/^tovio\+https:/iu, "https:"));
  } catch {
    return null;
  }
  const native = url.protocol === "tovio:";
  if (
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash ||
    (!native && url.protocol !== "https:")
  ) {
    return null;
  }
  const repo = native ? url.pathname.slice(1) : url.searchParams.get("repo");
  if (
    !repo ||
    !/^(?:blake3:)?[a-f0-9]{64}$/iu.test(repo) ||
    (native && (!url.port || url.search !== "")) ||
    (!native && [...url.searchParams.keys()].join() !== "repo")
  ) {
    return null;
  }
  url.search = "";
  return { native, remote: native ? url.host : url.toString(), repo };
}
