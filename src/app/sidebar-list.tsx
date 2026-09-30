"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, ChevronDown, Ellipsis, Folder, FolderOpen, Info, MessageCircle, Pin, PinOff, Settings2, Trash2, X } from "lucide-react";
import type { Project, Session } from "@/lib/types";

type Item = Pick<Session, "id" | "title" | "workspace" | "updatedAt" | "pinned">;
type Popup = { kind: "project" | "session" | "menu"; project: Project; session?: Item; anchor: HTMLElement };
type Props = {
  projects: Project[]; sessions: Item[]; selectedId?: string; collapsed: string[];
  toggle: (workspace: string) => void; load: (id: string) => void;
  pinSession: (id: string, pinned: boolean) => void; removeSession: (id: string) => void;
  action: (workspace: string, action: string, extra?: Record<string, unknown>) => Promise<void>;
  rename: (project: Project) => void;
};

export default function SidebarList(props: Props) {
  const [popup, setPopup] = useState<Popup | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissed = useRef<HTMLElement | null>(null);
  const cancel = () => { if (timer.current) clearTimeout(timer.current); };
  const close = () => { cancel(); setPopup(null); };
  const show = (next: Popup) => {
    cancel();
    if (dismissed.current === next.anchor || (popup?.kind === "menu" && next.kind !== "menu")) return;
    setPopup(next);
  };
  const leave = () => { cancel(); timer.current = setTimeout(() => setPopup((current) => current?.kind === "menu" ? current : null), 180); };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!popup) return;
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !popup.anchor.contains(event.target as Node)) {
        dismissed.current = popup.anchor; close();
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); dismissed.current = popup.anchor; close(); popup.anchor.querySelector<HTMLButtonElement>("button")?.focus(); }
      if (event.key === "Tab" && popup.kind === "menu" && panel.current) {
        const buttons = Array.from(panel.current.querySelectorAll<HTMLButtonElement>("button"));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        event.preventDefault(); buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
    };
    const moved = () => close();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", moved);
    document.addEventListener("scroll", moved, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); window.removeEventListener("resize", moved); document.removeEventListener("scroll", moved, true); };
  }, [popup]);
  useLayoutEffect(() => {
    if (!popup || !panel.current) return;
    const rect = popup.anchor.getBoundingClientRect();
    const box = panel.current.getBoundingClientRect();
    const mobile = window.innerWidth <= 650;
    const left = mobile ? 12 : popup.kind === "menu" ? rect.right - 36 : rect.right + 4;
    const top = mobile ? rect.bottom + 6 : popup.kind === "menu" ? rect.bottom + 4 : rect.top;
    setPosition({ left: Math.max(12, Math.min(left, window.innerWidth - box.width - 12)), top: Math.max(12, Math.min(top, window.innerHeight - box.height - 12)) });
    if (popup.kind === "menu") panel.current.querySelector<HTMLButtonElement>("button")?.focus();
  }, [popup]);
  const bindings = (value: Omit<Popup, "anchor">) => ({
    onPointerEnter: (event: React.PointerEvent<HTMLDivElement>) => { dismissed.current = null; if (event.pointerType === "mouse") show({ ...value, anchor: event.currentTarget }); },
    onPointerLeave: leave,
    onFocus: (event: React.FocusEvent<HTMLDivElement>) => show({ ...value, anchor: event.currentTarget }),
    onBlur: (event: React.FocusEvent<HTMLDivElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node) && !panel.current?.contains(event.relatedTarget as Node)) leave(); },
  });
  const sorted = (items: Item[]) => items.slice().sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  const act = (action: string, extra?: Record<string, unknown>) => { if (!popup) return; const workspace = popup.project.workspace; close(); void props.action(workspace, action, extra); };
  const row = (session: Item, project: Project, recent = false) => <div key={`${recent ? "recent-" : ""}${session.id}`} className={`session-row-wrap ${props.selectedId === session.id ? "active" : ""}`} {...bindings({kind: "session", project, session})}>
    <div className={`session-row ${recent ? "recent-session" : "project-session"}`}><button onClick={() => { close(); props.load(session.id); }}><span>{session.title}</span></button><div className="session-actions">
      <button title="会话详情" aria-label="会话详情" className="sidebar-touch-info" onClick={(event) => { dismissed.current = null; show({kind: "session", project, session, anchor: event.currentTarget.closest(".session-row-wrap") as HTMLElement}); }}><Info size={14} /></button>
      <button title={session.pinned ? "取消置顶" : "置顶会话"} aria-label={session.pinned ? "取消置顶" : "置顶会话"} onClick={() => props.pinSession(session.id, !session.pinned)}>{session.pinned ? <PinOff size={15} /> : <Pin size={15} />}</button>
      <button title="删除会话" aria-label="删除会话" onClick={() => { close(); props.removeSession(session.id); }}><Trash2 size={15} /></button>
    </div></div>
  </div>;
  return <>
    <nav className="session-list" aria-label="会话"><div className="sidebar-heading">项目</div>
      {props.projects.map((project, index) => <div className="project-group" key={project.workspace}>
        <div className="project-row-wrap" {...bindings({kind: "project", project})}>
          <button className="project-row" aria-expanded={!props.collapsed.includes(project.workspace)} aria-controls={`project-sessions-${index}`} onClick={() => props.toggle(project.workspace)}><Folder size={18}/><span>{project.name}</span><ChevronDown size={14} className={`project-chevron ${props.collapsed.includes(project.workspace) ? "collapsed" : ""}`}/></button>
          <button className="sidebar-touch-info project-info" aria-label="项目详情" title="项目详情" onClick={(event) => { dismissed.current = null; show({kind:"project",project,anchor:event.currentTarget.parentElement!}); }}><Info size={16}/></button>
          <button className="project-menu-trigger" aria-label={`${project.name} 项目操作`} title="项目操作" aria-haspopup="menu" aria-expanded={popup?.kind === "menu" && popup.project.workspace === project.workspace} onClick={(event) => { cancel(); dismissed.current = null; setPopup(popup?.kind === "menu" && popup.project.workspace === project.workspace ? null : {kind:"menu",project,anchor:event.currentTarget.parentElement!}); }}><Ellipsis size={18}/></button>
        </div>
        <div id={`project-sessions-${index}`} className={`project-sessions ${props.collapsed.includes(project.workspace) ? "collapsed" : ""}`} aria-hidden={props.collapsed.includes(project.workspace)} inert={props.collapsed.includes(project.workspace)}><div className="project-sessions-inner">{sorted(props.sessions.filter(session => session.workspace === project.workspace)).map(session => row(session,project))}</div></div>
      </div>)}
      {props.sessions.length > 0 && <><div className="sidebar-heading recent-heading">最近</div>{sorted(props.sessions).filter(session => props.projects.some(project => project.workspace === session.workspace)).slice(0,5).map(session => row(session,props.projects.find(project => project.workspace === session.workspace)!,true))}</>}
    </nav>
    {popup && createPortal(<div ref={panel} className={`sidebar-floating ${popup.kind === "menu" ? "project-menu" : popup.kind === "project" ? "project-detail-popover" : "session-detail-popover"}`} style={position} role={popup.kind === "menu" ? "menu" : "dialog"} aria-label={popup.kind === "session" ? "会话详情" : popup.kind === "project" ? "项目详情" : "项目操作"} onPointerEnter={cancel} onPointerLeave={leave}>
      {popup.kind === "project" ? <><div className="popover-title"><Folder size={20}/><strong>{popup.project.name}</strong><button className="popover-icon" title={popup.project.pinned ? "取消置顶" : "置顶项目"} onClick={() => act("pin",{pinned:!popup.project.pinned})}>{popup.project.pinned ? <PinOff size={18}/> : <Pin size={18}/>}</button></div><div className="popover-meta"><MessageCircle size={18}/>{props.sessions.filter(session => session.workspace === popup.project.workspace).length} 个任务</div><div className="popover-line"><Folder size={18}/><span>{popup.project.workspace}</span></div><button className="popover-action" onClick={() => { props.rename(popup.project); close(); }}><Settings2 size={18}/>编辑项目</button></> : popup.kind === "session" ? <><div className="session-detail-heading"><strong>{popup.session!.title}</strong><small>{new Intl.RelativeTimeFormat("zh-CN",{numeric:"auto"}).format(-Math.floor((Date.now()-Date.parse(popup.session!.updatedAt))/3600000),"hour")}</small></div><span className="session-detail-project"><Folder size={19}/>{popup.project.name}</span></> : <>
        <button role="menuitem" onClick={() => act("pin",{pinned:!popup.project.pinned})}><Pin size={19}/>{popup.project.pinned ? "取消置顶" : "置顶"}</button>
        <button role="menuitem" onClick={() => { props.rename(popup.project); close(); }}><Settings2 size={19}/>编辑</button>
        <button role="menuitem" onClick={() => act("open")}><FolderOpen size={19}/>在文件管理器中打开</button>
        <button role="menuitem" onClick={() => { if(window.confirm("归档此项目的全部聊天？")) act("archive"); }}><Archive size={19}/>归档聊天</button>
        <button role="menuitem" onClick={() => { if(window.confirm("移除项目并归档其中的聊天？")) act("remove"); }}><X size={19}/>移除项目</button>
      </>}
    </div>, document.body)}
  </>;
}
