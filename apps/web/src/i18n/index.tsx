import { createContext, useCallback, useContext, useMemo, useState } from "react";

import { DICTIONARIES, LOCALES } from "./strings.js";

import type { Lang, StringKey } from "./strings.js";
import type { ReactNode } from "react";

export type { Lang, StringKey } from "./strings.js";

export type Translate = (key: StringKey, vars?: Record<string, string | number>) => string;

interface I18nValue {
  readonly lang: Lang;
  readonly locale: string;
  readonly setLang: (lang: Lang) => void;
  readonly t: Translate;
}

const I18nContext = createContext<I18nValue | null>(null);

function readLang(): Lang {
  try {
    const stored = window.localStorage.getItem("muse.lang");
    if (stored === "en" || stored === "ko") {
      return stored;
    }
    return window.navigator.language.startsWith("ko") ? "ko" : "en";
  } catch {
    return "en";
  }
}

function fill(template: string, vars?: Record<string, string | number>): string {
  if (!vars) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match
  );
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => readLang());

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      window.localStorage.setItem("muse.lang", next);
      document.documentElement.lang = next;
    } catch {
      /* storage unavailable */
    }
  }, []);

  const value = useMemo<I18nValue>(() => {
    const dict = DICTIONARIES[lang];
    return {
      lang,
      locale: LOCALES[lang],
      setLang,
      t: (key, vars) => fill(dict[key] ?? DICTIONARIES.en[key] ?? key, vars)
    };
  }, [lang, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return value;
}
