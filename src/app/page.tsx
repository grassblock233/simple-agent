"use client";

import { isValidElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertCircle, ArrowDown, Check, ChevronDown, ChevronLeft, ChevronRight, Clipboard, Code2, Eye, EyeOff, FilePenLine, FileText, Folder, GitBranch, Minus, PanelLeft, Plus, RotateCcw, Search, Settings2, Square, Terminal, Trash2, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import type { CSSProperties } from "react";
import { sidebarDrag } from "@/lib/sidebar";
import type { Event, ImageRef, LiveEvent, ReasoningEffort, Session, SessionSettings } from "@/lib/types";

type SessionItem = Pick<Session, "id" | "title" | "workspace" | "createdAt" | "updatedAt"> & { hasMessages: boolean };
type BrowserState = { path: string; parent: string; entries: string[] };
type GitStatus = { isRepository: boolean; branch: string; branches: string[]; changedFiles: number };
const effortLevels: ReasoningEffort[] = ["off", "low", "high", "max"];
const effortLabels: Record<ReasoningEffort, string> = { off: "关闭", low: "低", high: "高", max: "最大" };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data as T;
}

function JsonBody(value: unknown): RequestInit { return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }; }

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (isValidElement<{ children?: unknown }>(value)) return textOf(value.props.children);
  return "";
}

function Markdown({ text }: { text: string }) {
  return <ReactMarkdown rehypePlugins={[rehypeHighlight]} components={{
    code({ children, className, ...props }) {
      const code = textOf(children).replace(/\n$/, "");
      if (!className) return <code {...props}>{children}</code>;
      return <span className="code-wrap"><span className="code-actions"><span>{className.replace("language-", "")}</span><button type="button" title="复制代码" aria-label="复制代码" onClick={() => void navigator.clipboard.writeText(code)}><Clipboard size={14} /></button></span><code className={className} {...props}>{children}</code></span>;
    },
  }}>{text}</ReactMarkdown>;
}

function toolSummary(event: Event): string {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(event.args || "{}") as Record<string, unknown>; } catch { /* Keep the tool name when arguments are unavailable. */ }
  const detail = (key: string) => typeof args[key] === "string" ? ` ${args[key]}` : "";
  const action = event.status === "pending" ? "正在" : event.status === "failed" || event.status === "denied" ? "未能" : "已";
  switch (event.name) {
    case "run_shell": return `${action}运行${detail("command")}`;
    case "read_file": return `${action}读取${detail("path")}`;
    case "write_file": return `${action}编辑${detail("path")}`;
    case "list_directory": return `${action}查看目录${detail("path")}`;
    case "search_content": return `${action}搜索${detail("query")}`;
    case "inspect_image": return `${action}查看图片${detail("path")}`;
    default: return `${action}使用 ${event.name || "工具"}`;
  }
}

function EventRow({ event, onApprove, running }: { event: Event; onApprove: (id: string, approved: boolean) => void; running: boolean }) {
  const [open, setOpen] = useState(false);
  if (event.type === "user") return <div className="event user-event"><div className="event-label">你</div><div className="user-bubble">{event.text}{event.images?.map((image) => <img key={image.id} src={`/api/images/${image.id}`} alt={image.name} />)}</div></div>;
  if (event.type === "answer") return <div className="event answer-event"><div className="event-label">AGENT</div><div className="markdown"><Markdown text={event.text || ""} /></div></div>;
  if (event.type === "reasoning") return <div className="event compact-event"><button className="disclosure" onClick={() => setOpen(!open)}><ChevronRight className={open ? "rotated" : ""} size={15} />思考过程</button>{open && <pre className="detail-text">{event.text}</pre>}</div>;
  if (event.type === "tool") return <div className="event compact-event tool-event"><button className="disclosure" onClick={() => setOpen(!open)} title={toolSummary(event)}>{event.name === "write_file" ? <FilePenLine size={15} /> : event.name === "read_file" ? <FileText size={15} /> : <Terminal size={15} />}<span className="tool-summary">{toolSummary(event)}</span>{event.status === "failed" || event.status === "denied" ? <span className={`badge ${event.status}`}>失败</span> : null}<ChevronDown className={open ? "" : "closed"} size={14} /></button>{open && <div className="tool-details"><div><b>入参</b><pre>{event.args}</pre></div><div><b>结果</b><pre>{event.result || "等待结果…"}</pre></div></div>}</div>;
  if (event.type === "notice" && event.approvalId) return <div className="event approval-event"><div className="approval-title"><Terminal size={17} /> Shell 执行授权</div><p>批准后命令以当前用户权限运行，可能访问工作区外的文件和网络。</p><pre>{event.args}</pre><div className="approval-actions">{event.status === "pending" && running ? <><button className="btn primary" onClick={() => onApprove(event.approvalId!, true)}><Check size={16} /> 批准执行</button><button className="btn" onClick={() => onApprove(event.approvalId!, false)}><X size={16} /> 拒绝</button></> : <span className="muted">{event.status === "success" ? "已批准" : "已拒绝或过期"}</span>}</div></div>;
  if (event.type === "compression") return <div className="event compact-event"><button className="disclosure" onClick={() => setOpen(!open)}><ArrowDown size={15} />上下文压缩 · 消息 {event.range}<span className={`badge ${event.status}`}>{event.status === "failed" ? "已降级" : "完成"}</span></button>{open && <pre className="detail-text">{event.text}</pre>}</div>;
  return <div className={`event notice-event ${event.type === "error" || event.status === "failed" ? "error" : ""}`}><AlertCircle size={16} /><span>{event.text}</span></div>;
}

function SettingStepper({ id, label, value, min, max, disabled, onChange }: { id: string; label: string; value: number; min: number; max: number; disabled: boolean; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (!draft.trim() || !Number.isFinite(parsed)) { setDraft(String(value)); return; }
    const next = Math.max(min, Math.min(max, Math.round(parsed)));
    setDraft(String(next));
    if (next !== value) onChange(next);
  };
  const step = (change: number) => {
    const parsed = Number(draft);
    const next = Math.max(min, Math.min(max, (Number.isInteger(parsed) ? parsed : value) + change));
    setDraft(String(next));
    if (next !== value) onChange(next);
  };
  return <div className="settings-number-row"><div><label htmlFor={id}>{label}</label><span>{min}–{max}</span></div><div className="settings-stepper"><button type="button" title={`${label}减少`} aria-label={`${label}减少`} disabled={disabled || value <= min} onClick={() => step(-1)}><Minus size={15} /></button><input id={id} type="number" inputMode="numeric" min={min} max={max} value={draft} disabled={disabled} onChange={(event) => setDraft(event.target.value)} onBlur={(event) => { if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node)) commit(); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><button type="button" title={`${label}增加`} aria-label={`${label}增加`} disabled={disabled || value >= max} onClick={() => step(1)}><Plus size={15} /></button></div></div>;
}

export default function Home() {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [selected, setSelected] = useState<Session | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("就绪");
  const [occupancy, setOccupancy] = useState(0);
  const [contextBudget, setContextBudget] = useState(64000);
  const [composerMenu, setComposerMenu] = useState<"project" | "branch" | "effort" | null>(null);
  const [projectQuery, setProjectQuery] = useState("");
  const [branchQuery, setBranchQuery] = useState("");
  const [gitInfo, setGitInfo] = useState<GitStatus | null>(null);
  const [effortDraft, setEffortDraft] = useState(2);
  const [draftAnswer, setDraftAnswer] = useState("");
  const [draftReasoning, setDraftReasoning] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"connection" | "session">("connection");
  const [showKey, setShowKey] = useState(false);
  const [settingsFeedback, setSettingsFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [savingKey, setSavingKey] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [thresholdDraft, setThresholdDraft] = useState(0.75);
  const [showNew, setShowNew] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(276);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>([]);
  const [latestProject, setLatestProject] = useState("");
  const [creating, setCreating] = useState(false);
  const [browser, setBrowser] = useState<BrowserState | null>(null);
  const [directory, setDirectory] = useState("");
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [error, setError] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const composerArea = useRef<HTMLDivElement>(null);
  const projectSearch = useRef<HTMLInputElement>(null);
  const branchSearch = useRef<HTMLInputElement>(null);
  const effortTrigger = useRef<HTMLButtonElement>(null);
  const composerReturnFocus = useRef<HTMLButtonElement | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const settingsDialog = useRef<HTMLElement>(null);
  const settingsClose = useRef<HTMLButtonElement>(null);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const settingsReturnFocus = useRef<HTMLElement | null>(null);
  const latestProjectRef = useRef("");
  const sidebarWidthRef = useRef(276);
  const expandedSidebarWidthRef = useRef(276);
  const closingSidebarRef = useRef(false);

  const resizeSidebar = useCallback((width: number, persist = false) => {
    const next = Math.max(0, Math.min(width, 520, window.innerWidth - 320));
    const visible = next >= 160;
    const settled = persist && visible ? Math.max(220, next) : next;
    sidebarWidthRef.current = settled;
    if (persist && visible) expandedSidebarWidthRef.current = settled;
    setSidebarWidth(settled);
    setSidebarVisible(visible);
    if (persist) {
      window.localStorage.setItem("simple-agent:sidebar-visible", String(visible));
      if (visible) window.localStorage.setItem("simple-agent:sidebar-width", String(settled));
    }
  }, []);

  useEffect(() => {
    const savedWidth = Number(window.localStorage.getItem("simple-agent:sidebar-width"));
    if (Number.isFinite(savedWidth) && savedWidth >= 220) {
      const width = Math.min(savedWidth, 520);
      sidebarWidthRef.current = width;
      expandedSidebarWidthRef.current = width;
      setSidebarWidth(width);
    }
    if (window.localStorage.getItem("simple-agent:sidebar-visible") === "false") setSidebarVisible(false);
  }, []);

  useEffect(() => {
    if (!resizingSidebar) return;
    const onMove = (event: PointerEvent) => {
      const drag = sidebarDrag(event.clientX, window.innerWidth);
      if (drag.close) {
        closingSidebarRef.current = true;
        setSidebarVisible(false);
        setResizingSidebar(false);
        window.localStorage.setItem("simple-agent:sidebar-visible", "false");
        return;
      }
      sidebarWidthRef.current = drag.width;
      setSidebarWidth(drag.width);
    };
    const onEnd = () => {
      if (closingSidebarRef.current) return;
      resizeSidebar(sidebarWidthRef.current, true);
      setResizingSidebar(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd, { once: true });
    window.addEventListener("pointercancel", onEnd, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
  }, [resizingSidebar, resizeSidebar]);

  const refreshList = useCallback(async () => setSessions(await api<SessionItem[]>("/api/sessions")), []);
  const rememberProject = useCallback((workspace: string) => {
    latestProjectRef.current = workspace;
    setLatestProject(workspace);
    window.localStorage.setItem("simple-agent:last-project", workspace);
  }, []);
  const load = useCallback(async (id: string, remember = true) => {
    const session = await api<Session & { running: boolean; occupancy: number; contextBudget: number }>(`/api/sessions/${id}`);
    setSelected(session); setEvents(session.events); setBusy(session.running);
    setOccupancy(session.occupancy); setContextBudget(session.contextBudget);
    setSidebarOpen(false);
    setCollapsedProjects((current) => current.filter((path) => path !== session.workspace));
    if (remember) rememberProject(session.workspace);
  }, [rememberProject]);
  useEffect(() => {
    void (async () => {
      try {
        const list = await api<SessionItem[]>("/api/sessions");
        setSessions(list);
        const savedProject = window.localStorage.getItem("simple-agent:last-project");
        const initial = list.find((item) => item.workspace === savedProject) || list[0];
        if (initial) await load(initial.id, false);
        if (initial) rememberProject(initial.workspace);
        const config = await api<{ hasApiKey: boolean }>("/api/config");
        setHasKey(config.hasApiKey);
      } catch (cause) { setError(String(cause)); }
    })();
  }, [load, rememberProject]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [events, draftAnswer, draftReasoning]);
  useEffect(() => { if (searchOpen) searchInput.current?.focus(); }, [searchOpen]);
  useLayoutEffect(() => {
    const resize = () => {
      const input = composerInput.current;
      if (!input) return;
      input.style.height = "0px";
      const limit = Math.min(300, window.innerHeight * 0.3);
      input.style.height = `${Math.min(input.scrollHeight, limit)}px`;
      input.style.overflowY = input.scrollHeight > limit ? "auto" : "hidden";
    };
    resize();
    window.addEventListener("resize", resize);
    const observer = new ResizeObserver(resize);
    if (composerArea.current) observer.observe(composerArea.current);
    return () => { window.removeEventListener("resize", resize); observer.disconnect(); };
  }, [text, selected?.id]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    void api<GitStatus>(`/api/git/status?workspace=${encodeURIComponent(selected.workspace)}`).then((value) => { if (active) setGitInfo(value); }).catch(() => { if (active) setGitInfo(null); });
    return () => { active = false; };
  }, [selected?.workspace, composerMenu]);
  useEffect(() => {
    if (composerMenu === "project") projectSearch.current?.focus();
    if (composerMenu === "branch") branchSearch.current?.focus();
  }, [composerMenu]);
  useEffect(() => {
    if (!composerMenu) return;
    const close = (event: PointerEvent) => { if (!composerArea.current?.contains(event.target as Node)) setComposerMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setComposerMenu(null); composerReturnFocus.current?.focus(); } };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [composerMenu]);
  useEffect(() => { if (selected) setThresholdDraft(selected.settings.threshold); }, [selected?.id, selected?.settings.threshold]);
  useEffect(() => { if (selected) setEffortDraft(effortLevels.indexOf(selected.settings.reasoningEffort)); }, [selected?.id, selected?.settings.reasoningEffort]);
  useEffect(() => {
    if (!showSettings) return;
    settingsClose.current?.focus();
    return () => {
      const target = settingsReturnFocus.current;
      if (target?.isConnected && !target.closest("[inert]")) target.focus();
      else settingsTrigger.current?.focus();
    };
  }, [showSettings]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); setSearchQuery(""); setSearchIndex(0); setSearchOpen(true);
      }
      if (event.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const browse = async (target?: string) => {
    try {
      const data = await api<BrowserState>(`/api/fs/browse?path=${encodeURIComponent(target || directory || ".")}`);
      setBrowser(data); setDirectory(data.path); setError("");
    } catch (cause) { setError(String(cause)); }
  };
  const openSettings = () => {
    settingsReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSettingsTab("connection"); setShowKey(false); setSettingsFeedback(null);
    setSearchOpen(false); setShowSettings(true);
  };
  const createIn = async (workspace: string) => {
    if (!workspace || creating) return;
    setCreating(true);
    try {
      const draft = sessions.find((item) => item.workspace === workspace && !item.hasMessages);
      if (draft) await load(draft.id);
      else {
        const session = await api<Session>("/api/sessions", JsonBody({ workspace }));
        await refreshList(); await load(session.id);
      }
      setText(""); setImages([]); setShowNew(false); setSearchOpen(false); setError("");
    } catch (cause) { setError(String(cause)); }
    finally { setCreating(false); }
  };
  const newSession = () => { void createIn(directory.trim()); };
  const openDirectoryPicker = () => { setSearchOpen(false); setShowNew(true); void browse(); };
  const openNew = () => {
    const workspace = latestProjectRef.current || selected?.workspace || sessions[0]?.workspace;
    if (workspace) void createIn(workspace);
    else openDirectoryPicker();
  };
  const removeSession = async (id: string) => {
    if (!window.confirm("删除此会话及历史记录？工作目录中的文件不会删除。")) return;
    try {
      await api(`/api/sessions/${id}`, { method: "DELETE" });
      const list = await api<SessionItem[]>("/api/sessions"); setSessions(list);
      if (selected?.id === id) { if (list[0]) await load(list[0].id); else { setSelected(null); setEvents([]); } }
    } catch (cause) { setError(String(cause)); }
  };
  const upload = async (files: FileList | null) => {
    if (!files) return;
    try {
      const uploaded: ImageRef[] = [];
      for (const file of Array.from(files).slice(0, Math.max(0, 4 - images.length))) {
        const form = new FormData(); form.append("file", file);
        uploaded.push(await api<ImageRef>("/api/images", { method: "POST", body: form }));
      }
      setImages((current) => [...current, ...uploaded]); setError("");
    } catch (cause) { setError(String(cause)); }
    if (fileInput.current) fileInput.current.value = "";
  };
  const send = async (override?: string) => {
    if (!selected || busy) return;
    const prompt = (override ?? text).trim();
    if (!prompt && !images.length) return;
    if (!hasKey) { setText(prompt); openSettings(); setSettingsFeedback({ kind: "error", message: "请先配置 DeepSeek API Key" }); return; }
    setBusy(true); setStatus("连接中"); setDraftAnswer(""); setDraftReasoning(""); setError("");
    setText(""); const attached = images; setImages([]);
    let failed = false;
    let listed = false;
    try {
      const response = await fetch(`/api/sessions/${selected.id}/runs`, JsonBody({ text: prompt, images: attached }));
      if (!response.ok) { const data = await response.json(); throw new Error(data.error || "运行失败"); }
      const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = "";
      const receive = (line: string) => {
        if (!line) return;
        const item = JSON.parse(line) as LiveEvent;
        if (item.type === "event") {
          if (item.event.type === "error") { failed = true; setError(item.event.text || "模型请求失败"); }
          if (item.event.type === "user" && !listed) {
            listed = true;
            setSelected((current) => current?.id === selected.id && current.messages.length === 0 ? { ...current, title: prompt.slice(0, 28) || "图片任务" } : current);
            void refreshList().catch((cause) => setError(String(cause)));
          }
          setEvents((current) => {
            const index = current.findIndex((event) => event.id === item.event.id);
            if (index < 0) return [...current, item.event];
            const next = [...current]; next[index] = item.event; return next;
          });
          if (item.event.type === "answer") setDraftAnswer("");
          if (item.event.type === "reasoning") setDraftReasoning("");
        }
        if (item.type === "delta") item.field === "answer" ? setDraftAnswer((value) => value + item.text) : setDraftReasoning((value) => value + item.text);
        if (item.type === "status") { setStatus(item.status); if (item.occupancy !== undefined) setOccupancy(item.occupancy); }
      };
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true }); let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) { receive(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
      }
      if (buffer.trim()) receive(buffer);
      await load(selected.id); await refreshList();
      if (failed) { setText(prompt); setImages(attached); }
    } catch (cause) { setError(String(cause)); setText(prompt); setImages(attached); }
    finally { setBusy(false); setStatus("就绪"); setDraftAnswer(""); setDraftReasoning(""); }
  };
  const stop = async () => { if (selected) await api(`/api/sessions/${selected.id}/stop`, JsonBody({})); };
  const approve = async (id: string, approved: boolean) => {
    try { await api(`/api/approvals/${id}`, JsonBody({ approved })); } catch (cause) { setError(String(cause)); }
  };
  const updateSettings = async (patch: Partial<SessionSettings>) => {
    if (!selected || savingSettings) return;
    const sessionId = selected.id;
    setSavingSettings(true); setSettingsFeedback(null);
    setSelected((current) => current?.id === sessionId ? { ...current, settings: { ...current.settings, ...patch } } : current);
    try {
      const session = await api<Session>(`/api/sessions/${sessionId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      setSelected((current) => current?.id === sessionId ? session : current);
    } catch (cause) {
      if (patch.threshold !== undefined) setThresholdDraft(selected.settings.threshold);
      setSelected((current) => current?.id === sessionId ? { ...current, settings: selected.settings } : current);
      setSettingsFeedback({ kind: "error", message: String(cause) });
    }
    finally { setSavingSettings(false); }
  };
  const commitThreshold = () => {
    if (selected && thresholdDraft !== selected.settings.threshold) void updateSettings({ threshold: thresholdDraft });
  };
  const saveKey = async () => {
    if (!key.trim() || savingKey) return;
    setSavingKey(true); setSettingsFeedback(null);
    try {
      const result = await api<{ hasApiKey: boolean }>("/api/config", JsonBody({ apiKey: key }));
      setHasKey(result.hasApiKey); setKey(""); setShowKey(false);
      setSettingsFeedback({ kind: "success", message: "API Key 已保存" }); setError("");
    } catch (cause) { setSettingsFeedback({ kind: "error", message: String(cause) }); }
    finally { setSavingKey(false); }
  };

  const historySessions = sessions.filter((item) => item.hasMessages);
  const projects = sessions.filter((item, index) => sessions.findIndex((other) => other.workspace === item.workspace) === index);
  const matchingProjects = projects.filter((item) => item.workspace.toLowerCase().includes(projectQuery.trim().toLowerCase()));
  const matchingBranches = (gitInfo?.isRepository ? Array.from(new Set([gitInfo.branch, ...gitInfo.branches])) : []).filter((branch) => branch.toLowerCase().includes(branchQuery.trim().toLowerCase()));
  const usedTokens = Math.max(0, Math.round(occupancy * contextBudget));
  const percentUsed = Math.round(occupancy * 100);
  const canSend = Boolean(text.trim() || images.length);
  const workspaceName = (path: string) => path.split("/").filter(Boolean).pop() || path;
  const searchResults = historySessions.filter((item) => `${item.title} ${item.workspace}`.toLowerCase().includes(searchQuery.trim().toLowerCase())).slice(0, 8);
  const searchActions = [
    { label: "新聊天", icon: FilePenLine, run: () => { setSearchOpen(false); openNew(); } },
    { label: "打开文件夹", icon: Folder, run: openDirectoryPicker },
    { label: "设置", icon: Settings2, run: openSettings },
  ].filter((item) => item.label.includes(searchQuery.trim()));
  const searchCount = searchResults.length + searchActions.length;
  const chooseSearchItem = (index: number) => {
    if (index < searchResults.length) { setSearchOpen(false); void load(searchResults[index].id); }
    else searchActions[index - searchResults.length]?.run();
  };
  const toggleProject = (workspace: string) => {
    rememberProject(workspace);
    setCollapsedProjects((current) => current.includes(workspace) ? current.filter((path) => path !== workspace) : [...current, workspace]);
  };
  const selectComposerProject = (workspace: string) => { setComposerMenu(null); void createIn(workspace); };
  const setEffort = (value: ReasoningEffort) => {
    if (value === selected?.settings.reasoningEffort || busy || savingSettings) return;
    void updateSettings({ reasoningEffort: value });
  };
  const toggleComposerMenu = (menu: "project" | "branch" | "effort", trigger: HTMLButtonElement) => {
    composerReturnFocus.current = trigger;
    setProjectQuery(""); setBranchQuery("");
    setComposerMenu((current) => current === menu ? null : menu);
  };
  const toggleSidebar = () => {
    if (window.matchMedia("(max-width: 650px)").matches) setSidebarOpen((current) => !current);
    else {
      const visible = !sidebarVisible;
      if (visible) {
        sidebarWidthRef.current = expandedSidebarWidthRef.current;
        setSidebarWidth(expandedSidebarWidthRef.current);
      }
      setSidebarVisible(visible);
      window.localStorage.setItem("simple-agent:sidebar-visible", String(visible));
    }
  };

  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? "open" : ""} ${sidebarVisible ? "" : "desktop-collapsed"} ${resizingSidebar ? "resizing" : ""}`} style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <div className="brand"><div><strong>Simple Agent</strong></div><button className="icon-btn sidebar-search-toggle" title="搜索会话 (Ctrl+K)" aria-label="搜索会话" onClick={() => { setSearchOpen(true); setSearchQuery(""); setSearchIndex(0); }}><Search size={18} /></button><button className="icon-btn mobile-only" title="关闭侧栏" onClick={() => setSidebarOpen(false)}><X size={18} /></button></div>
      <button className="new-button" onClick={openNew} disabled={creating} title={latestProject ? `在 ${workspaceName(latestProject)} 中新建聊天` : "新建聊天"}><FilePenLine size={18} /> 新聊天</button>
      <nav className="session-list" aria-label="会话">
        <div className="sidebar-heading">项目</div>
        {projects.map((item, index) => <div className="project-group" key={item.workspace}>
          <button className={`project-row ${latestProject === item.workspace ? "selected-project" : ""}`} onClick={() => toggleProject(item.workspace)} title={item.workspace} aria-expanded={!collapsedProjects.includes(item.workspace)} aria-controls={`project-sessions-${index}`}><Folder size={17} /><span>{workspaceName(item.workspace)}</span><ChevronDown size={15} className={`project-chevron ${collapsedProjects.includes(item.workspace) ? "collapsed" : ""}`} /></button>
          <div id={`project-sessions-${index}`} className={`project-sessions ${collapsedProjects.includes(item.workspace) ? "collapsed" : ""}`} aria-hidden={collapsedProjects.includes(item.workspace)} inert={collapsedProjects.includes(item.workspace)}><div className="project-sessions-inner">
            {historySessions.filter((session) => session.workspace === item.workspace).map((session) => <div key={session.id} className={`session-row project-session ${selected?.id === session.id ? "active" : ""}`}><button onClick={() => void load(session.id)} title={session.title}><span>{session.title}</span></button><button className="session-delete" title="删除会话" onClick={() => void removeSession(session.id)}><Trash2 size={14} /></button></div>)}
          </div></div>
        </div>)}
        {historySessions.length > 0 && <><div className="sidebar-heading recent-heading">最近</div>{historySessions.slice(0, 5).map((item) => <div key={`recent-${item.id}`} className="session-row recent-session"><button onClick={() => void load(item.id)} title={item.title}><span>{item.title}</span></button></div>)}</>}
      </nav>
      <div className="sidebar-footer"><span className={`status-dot ${hasKey ? "ready" : ""}`} />{hasKey ? "DeepSeek 已配置" : "等待配置 API Key"}</div>
      <div className="sidebar-resizer" role="separator" aria-label="调整侧边栏宽度" aria-orientation="vertical" aria-valuemin={0} aria-valuemax={520} aria-valuenow={sidebarWidth} tabIndex={0} onPointerDown={(event) => { event.preventDefault(); closingSidebarRef.current = false; setResizingSidebar(true); }} onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); resizeSidebar(sidebarWidthRef.current + (event.key === "ArrowRight" ? 20 : -20), true); }
        if (event.key === "Home") { event.preventDefault(); resizeSidebar(0, true); }
      }} />
    </aside>
    <main className="main-pane">
      <header className="topbar"><button className="icon-btn sidebar-toggle" title="切换侧边栏" aria-label="切换侧边栏" onClick={toggleSidebar}><PanelLeft size={19} /></button><div className="topbar-title">{selected && <strong>{selected.title}</strong>}</div><div className="topbar-right"><button ref={settingsTrigger} className="icon-btn" title="设置" aria-label="设置" onClick={openSettings}><Settings2 size={18} /></button></div></header>
      {error && <div className="global-error"><AlertCircle size={17} />{error}<button title="关闭提示" onClick={() => setError("")}><X size={16} /></button></div>}
      <div className="timeline">
        {!selected ? <div className="empty-state"><div className="empty-icon"><Code2 size={29} /></div><h1>你想让我们构建什么？</h1><button className="btn primary" onClick={openNew} disabled={creating}><Plus size={16} /> 新聊天</button></div> : events.length === 0 ? <div className="empty-state"><div className="empty-icon"><Code2 size={29} /></div><h1>你想在 <span>{workspaceName(selected.workspace)}</span> 中构建什么？</h1></div> : <div className="event-list">{events.map((event) => <EventRow key={event.id} event={event} onApprove={approve} running={busy} />)}{draftReasoning && <div className="event compact-event streaming"><div className="disclosure">思考中…</div><pre className="detail-text">{draftReasoning}</pre></div>}{draftAnswer && <div className="event answer-event streaming"><div className="event-label">AGENT</div><div className="markdown"><Markdown text={draftAnswer} /></div></div>}<div ref={bottom} /></div>}
      </div>
      {selected && <div ref={composerArea} className="composer-area">
        {events.length === 0 && <div className="composer-context">
          <div className="composer-menu-anchor">
            <button className={`composer-context-button ${composerMenu === "project" ? "active" : ""}`} aria-label="选择项目" aria-expanded={composerMenu === "project"} onClick={(event) => toggleComposerMenu("project", event.currentTarget)}><Folder size={18} /><span>{workspaceName(selected.workspace)}</span></button>
            {composerMenu === "project" && <div className="composer-popover project-popover"><div className="composer-search"><Search size={17} /><input ref={projectSearch} aria-label="搜索项目" placeholder="搜索项目" value={projectQuery} onChange={(event) => setProjectQuery(event.target.value)} /></div><div className="composer-popover-list">{matchingProjects.map((item) => <button key={item.workspace} onClick={() => selectComposerProject(item.workspace)} title={item.workspace}><Folder size={17} /><span>{workspaceName(item.workspace)}</span>{item.workspace === selected.workspace && <Check size={16} />}</button>)}{matchingProjects.length === 0 && <p>没有匹配的项目</p>}</div><button className="composer-popover-action" onClick={() => { setComposerMenu(null); openDirectoryPicker(); }}><Plus size={18} />选择现有目录</button></div>}
          </div>
          <div className="composer-menu-anchor">
            <button className={`composer-context-button ${composerMenu === "branch" ? "active" : ""}`} aria-label="查看 Git 分支" aria-expanded={composerMenu === "branch"} onClick={(event) => toggleComposerMenu("branch", event.currentTarget)}><GitBranch size={17} /><span>{gitInfo?.isRepository ? gitInfo.branch : "无 Git"}</span></button>
            {composerMenu === "branch" && <div className="composer-popover branch-popover">{gitInfo?.isRepository ? <><div className="composer-search"><Search size={17} /><input ref={branchSearch} aria-label="搜索分支" placeholder="搜索分支" value={branchQuery} onChange={(event) => setBranchQuery(event.target.value)} /></div><div className="composer-popover-label">分支</div><div className="composer-popover-list">{matchingBranches.map((branch) => <div className="composer-branch" key={branch}><GitBranch size={16} /><span>{branch}{branch === gitInfo.branch && <small>未提交：{gitInfo.changedFiles} 个文件</small>}</span>{branch === gitInfo.branch && <Check size={16} />}</div>)}{matchingBranches.length === 0 && <p>没有匹配的分支</p>}</div></> : <p className="composer-popover-empty">当前目录不是 Git 仓库</p>}</div>}
          </div>
        </div>}
        <div className={`composer ${events.length === 0 ? "with-context" : ""}`}>
          {images.length > 0 && <div className="attachments">{images.map((image) => <div className="attachment" key={image.id} title={image.name}><img src={`/api/images/${image.id}`} alt={image.name} /><button type="button" title={`移除 ${image.name}`} aria-label={`移除 ${image.name}`} onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))}><X size={15} /></button></div>)}</div>}
          <textarea ref={composerInput} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} placeholder="随心输入" rows={1} disabled={busy} />
          <div className="composer-actions">
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(event) => void upload(event.target.files)} />
            <button className="icon-btn add-image" title="添加图片" aria-label="添加图片" disabled={busy || images.length >= 4} onClick={() => fileInput.current?.click()}><Plus size={21} /></button>
            <span className="composer-live-status" aria-live="polite">{busy ? status : ""}</span>
            <div className="context-meter" tabIndex={0} aria-label={`上下文容量：已用约 ${usedTokens.toLocaleString()} 标记，共 ${contextBudget.toLocaleString()} 标记，${percentUsed}% 已用`}><span className="context-ring" style={{ "--context-fill": `${Math.min(100, Math.max(0, percentUsed))}%` } as CSSProperties} /><div className="context-tooltip" role="tooltip"><span>背景信息窗口：</span><span>{percentUsed}% 已用</span><strong>已用 {usedTokens.toLocaleString()} 标记，共 {contextBudget.toLocaleString()}</strong></div></div>
            <div className="composer-menu-anchor effort-anchor">
              <button ref={effortTrigger} className={`effort-button ${composerMenu === "effort" ? "active" : ""}`} aria-label={`思考强度：${effortLabels[selected.settings.reasoningEffort]}`} aria-expanded={composerMenu === "effort"} disabled={busy} onClick={(event) => toggleComposerMenu("effort", event.currentTarget)}>DeepSeek {effortLabels[selected.settings.reasoningEffort]}</button>
              {composerMenu === "effort" && <div className="composer-popover effort-popover">
                <div className="effort-heading"><strong>{effortLabels[effortLevels[effortDraft]]}</strong><span>deepseek-flash</span><button className="effort-reset" title="恢复默认思考强度" aria-label="恢复默认思考强度" disabled={busy || savingSettings} onClick={() => { setEffortDraft(2); setEffort("high"); }}><RotateCcw size={17} /></button></div>
                <div className="effort-track" style={{ "--effort-fill": `${effortDraft / 3 * 100}%` } as CSSProperties}>
                  <div className="effort-ticks" aria-hidden="true">{effortLevels.map((level) => <i key={level} />)}</div>
                  <input className="effort-slider" type="range" min={0} max={3} step={1} value={effortDraft} aria-label="思考强度" aria-valuetext={effortLabels[effortLevels[effortDraft]]} aria-busy={savingSettings} disabled={busy} onChange={(event) => setEffortDraft(Number(event.target.value))} onPointerUp={(event) => setEffort(effortLevels[Number(event.currentTarget.value)])} onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) setEffort(effortLevels[Number(event.currentTarget.value)]); }} onBlur={(event) => setEffort(effortLevels[Number(event.currentTarget.value)])} />
                </div>
                {settingsFeedback?.kind === "error" && <p className="effort-error" role="alert">{settingsFeedback.message}</p>}
              </div>}
            </div>
            {busy ? <button className="send-button stop" title="停止生成" aria-label="停止生成" onClick={() => void stop()}><Square size={16} /></button> : <button className="send-button" title="发送" aria-label="发送" disabled={!canSend} onClick={() => void send()}><ArrowDown className="send-arrow" size={18} /></button>}
          </div>
        </div>
      </div>}
    </main>
    <div className={`search-backdrop ${searchOpen ? "open" : ""}`} aria-hidden={!searchOpen} inert={!searchOpen} onMouseDown={(event) => { if (event.target === event.currentTarget) setSearchOpen(false); }}>
      <section className="search-dialog" role="dialog" aria-modal="true" aria-label="搜索聊天">
        <div className="search-input-row"><Search size={20} /><input ref={searchInput} aria-label="搜索聊天" placeholder="搜索聊天" value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value); setSearchIndex(0); }} onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setSearchIndex((index) => searchCount ? (index + 1) % searchCount : 0); }
          if (event.key === "ArrowUp") { event.preventDefault(); setSearchIndex((index) => searchCount ? (index - 1 + searchCount) % searchCount : 0); }
          if (event.key === "Enter" && searchCount) { event.preventDefault(); chooseSearchItem(searchIndex); }
        }} /><button className="search-close" title="关闭搜索" aria-label="关闭搜索" onClick={() => setSearchOpen(false)}><X size={18} /></button></div>
        <div className="search-results">
          {searchResults.length > 0 && <div className="search-group-label">聊天</div>}
          {searchResults.map((item, index) => <button key={item.id} className={`search-result ${searchIndex === index ? "highlighted" : ""}`} onMouseEnter={() => setSearchIndex(index)} onClick={() => chooseSearchItem(index)}><span className="search-result-title">{item.title}</span><span className="search-result-project">{workspaceName(item.workspace)}</span></button>)}
          {searchActions.length > 0 && <div className="search-group-label">快捷操作</div>}
          {searchActions.map((item, index) => <button key={item.label} className={`search-result search-action ${searchIndex === searchResults.length + index ? "highlighted" : ""}`} onMouseEnter={() => setSearchIndex(searchResults.length + index)} onClick={() => chooseSearchItem(searchResults.length + index)}><item.icon size={17} /><span className="search-result-title">{item.label}</span></button>)}
          {searchCount === 0 && <div className="search-empty">没有匹配的聊天</div>}
        </div>
      </section>
    </div>
    <div className={`settings-backdrop ${showSettings ? "open" : ""}`} aria-hidden={!showSettings} inert={!showSettings} onMouseDown={(event) => { if (event.target === event.currentTarget) setShowSettings(false); }}>
      <section ref={settingsDialog} className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); setShowSettings(false); }
        if (event.key !== "Tab") return;
        const focusable = Array.from(settingsDialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") || []).filter((item) => item.offsetParent !== null);
        if (!focusable.length) return;
        if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable[focusable.length - 1].focus(); }
        else if (!event.shiftKey && document.activeElement === focusable[focusable.length - 1]) { event.preventDefault(); focusable[0].focus(); }
      }}>
        <header className="settings-head"><h2 id="settings-title">设置</h2><button ref={settingsClose} className="settings-close" title="关闭设置" aria-label="关闭设置" onClick={() => setShowSettings(false)}><X size={19} /></button></header>
        <div className="settings-tabs" role="tablist" aria-label="设置分类" onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]"));
          const current = tabs.indexOf(event.target as HTMLButtonElement);
          if (current < 0) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
          setSettingsTab(next === 0 ? "connection" : "session"); setSettingsFeedback(null); tabs[next].focus();
        }}>
          <button id="settings-tab-connection" role="tab" tabIndex={settingsTab === "connection" ? 0 : -1} aria-selected={settingsTab === "connection"} aria-controls="settings-panel-connection" className={settingsTab === "connection" ? "active" : ""} onClick={() => { setSettingsTab("connection"); setSettingsFeedback(null); }}>模型连接</button>
          <button id="settings-tab-session" role="tab" tabIndex={settingsTab === "session" ? 0 : -1} aria-selected={settingsTab === "session"} aria-controls="settings-panel-session" className={settingsTab === "session" ? "active" : ""} onClick={() => { setSettingsTab("session"); setSettingsFeedback(null); }}>当前会话</button>
        </div>
        <div className={`settings-content ${savingSettings ? "saving" : ""}`}>
          {settingsFeedback && <div className={`settings-feedback ${settingsFeedback.kind}`} role={settingsFeedback.kind === "error" ? "alert" : "status"}>{settingsFeedback.kind === "error" ? <AlertCircle size={17} /> : <Check size={17} />}{settingsFeedback.message}</div>}
          <div id="settings-panel-connection" role="tabpanel" aria-labelledby="settings-tab-connection" hidden={settingsTab !== "connection"}>
            <div className="settings-model-row"><div><span>模型</span><strong>deepseek-flash</strong></div><span className={`settings-key-status ${hasKey ? "configured" : ""}`}>{hasKey ? "已配置" : "未配置密钥"}</span></div>
            <form className="settings-key-form" onSubmit={(event) => { event.preventDefault(); void saveKey(); }}>
              <label htmlFor="api-key">DeepSeek API Key</label>
              <div className="settings-key-row"><div className="settings-key-input"><input id="api-key" type={showKey ? "text" : "password"} autoComplete="off" value={key} onChange={(event) => { setKey(event.target.value); setSettingsFeedback(null); }} placeholder={hasKey ? "输入新 Key 以替换" : "sk-..."} /><button type="button" title={showKey ? "隐藏密钥" : "显示密钥"} aria-label={showKey ? "隐藏密钥" : "显示密钥"} onClick={() => setShowKey((current) => !current)}>{showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button></div><button className="settings-save" type="submit" disabled={!key.trim() || savingKey}>{savingKey ? "保存中…" : "保存"}</button></div>
              <p>密钥仅存于服务端进程内。重启后需重新填写，或使用环境变量。</p>
            </form>
          </div>
          <div id="settings-panel-session" role="tabpanel" aria-labelledby="settings-tab-session" hidden={settingsTab !== "session"}>
            {selected ? <><div className="settings-session-name" title={selected.title}>{selected.title}</div>
              <div className="settings-reasoning-row"><div><strong>思考强度</strong><span>控制模型处理复杂任务时的思考量</span></div><strong>{effortLabels[selected.settings.reasoningEffort]}</strong></div>
              <label className="settings-switch-row"><div><strong>上下文压缩</strong><span>达到阈值后保留关键任务信息</span></div><input type="checkbox" checked={selected.settings.compression} disabled={busy || savingSettings} onChange={(event) => void updateSettings({ compression: event.target.checked })} /><span className="settings-switch" aria-hidden="true" /></label>
              <SettingStepper id="attempts" label="失败尝试上限" value={selected.settings.maxAttempts} min={1} max={10} disabled={busy || savingSettings} onChange={(value) => void updateSettings({ maxAttempts: value })} />
              <div className="settings-threshold"><div><label htmlFor="threshold">压缩阈值</label><output htmlFor="threshold">{Math.round(thresholdDraft * 100)}%</output></div><input id="threshold" type="range" min="0.1" max="0.95" step="0.05" disabled={busy || savingSettings} value={thresholdDraft} onChange={(event) => setThresholdDraft(Number(event.target.value))} onPointerUp={commitThreshold} onKeyUp={commitThreshold} onBlur={commitThreshold} /></div>
            </> : <div className="settings-no-session">新建会话后可调整会话设置。</div>}
          </div>
        </div>
        <footer className="settings-footer"><AlertCircle size={17} /><p>批准 Shell 命令后，它将以当前用户权限运行，可能访问工作区外资源。请先核对命令。</p></footer>
      </section>
    </div>
    {showNew && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowNew(false); }}><div className="directory-modal"><div className="modal-head"><div><span className="eyebrow">工作区</span><h2>新建会话</h2></div><button className="icon-btn" title="关闭" onClick={() => setShowNew(false)}><X size={18} /></button></div><p>选择已有本机目录。文件工具仅在该目录内读写，Shell 命令逐条请求批准。</p><label htmlFor="directory-path">目录绝对路径</label><div className="path-row"><input id="directory-path" value={directory} onChange={(event) => setDirectory(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void browse(); }} placeholder="/home/user/project" /><button className="btn" onClick={() => void browse()}>浏览</button></div>{error && <div className="inline-error"><AlertCircle size={15} />{error}</div>}{browser && <div className="folder-list"><button onClick={() => void browse(browser.parent)}><ChevronLeft size={16} /> 上一级</button>{browser.entries.map((name) => <button key={name} onClick={() => void browse(pathJoin(browser.path, name))}><Folder size={16} />{name}<ChevronRight size={14} /></button>)}{browser.entries.length === 0 && <span className="muted">此目录没有子目录</span>}</div>}<div className="modal-actions"><button className="btn" onClick={() => setShowNew(false)}>取消</button><button className="btn primary" disabled={!directory.trim()} onClick={() => void newSession()}><Check size={16} /> 使用此目录</button></div></div></div>}
  </div>;
}

function pathJoin(parent: string, name: string): string { return `${parent.replace(/\/$/, "")}/${name}`; }
