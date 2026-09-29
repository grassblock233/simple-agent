"use client";

import { isValidElement, useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowDown, Check, ChevronDown, ChevronLeft, ChevronRight, Clipboard, Code2, Folder, FolderOpen, ImagePlus, Menu, PanelRightClose, Plus, Send, Settings2, Square, Terminal, Trash2, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import type { Event, ImageRef, LiveEvent, Session, SessionSettings } from "@/lib/types";

type SessionItem = Pick<Session, "id" | "title" | "workspace" | "createdAt" | "updatedAt">;
type BrowserState = { path: string; parent: string; entries: string[] };

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

function EventRow({ event, onApprove, running }: { event: Event; onApprove: (id: string, approved: boolean) => void; running: boolean }) {
  const [open, setOpen] = useState(event.type !== "reasoning");
  if (event.type === "user") return <div className="event user-event"><div className="event-label">你</div><div className="user-bubble">{event.text}{event.images?.map((image) => <img key={image.id} src={`/api/images/${image.id}`} alt={image.name} />)}</div></div>;
  if (event.type === "answer") return <div className="event answer-event"><div className="event-label">AGENT</div><div className="markdown"><Markdown text={event.text || ""} /></div></div>;
  if (event.type === "reasoning") return <div className="event compact-event"><button className="disclosure" onClick={() => setOpen(!open)}><ChevronRight className={open ? "rotated" : ""} size={15} />思考过程</button>{open && <pre className="detail-text">{event.text}</pre>}</div>;
  if (event.type === "tool") return <div className="event compact-event"><button className="disclosure" onClick={() => setOpen(!open)}><Terminal size={15} /><strong>{event.name}</strong><span className={`badge ${event.status}`}>{event.status === "pending" ? "执行中" : event.status === "success" ? "成功" : event.status === "denied" ? "已拒绝" : "失败"}</span><span className="muted">{event.durationMs === undefined ? "" : `${event.durationMs} ms`}</span><ChevronDown className={open ? "" : "closed"} size={14} /></button>{open && <div className="tool-details"><div><b>入参</b><pre>{event.args}</pre></div><div><b>结果</b><pre>{event.result || "等待结果…"}</pre></div></div>}</div>;
  if (event.type === "notice" && event.approvalId) return <div className="event approval-event"><div className="approval-title"><Terminal size={17} /> Shell 执行授权</div><p>批准后命令以当前用户权限运行，可能访问工作区外的文件和网络。</p><pre>{event.args}</pre><div className="approval-actions">{event.status === "pending" && running ? <><button className="btn primary" onClick={() => onApprove(event.approvalId!, true)}><Check size={16} /> 批准执行</button><button className="btn" onClick={() => onApprove(event.approvalId!, false)}><X size={16} /> 拒绝</button></> : <span className="muted">{event.status === "success" ? "已批准" : "已拒绝或过期"}</span>}</div></div>;
  if (event.type === "compression") return <div className="event compact-event"><button className="disclosure" onClick={() => setOpen(!open)}><ArrowDown size={15} />上下文压缩 · 消息 {event.range}<span className={`badge ${event.status}`}>{event.status === "failed" ? "已降级" : "完成"}</span></button>{open && <pre className="detail-text">{event.text}</pre>}</div>;
  return <div className={`event notice-event ${event.type === "error" || event.status === "failed" ? "error" : ""}`}><AlertCircle size={16} /><span>{event.text}</span></div>;
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
  const [draftAnswer, setDraftAnswer] = useState("");
  const [draftReasoning, setDraftReasoning] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [browser, setBrowser] = useState<BrowserState | null>(null);
  const [directory, setDirectory] = useState("");
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [error, setError] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refreshList = useCallback(async () => setSessions(await api<SessionItem[]>("/api/sessions")), []);
  const load = useCallback(async (id: string) => {
    const session = await api<Session & { running: boolean; occupancy: number }>(`/api/sessions/${id}`);
    setSelected(session); setEvents(session.events); setBusy(session.running);
    setOccupancy(session.occupancy);
    setSidebarOpen(false);
  }, []);
  useEffect(() => {
    void (async () => {
      try {
        const list = await api<SessionItem[]>("/api/sessions");
        setSessions(list);
        if (list[0]) await load(list[0].id);
        const config = await api<{ hasApiKey: boolean }>("/api/config");
        setHasKey(config.hasApiKey);
      } catch (cause) { setError(String(cause)); }
    })();
  }, [load]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [events, draftAnswer, draftReasoning]);

  const browse = async (target?: string) => {
    try {
      const data = await api<BrowserState>(`/api/fs/browse?path=${encodeURIComponent(target || directory || ".")}`);
      setBrowser(data); setDirectory(data.path); setError("");
    } catch (cause) { setError(String(cause)); }
  };
  const newSession = async () => {
    try {
      const session = await api<Session>("/api/sessions", JsonBody({ workspace: directory.trim() }));
      await refreshList(); await load(session.id); setShowNew(false); setError("");
    } catch (cause) { setError(String(cause)); }
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
    if (!hasKey) { setText(prompt); setError("请先在设置中配置 DeepSeek API Key"); setShowSettings(true); return; }
    setBusy(true); setStatus("连接中"); setDraftAnswer(""); setDraftReasoning(""); setError("");
    setText(""); const attached = images; setImages([]);
    let failed = false;
    try {
      const response = await fetch(`/api/sessions/${selected.id}/runs`, JsonBody({ text: prompt, images: attached }));
      if (!response.ok) { const data = await response.json(); throw new Error(data.error || "运行失败"); }
      const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = "";
      const receive = (line: string) => {
        if (!line) return;
        const item = JSON.parse(line) as LiveEvent;
        if (item.type === "event") {
          if (item.event.type === "error") { failed = true; setError(item.event.text || "模型请求失败"); }
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
    if (!selected) return;
    try {
      const session = await api<Session>(`/api/sessions/${selected.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      setSelected(session);
    } catch (cause) { setError(String(cause)); }
  };
  const saveKey = async () => {
    try { const result = await api<{ hasApiKey: boolean }>("/api/config", JsonBody({ apiKey: key })); setHasKey(result.hasApiKey); setKey(""); setError(""); } catch (cause) { setError(String(cause)); }
  };

  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
      <div className="brand"><div className="brand-mark"><Code2 size={19} /></div><div><strong>Simple Agent</strong><span>代码工作台</span></div><button className="icon-btn mobile-only" title="关闭侧栏" onClick={() => setSidebarOpen(false)}><X size={18} /></button></div>
      <button className="new-button" onClick={() => { setShowNew(true); void browse(); }}><Plus size={17} /> 新建会话</button>
      <div className="sidebar-heading">会话</div>
      <nav className="session-list">{sessions.map((item) => <div key={item.id} className={`session-row ${selected?.id === item.id ? "active" : ""}`}><button onClick={() => void load(item.id)}><span>{item.title}</span><small title={item.workspace}>{item.workspace}</small></button><button className="session-delete" title="删除会话" onClick={() => void removeSession(item.id)}><Trash2 size={14} /></button></div>)}</nav>
      <div className="sidebar-footer"><span className={`status-dot ${hasKey ? "ready" : ""}`} />{hasKey ? "DeepSeek 已配置" : "等待配置 API Key"}</div>
    </aside>
    <main className="main-pane">
      <header className="topbar"><button className="icon-btn mobile-only" title="打开侧栏" onClick={() => setSidebarOpen(true)}><Menu size={19} /></button><div className="topbar-title"><strong>{selected?.title || "选择工作目录"}</strong><span title={selected?.workspace}>{selected?.workspace || "新建会话后开始"}</span></div><div className="topbar-right"><span className="model-pill">deepseek-flash</span><div className="occupancy" title="上下文占用估算"><span>上下文 {Math.round(occupancy * 100)}%</span><i><b style={{ width: `${Math.min(100, occupancy * 100)}%` }} /></i></div><button className="icon-btn" title="设置" onClick={() => setShowSettings(true)}><Settings2 size={18} /></button></div></header>
      {error && <div className="global-error"><AlertCircle size={17} />{error}<button title="关闭提示" onClick={() => setError("")}><X size={16} /></button></div>}
      <div className="timeline">
        {!selected ? <div className="empty-state"><div className="empty-icon"><FolderOpen size={28} /></div><h1>选择工作目录</h1><p>每个会话都绑定一个本机目录。文件工具只访问该目录；Shell 执行前需单独批准。</p><button className="btn primary" onClick={() => { setShowNew(true); void browse(); }}><Plus size={16} /> 新建会话</button></div> : events.length === 0 ? <div className="empty-state"><div className="empty-icon"><Code2 size={28} /></div><h1>开始一个代码任务</h1><p>{selected.workspace}</p><div className="suggestions">{["写一个判断回文字符串的函数并带上单测", "查看这个项目并说明如何运行", "查找一个 bug，修复后运行测试"].map((example) => <button key={example} onClick={() => void send(example)}>{example}<ChevronRight size={15} /></button>)}</div></div> : <div className="event-list">{events.map((event) => <EventRow key={event.id} event={event} onApprove={approve} running={busy} />)}{draftReasoning && <div className="event compact-event streaming"><div className="disclosure">思考中…</div><pre className="detail-text">{draftReasoning}</pre></div>}{draftAnswer && <div className="event answer-event streaming"><div className="event-label">AGENT</div><div className="markdown"><Markdown text={draftAnswer} /></div></div>}<div ref={bottom} /></div>}
      </div>
      {selected && <div className="composer-area"><div className="composer-status"><span className={`status-dot ${busy ? "working" : "ready"}`} />{status}</div><div className="composer">{images.length > 0 && <div className="attachments">{images.map((image) => <div key={image.id}><img src={`/api/images/${image.id}`} alt={image.name} /><span>{image.name}</span><button title="移除图片" onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))}><X size={13} /></button></div>)}</div>}<textarea value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder="描述代码任务，或附上截图…" rows={3} disabled={busy} /><div className="composer-actions"><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(event) => void upload(event.target.files)} /><button className="icon-btn" title="添加图片" disabled={busy || images.length >= 4} onClick={() => fileInput.current?.click()}><ImagePlus size={19} /></button><span>Enter 发送 · Shift+Enter 换行</span>{busy ? <button className="send-button stop" title="停止生成" onClick={() => void stop()}><Square size={17} /></button> : <button className="send-button" title="发送" disabled={!text.trim() && images.length === 0} onClick={() => void send()}><Send size={18} /></button>}</div></div></div>}
    </main>
    {showSettings && <><div className="scrim" onClick={() => setShowSettings(false)} /><aside className="settings-panel"><div className="panel-head"><div><span className="eyebrow">偏好</span><h2>设置</h2></div><button className="icon-btn" title="关闭设置" onClick={() => setShowSettings(false)}><PanelRightClose size={18} /></button></div><div className="panel-body"><h3>模型连接</h3><div className="field"><label>模型</label><div className="read-only-field">deepseek-flash</div></div><div className="field"><label htmlFor="api-key">DeepSeek API Key</label><div className="key-row"><input id="api-key" type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder={hasKey ? "已配置 · 输入新 Key 可替换" : "sk-..."} /><button className="btn" onClick={() => void saveKey()} disabled={!key.trim()}>保存</button></div><small>仅存于服务端进程内；重启后需重新填写，或使用环境变量。</small></div><h3>当前会话</h3>{selected ? <><label className="switch-row"><div><strong>思考模式</strong><span>显示可折叠的思考过程</span></div><input type="checkbox" checked={selected.settings.thinking} disabled={busy} onChange={(event) => void updateSettings({ thinking: event.target.checked })} /></label><label className="switch-row"><div><strong>上下文压缩</strong><span>达到阈值后保留关键任务信息</span></div><input type="checkbox" checked={selected.settings.compression} disabled={busy} onChange={(event) => void updateSettings({ compression: event.target.checked })} /></label><div className="field"><label htmlFor="attempts">失败尝试上限</label><input id="attempts" type="number" min={1} max={10} disabled={busy} value={selected.settings.maxAttempts} onChange={(event) => void updateSettings({ maxAttempts: Number(event.target.value) })} /></div><div className="field"><label htmlFor="rounds">工具轮数上限</label><input id="rounds" type="number" min={1} max={40} disabled={busy} value={selected.settings.maxToolRounds} onChange={(event) => void updateSettings({ maxToolRounds: Number(event.target.value) })} /></div><div className="field"><label htmlFor="threshold">压缩阈值 · {Math.round(selected.settings.threshold * 100)}%</label><input id="threshold" type="range" min="0.1" max="0.95" step="0.05" disabled={busy} value={selected.settings.threshold} onChange={(event) => void updateSettings({ threshold: Number(event.target.value) })} /></div></> : <p className="muted">新建会话后可调整。</p>}<div className="safety-note"><AlertCircle size={18} /><p>批准 Shell 命令后，它将以当前用户权限在本机运行，可能访问工作区外资源。请在批准前核对命令。</p></div></div></aside></>}
    {showNew && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowNew(false); }}><div className="directory-modal"><div className="modal-head"><div><span className="eyebrow">工作区</span><h2>新建会话</h2></div><button className="icon-btn" title="关闭" onClick={() => setShowNew(false)}><X size={18} /></button></div><p>选择已有本机目录。文件工具仅在该目录内读写，Shell 命令逐条请求批准。</p><label htmlFor="directory-path">目录绝对路径</label><div className="path-row"><input id="directory-path" value={directory} onChange={(event) => setDirectory(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void browse(); }} placeholder="/home/user/project" /><button className="btn" onClick={() => void browse()}>浏览</button></div>{error && <div className="inline-error"><AlertCircle size={15} />{error}</div>}{browser && <div className="folder-list"><button onClick={() => void browse(browser.parent)}><ChevronLeft size={16} /> 上一级</button>{browser.entries.map((name) => <button key={name} onClick={() => void browse(pathJoin(browser.path, name))}><Folder size={16} />{name}<ChevronRight size={14} /></button>)}{browser.entries.length === 0 && <span className="muted">此目录没有子目录</span>}</div>}<div className="modal-actions"><button className="btn" onClick={() => setShowNew(false)}>取消</button><button className="btn primary" disabled={!directory.trim()} onClick={() => void newSession()}><Check size={16} /> 使用此目录</button></div></div></div>}
  </div>;
}

function pathJoin(parent: string, name: string): string { return `${parent.replace(/\/$/, "")}/${name}`; }
