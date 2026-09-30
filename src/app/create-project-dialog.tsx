"use client";

import { useEffect, useRef, useState } from "react";
import { Folder, FolderPlus, LoaderCircle, X } from "lucide-react";
import type { DirectorySelectionResult, ProjectCreationResult } from "@/lib/types";

type Props = { open: boolean; initialPath?: string; onClose: () => void; onCreated: (result: ProjectCreationResult) => Promise<void> };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "请求失败");
  return body;
}

export default function CreateProjectDialog({ open, initialPath, onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [error, setError] = useState("");
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const nameEdited = useRef(false);
  const selectionRequest = useRef<AbortController | null>(null);
  const savingRef = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setName(""); setFolder(""); setError(""); setPicking(false);
    nameEdited.current = false;
    nameInput.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!savingRef.current) closeRef.current();
      }
      if (event.key === "Tab") {
        const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]') || []).filter(element => element.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      selectionRequest.current?.abort();
      document.removeEventListener("keydown", keydown, true);
      if (previousFocus?.isConnected && !previousFocus.closest('[inert]')) previousFocus.focus();
    };
  }, [open]);

  useEffect(() => {
    if (folder && !picking) addButton.current?.focus();
  }, [folder, picking]);

  const choose = (path: string) => {
    setFolder(path); setError("");
    if (!nameEdited.current) setName(path.split(/[\\/]/).filter(Boolean).pop() || path);
    addButton.current?.focus();
  };
  const pick = async () => {
    if (picking || saving) return;
    const controller = new AbortController(); selectionRequest.current = controller;
    setPicking(true); setError("");
    try {
      const result = await request<DirectorySelectionResult>("/api/fs/pick-directory", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initialPath: folder || initialPath }), signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (result.status === "selected") choose(result.path);
      if (result.status === "unavailable") setError("系统目录选择器不可用，请确认已安装 kdialog 或 zenity 并在桌面环境中运行");
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (!controller.signal.aborted) setPicking(false); }
  };
  const create = async () => {
    if (savingRef.current || !name.trim() || !folder) return;
    savingRef.current = true; setSaving(true); setError("");
    try {
      const result = await request<ProjectCreationResult>("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create", workspace: folder, name: name.trim() }) });
      await onCreated(result); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { savingRef.current = false; setSaving(false); }
  };

  return <div className={`create-project-backdrop ${open ? "open" : ""}`} aria-hidden={!open} inert={!open} onPointerDown={event => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <section ref={panel} className="create-project-dialog" role="dialog" aria-modal="true" aria-labelledby="create-project-title">
      <header><h2 id="create-project-title">创建项目</h2><button className="icon-btn" title="关闭" aria-label="关闭创建项目" disabled={saving} onClick={onClose}><X size={18} /></button></header>
        <div className="project-name-field"><span><Folder size={19} /></span><input ref={nameInput} aria-label="项目名称" placeholder="项目名称" value={name} disabled={saving} onChange={event => { nameEdited.current = true; setName(event.target.value); }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void create(); } }} /></div>
        <label className="project-source-label">源文件夹</label>
        <div className={`project-source ${folder ? "has-folder" : ""}`}>
          {folder ? <div className="project-source-folder"><Folder size={23} /><div><strong>{folder.split(/[\\/]/).filter(Boolean).pop() || folder}</strong><span title={folder}>{folder}</span></div><button className="icon-btn" title="移除源文件夹" aria-label="移除源文件夹" disabled={saving || picking} onClick={() => { setFolder(""); setError(""); }}><X size={16} /></button></div> : null}
          <span className="project-source-method">在此电脑上添加文件夹</span>
          <button ref={addButton} className="project-add-folder" disabled={picking || saving} onClick={() => void pick()}>{picking ? <LoaderCircle size={17} className="project-spinner" /> : <FolderPlus size={18} />}{picking ? "选择中…" : folder ? "更换" : "添加"}</button>
        </div>
      {error && <p className="project-dialog-error" role="alert">{error}</p>}
      <footer><button className="project-cancel" disabled={saving} onClick={onClose}>取消</button><button className="project-create" disabled={!name.trim() || !folder || saving || picking} onClick={() => void create()}>{saving ? "创建中…" : "创建项目"}</button></footer>
    </section>
  </div>;
}
