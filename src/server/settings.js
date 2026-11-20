// Whitelist and clamp the project settings that come from the browser.
export function cleanSettings(input = {}) {
  const out = {};
  if (typeof input.trimPauses === "boolean") out.trimPauses = input.trimPauses;
  if (Number.isFinite(input.maxPause)) out.maxPause = Math.min(5, Math.max(0.1, input.maxPause));
  if (Number.isFinite(input.padding)) out.padding = Math.min(0.5, Math.max(0, input.padding));
  if (typeof input.language === "string" && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(input.language)) {
    out.language = input.language;
  }
  if (input.asrModel === "enhanced" || input.asrModel === "melia-1") out.asrModel = input.asrModel;
  if (typeof input.useAi === "boolean") out.useAi = input.useAi;
  if (typeof input.doSrt === "boolean") out.doSrt = input.doSrt;
  if (typeof input.doBroll === "boolean") out.doBroll = input.doBroll;
  if (input.brollAi === "groq" || input.brollAi === "claude") out.brollAi = input.brollAi;
  if (input.cutAi === "groq" || input.cutAi === "claude") out.cutAi = input.cutAi;
  return out;
}
