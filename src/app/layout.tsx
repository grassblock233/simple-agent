import type { Metadata } from "next";
import "./globals.css";
import AppearanceSync from "./appearance";

export const metadata: Metadata = { title: "Simple Agent", description: "本地代码生成 Agent" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: `try{var a=JSON.parse(localStorage.getItem('simple-agent:appearance')||'{}');document.documentElement.dataset.theme=a.theme==='dark'||(a.theme==='system'&&matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light';document.documentElement.dataset.density=a.density==='comfortable'?'comfortable':'compact'}catch{}` }} /></head><body><AppearanceSync />{children}</body></html>;
}
