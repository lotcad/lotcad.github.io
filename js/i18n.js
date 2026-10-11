(() => {
  "use strict";
  const select = document.getElementById("language-select");
  const status = document.getElementById("language-status");
  const cache = new Map();
  let current = "ko";
  let request = 0;
  let languages = [{ code: "ko", label: "한국어" }, { code: "en", label: "English" }];

  async function readJson(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error("Language file could not be loaded");
    return response.json();
  }

  function apply(messages, code) {
    document.querySelectorAll("[data-i18n]").forEach(element => {
      const value = messages[element.dataset.i18n];
      if (typeof value === "string") element.textContent = value;
    });
    ["alt", "title", "content"].forEach(attribute => {
      document.querySelectorAll("[data-i18n-" + attribute + "]").forEach(element => {
        const value = messages[element.getAttribute("data-i18n-" + attribute)];
        if (typeof value === "string") element.setAttribute(attribute, value);
      });
    });
    document.documentElement.lang = code;
    select.value = code;
    current = code;
  }

  async function changeLanguage(code) {
    if (!languages.some(language => language.code === code)) code = "ko";
    const token = ++request;
    status.textContent = "";
    try {
      if (!cache.has(code)) cache.set(code, await readJson("locales/" + code + ".json"));
      if (token !== request) return;
      apply(cache.get(code), code);
      try { localStorage.setItem("lotcad.language", code); } catch (_) {}
    } catch (_) {
      if (token !== request) return;
      select.value = current;
      status.textContent = current === "ko"
        ? "언어를 불러오지 못했습니다. 다시 선택해 주세요."
        : "Could not load the language. Please try again.";
    }
  }

  select.addEventListener("change", () => changeLanguage(select.value));
  async function initialize() {
    try {
      const registry = await readJson("locales/languages.json");
      if (Array.isArray(registry) && registry.length &&
          registry.every(item => /^[a-z]{2}(?:-[A-Z]{2})?$/.test(item.code) && typeof item.label === "string") &&
          registry.some(item => item.code === "ko")) {
        languages = registry;
        select.replaceChildren(...languages.map(language => {
          const option = document.createElement("option");
          option.value = language.code;
          option.lang = language.code;
          option.textContent = language.label;
          return option;
        }));
        select.value = current;
      }
    } catch (_) { /* Keep the built-in Korean and English options. */ }
    let saved = "ko";
    try { saved = localStorage.getItem("lotcad.language") || "ko"; } catch (_) {}
    if (saved !== "ko" && request === 0) await changeLanguage(saved);
  }
  initialize();
})();

