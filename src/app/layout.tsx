import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Simple Agent", description: "本地代码生成 Agent" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
