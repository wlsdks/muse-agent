const NON_CHAT_MODEL_NAME = /(?:embed|rerank)/iu;

export function isLikelyChatModel(name) {
  return typeof name === "string" && name.trim().length > 0 && !NON_CHAT_MODEL_NAME.test(name);
}

export function qwenParamSize(name) {
  const tag = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
  const match = tag.match(/(\d+(?:\.\d+)?)b/iu);
  return match ? Number.parseFloat(match[1]) : Number.POSITIVE_INFINITY;
}

export function chooseHeavyTier(fastModel, qwens, overrideHeavy) {
  if (overrideHeavy) {
    const pinned = overrideHeavy.startsWith("ollama/") ? overrideHeavy : `ollama/${overrideHeavy}`;
    return pinned !== fastModel && isLikelyChatModel(pinned) ? pinned : undefined;
  }
  const heavy = qwens
    .filter((model) => model !== fastModel && isLikelyChatModel(model))
    .sort((a, b) => qwenParamSize(a) - qwenParamSize(b))[0];
  if (!heavy || qwenParamSize(heavy) >= 20) {
    return undefined;
  }
  return heavy;
}

export function smokeLiveMinParams(sourceEnv = process.env) {
  return Number.parseFloat(sourceEnv.MUSE_SMOKE_LIVE_MIN_PARAMS ?? "7");
}

export function selectSmokeLiveModel(names, override, minimumParams = smokeLiveMinParams()) {
  if (override) {
    return isLikelyChatModel(override) ? override : undefined;
  }
  const chatModels = names.filter(isLikelyChatModel);
  const gemma = chatModels.find((name) => /gemma4/iu.test(name));
  if (gemma) {
    return gemma;
  }
  const qwens = chatModels.filter((name) => /qwen/iu.test(name));
  if (qwens.length === 0) {
    return chatModels[0];
  }
  const bySize = [...qwens].sort(
    (a, b) => qwenParamSize(a) - qwenParamSize(b) || a.localeCompare(b)
  );
  const toolCapable = bySize.filter(
    (name) => qwenParamSize(name) >= minimumParams && qwenParamSize(name) < 20
  );
  return toolCapable[0] ?? bySize[0];
}
