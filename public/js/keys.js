import { h, icon, toast } from "./dom.js";
import { api } from "./api.js";

const FIELDS = [
  ["speechmatics", "Speechmatics", "Transcribes your recording."],
  ["gemini", "Gemini (Google AI Studio)", "Default AI: marks retakes, plans B-roll and writes image prompts."],
  ["groq", "Groq", "The other AI you can choose instead of Gemini."]
];

// The "API keys" dialog. Keys are saved on this computer (secrets.json) and used straight away, no restart needed.
export async function openKeys({ onSaved } = {}) {
  const dialog = h("dialog", {});
  const body = h("div", { class: "dlg" });
  dialog.append(body);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());

  let system;
  try { system = await api.brollGlobal("system"); }
  catch (error) { dialog.remove(); toast(error.message, "error"); return; }

  const inputs = {};
  const rows = FIELDS.map(([name, label, help]) => {
    const st = system.keys[name];
    const input = h("input", {
      class: "field", type: "password", autocomplete: "off", spellcheck: "false",
      placeholder: st.set ? `Saved ${st.hint}. Paste a new key to replace it` : "Paste your key"
    });
    inputs[name] = input;
    return h("label", { class: "stack keyrow" }, label,
      input,
      h("span", { class: "hint", style: { margin: 0 } }, help,
        st.set ? ` Using the key from ${st.source === "saved" ? "this dialog" : `your ${st.envVar} setting`}.` : " Not set yet."));
  });

  const save = h("button", { class: "btn primary" }, "Save");
  save.addEventListener("click", async () => {
    const payload = {};
    for (const [name] of FIELDS) if (inputs[name].value.trim()) payload[name] = inputs[name].value.trim();
    if (!Object.keys(payload).length) { dialog.close(); return; }
    save.disabled = true;
    try {
      await api.brollGlobalPost("secrets", payload);
      toast("Keys saved.");
      dialog.close();
      onSaved?.();
    } catch (error) { toast(error.message, "error"); save.disabled = false; }
  });

  body.append(
    h("h2", {}, icon("key", 18), " API keys"),
    h("p", { class: "hint", style: { margin: 0 } }, "Stored on this computer only. You can also put them in the .env file."),
    ...rows,
    system.ffmpeg
      ? null
      : h("div", { class: "banner" }, icon("alert"), "ffmpeg was not found. Run npm install (it bundles one) or install ffmpeg."),
    h("div", { class: "foot" }, h("button", { class: "btn", onclick: () => dialog.close() }, "Cancel"), save));
  dialog.showModal();
}
