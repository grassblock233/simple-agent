"use client";

import { useEffect, useRef, useState } from "react";
import { Archive, ArrowLeft, Check, ChevronDown, Eye, EyeOff, Link, MessageSquare, Minus, Plus, RotateCcw, Search, Settings2, Sun } from "lucide-react";
import { readAppearance, saveAppearance } from "./appearance";
import type { Appearance } from "./appearance";
import type { AppSettings, Project, Session, SessionSettings } from "@/lib/types";
import type { CSSProperties, ReactNode } from "react";

type Category = "general" | "appearance" | "connection" | "session" | "archive";
type ArchivedSession = Pick<Session, "id" | "title" | "workspace" | "updatedAt" | "archived">;
const categories = [
  { id: "general", title: "常规", icon: Settings2 }, { id: "appearance", title: "外观", icon: Sun },
  { id: "connection", title: "模型连接", icon: Link }, { id: "session", title: "当前会话", icon: MessageSquare },
  { id: "archive", title: "已归档的聊天", icon: Archive },
] as const;
const efforts = { off: "关闭", low: "低", high: "高", max: "最大" };
async function request<T>(url: string, body?: unknown, method = "PATCH"): Promise<T> {
  const response = await fetch(url, body === undefined ? undefined : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "保存失败");
  return value;
}

function NumberControl({ value, disabled, change, label }: { value: number; disabled: boolean; change: (value: number) => void; label: string }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (!draft.trim() || !Number.isFinite(parsed)) { setDraft(String(value)); return; }
    const next = Math.max(1, Math.min(10, Math.round(parsed)));
    setDraft(String(next)); if (next !== value) change(next);
  };
  return <div className="sw-stepper"><button title="减少" aria-label={`${label}减少`} disabled={disabled || value <= 1} onClick={() => change(value - 1)}><Minus size={16} /></button><input aria-label={label} type="number" min={1} max={10} value={draft} disabled={disabled} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /><button title="增加" aria-label={`${label}增加`} disabled={disabled || value >= 10} onClick={() => change(value + 1)}><Plus size={16} /></button></div>;
}

function Threshold({ value, disabled, change, label }: { value: number; disabled: boolean; change: (value: number) => void; label: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft !== value) change(draft); };
  return <div className="sw-range"><output>{Math.round(draft * 100)}%</output><input aria-label={label} type="range" min="0.1" max="0.95" step="0.05" disabled={disabled} value={draft} style={{ "--range-fill": `${(draft - 0.1) / 0.85 * 100}%` } as CSSProperties} onChange={event => setDraft(Number(event.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} /></div>;
}

export default function SettingsWorkbench({ initialCategory, session, sessions, projects, busy, hasKey, close, updated, restored }: {
  initialCategory: "general" | "connection"; session: Session | null; sessions: ArchivedSession[]; projects: Project[]; busy: boolean; hasKey: boolean;
  close: () => void; updated: (session: Session) => void; restored: () => Promise<void>;
}) {
  const [category, setCategory] = useState<Category>(initialCategory);
  const [query, setQuery] = useState("");
  const [archiveQuery, setArchiveQuery] = useState("");
  const [defaults, setDefaults] = useState<SessionSettings | null>(null);
  const [appearance, setAppearance] = useState<Appearance>({ theme: "light", density: "compact" });
  const [saving, setSaving] = useState(false);
  const [restoreId, setRestoreId] = useState("");
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [configured, setConfigured] = useState(hasKey);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const back = useRef<HTMLButtonElement>(null);
  const savingRef = useRef(false);
  useEffect(() => {
    back.current?.focus(); setAppearance(readAppearance());
    let live = true;
    void request<AppSettings>("/api/settings").then(value => { if (live) setDefaults(value.sessionDefaults); }).catch(error => { if (live) setFeedback({ error: true, text: String(error) }); });
    return () => { live = false; };
  }, []);
  const save = async (action: () => Promise<void>) => {
    if (savingRef.current) return;
    savingRef.current = true; setSaving(true); setFeedback(null);
    try { await action(); setFeedback({ error: false, text: "已保存" }); }
    catch (error) { setFeedback({ error: true, text: error instanceof Error ? error.message : String(error) }); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const update = (patch: Partial<SessionSettings>, isDefault: boolean) => void save(async () => {
    if (isDefault && defaults) {
      const previous = defaults; setDefaults({ ...defaults, ...patch });
      try { setDefaults((await request<AppSettings>("/api/settings", { sessionDefaults: patch })).sessionDefaults); }
      catch (error) { setDefaults(previous); throw error; }
    } else if (session) {
      const previous = session; updated({ ...session, settings: { ...session.settings, ...patch } });
      try { updated(await request<Session>(`/api/sessions/${session.id}`, patch)); }
      catch (error) { updated(previous); throw error; }
    }
  });
  const setLook = (patch: Partial<Appearance>) => {
    const next = { ...appearance, ...patch };
    try { saveAppearance(next); setAppearance(next); setFeedback(null); }
    catch { setFeedback({ error: true, text: "无法保存外观偏好，请检查浏览器存储权限。" }); }
  };
  const matching = (title: string, description: string) => !query.trim() || `${title} ${description}`.toLowerCase().includes(query.trim().toLowerCase());
  const row = (title: string, description: string, control: ReactNode) => matching(title, description) ? <div className="sw-row" key={title}><div className="sw-label"><strong>{title}</strong><p>{description}</p></div><div className="sw-control">{control}</div></div> : null;
  const settingsRows = (value: SessionSettings, isDefault: boolean) => {
    const disabled = saving || (!isDefault && busy);
    const prefix = isDefault ? "默认" : "";
    return [
      row(`${prefix}思考强度`, "控制模型处理复杂任务时的思考量", <div className="sw-select"><select aria-label={`${prefix}思考强度`} value={value.reasoningEffort} disabled={disabled} onChange={event => update({ reasoningEffort: event.target.value as SessionSettings["reasoningEffort"] }, isDefault)}>{Object.entries(efforts).map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select><ChevronDown size={15} aria-hidden="true" /></div>),
      row(`${prefix}上下文压缩`, "达到阈值后保留关键任务信息", <label className="sw-switch"><input aria-label={`${prefix}上下文压缩`} type="checkbox" checked={value.compression} disabled={disabled} onChange={event => update({ compression: event.target.checked }, isDefault)} /><span /></label>),
      row(`${prefix}失败尝试上限`, "验证失败后允许重试的次数，范围 1–10", <NumberControl label={`${prefix}失败尝试上限`} value={value.maxAttempts} disabled={disabled} change={maxAttempts => update({ maxAttempts }, isDefault)} />),
      row(`${prefix}压缩阈值`, "上下文占用达到此比例时压缩历史", <Threshold label={`${prefix}压缩阈值`} value={value.threshold} disabled={disabled} change={threshold => update({ threshold }, isDefault)} />),
    ];
  };
  const archiveItems = sessions.filter(item => item.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const projectName = (workspace: string) => projects.find(item => item.workspace === workspace)?.name || workspace.split("/").filter(Boolean).at(-1) || workspace;
  const visibleArchive = archiveItems.filter(item => `${item.title} ${projectName(item.workspace)}`.toLowerCase().includes(archiveQuery.trim().toLowerCase()));
  const panels: Record<Category, ReactNode[]> = {
    general: defaults ? settingsRows(defaults, true) : !query ? [<p className="sw-empty" key="loading">{feedback?.error ? "无法加载默认设置" : "加载中…"}</p>] : [],
    appearance: [
      row("主题", "应用界面的配色", <div className="sw-segments" role="group" aria-label="主题">{(["light", "dark", "system"] as const).map((id, index) => <button key={id} aria-pressed={appearance.theme === id} onClick={() => setLook({ theme: id })}>{["浅色", "深色", "跟随系统"][index]}</button>)}</div>),
      row("界面密度", "调整列表行高和内容间距", <div className="sw-segments" role="group" aria-label="界面密度">{(["compact", "comfortable"] as const).map((id, index) => <button key={id} aria-pressed={appearance.density === id} onClick={() => setLook({ density: id })}>{["紧凑", "舒适"][index]}</button>)}</div>),
    ],
    connection: [
      row("模型", "DeepSeek 对话与工具调用模型", <div className="sw-model"><code>deepseek-flash</code><span>{configured ? "已配置" : "未配置密钥"}</span></div>),
      row("DeepSeek API Key", "密钥仅存于服务端进程内，重启后需重新填写或使用环境变量", <form className="sw-key" onSubmit={event => { event.preventDefault(); void save(async () => { const result = await request<{ hasApiKey: boolean }>("/api/config", { apiKey: key }, "POST"); setConfigured(result.hasApiKey); setKey(""); setShowKey(false); await restored(); }); }}><div><input aria-label="DeepSeek API Key" autoComplete="off" type={showKey ? "text" : "password"} value={key} onChange={event => setKey(event.target.value)} placeholder={configured ? "输入新 Key 以替换" : "sk-..."} /><button type="button" title={showKey ? "隐藏密钥" : "显示密钥"} aria-label={showKey ? "隐藏密钥" : "显示密钥"} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div><button className="sw-button" disabled={!key.trim() || saving} type="submit">{saving ? "保存中…" : "保存"}</button></form>),
    ],
    session: session ? settingsRows(session.settings, false) : matching("当前会话", "新建会话后可调整会话设置") ? [<p className="sw-empty" key="empty">新建会话后可调整会话设置。</p>] : [],
    archive: matching("已归档的聊天", "恢复聊天 项目") ? [<div key="archive"><div className="sw-archive-search"><Search size={16} /><input aria-label="搜索归档聊天" placeholder="搜索标题或项目" value={archiveQuery} onChange={event => setArchiveQuery(event.target.value)} /></div>{visibleArchive.length ? visibleArchive.map(item => <div className="sw-row" key={item.id}><div className="sw-label"><strong>{item.title}</strong><p title={item.workspace}>{projectName(item.workspace)} · {new Date(item.updatedAt).toLocaleString("zh-CN")}</p></div><button className="sw-button" disabled={Boolean(restoreId)} onClick={() => { setRestoreId(item.id); setFeedback(null); void request(`/api/sessions/${item.id}`, { archived: false }).then(restored).then(() => setFeedback({ error: false, text: "聊天已恢复" })).catch(error => setFeedback({ error: true, text: String(error) })).finally(() => setRestoreId("")); }}><RotateCcw size={15} />{restoreId === item.id ? "恢复中…" : "恢复"}</button></div>) : <p className="sw-empty">{archiveQuery ? "没有匹配的归档聊天" : "没有已归档的聊天"}</p>}</div>] : [],
  };
  const shown = categories.filter(item => !query.trim() ? item.id === category : panels[item.id].some(Boolean));
  return <section className="settings-workbench" aria-label="设置" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); if (query) setQuery(""); else close(); } }}>
    <aside className="sw-sidebar"><header><button ref={back} className="icon-btn" title="返回聊天" aria-label="返回聊天" onClick={close}><ArrowLeft size={20} /></button><h1>设置</h1></header><label className="sw-search"><Search size={17} /><input aria-label="搜索设置" placeholder="搜索" value={query} onChange={event => setQuery(event.target.value)} /></label><nav aria-label="设置分类"><p>个人</p>{categories.map(item => <button key={item.id} aria-current={category === item.id ? "page" : undefined} onClick={() => { setCategory(item.id); setQuery(""); setFeedback(null); }}><item.icon size={18} />{item.title}</button>)}</nav><select className="sw-mobile-categories" aria-label="设置分类" value={category} onChange={event => { setCategory(event.target.value as Category); setQuery(""); setFeedback(null); }}>{categories.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}</select></aside>
    <main className="sw-content"><div className="sw-inner">{feedback && <p className={`sw-feedback ${feedback.error ? "error" : ""}`} role={feedback.error ? "alert" : "status"}>{!feedback.error && <Check size={16} />}{feedback.text}</p>}{shown.length ? shown.map(item => <section className="sw-section" key={item.id}><h2>{item.title}</h2>{item.id === "general" && !query && <h3>新会话默认设置</h3>}{item.id === "session" && session && <p className="sw-session-title">{session.title}{busy ? " · 任务运行中" : ""}</p>}<div className="sw-rows">{panels[item.id]}</div></section>) : <p className="sw-empty">没有匹配的设置</p>}</div></main>
  </section>;
}
