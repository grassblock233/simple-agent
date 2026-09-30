"use client";

import { useEffect } from "react";

export type Appearance = { theme: "light" | "dark" | "system"; density: "compact" | "comfortable" };
export const appearanceKey = "simple-agent:appearance";
export function readAppearance(): Appearance {
  try {
    const value = JSON.parse(localStorage.getItem(appearanceKey) || "{}");
    return { theme: ["light", "dark", "system"].includes(value.theme) ? value.theme : "light", density: value.density === "comfortable" ? "comfortable" : "compact" };
  } catch { return { theme: "light", density: "compact" }; }
}
function applyAppearance(value: Appearance) {
  document.documentElement.dataset.theme = value.theme === "system" ? matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" : value.theme;
  document.documentElement.dataset.density = value.density;
}
export function saveAppearance(value: Appearance) {
  localStorage.setItem(appearanceKey, JSON.stringify(value));
  applyAppearance(value);
  window.dispatchEvent(new Event("appearance-change"));
}
export default function AppearanceSync() {
  useEffect(() => {
    const sync = () => applyAppearance(readAppearance());
    const media = matchMedia("(prefers-color-scheme: dark)");
    sync(); media.addEventListener("change", sync);
    window.addEventListener("storage", sync);
    window.addEventListener("appearance-change", sync);
    return () => { media.removeEventListener("change", sync); window.removeEventListener("storage", sync); window.removeEventListener("appearance-change", sync); };
  }, []);
  return null;
}
