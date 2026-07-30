"use client";
import { useEffect, useRef, useState } from "react";
import { supabase } from "../../lib/supabase";
import Shell from "../../components/Shell";

const CATEGORIES = [
  { code: "financial", label: "Financial" },
  { code: "medical",   label: "Medical" },
  { code: "legal",     label: "Legal / Estate" },
  { code: "identity",  label: "Identity" },
  { code: "other",     label: "Other" },
];

const ACCEPT = ".pdf,.doc,.docx,.jpg,.jpeg,.png,.gif,.webp,.heic,.heif,.xls,.xlsx,.csv,.txt";
const MAX_MB = 50;

// ── icons ──────────────────────────────────────────────────────────────────

function IconUpload() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 11V3M5 6l3-3 3 3" />
      <path d="M2 12v1a1 1 0 001 1h10a1 1 0 001-1v-1" />
    </svg>
  );
}

function IconExternalLink() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 2H2a1 1 0 00-1 1v9a1 1 0 001 1h9a1 1 0 001-1V8" />
      <path d="M9 1h4v4" /><path d="M13 1L7 7" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 4h12M6 4V2h4v2M5 4l1 9h4l1-9" />
    </svg>
  );
}

function IconEdit() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 2l3 3-8 8H3v-3l8-8z" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M1 1l12 12M13 1L1 13" />
    </svg>
  );
}

function FileTypeIcon({ mimeType, fileName }) {
  const ext = (fileName ?? "").split(".").pop().toLowerCase();
  const isImage = mimeType?.startsWith("image/") || ["jpg","jpeg","png","gif","webp","heic","heif"].includes(ext);
  const isPdf   = mimeType === "application/pdf" || ext === "pdf";
  const isSheet = ["xls","xlsx","csv"].includes(ext);
  const isDoc   = ["doc","docx"].includes(ext);

  if (isImage) {
    return (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" className="text-blue-400" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>
      </svg>
    );
  }
  if (isPdf) {
    return (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" className="text-red-400" aria-hidden="true">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/>
        <path d="M9 13h1.5a1 1 0 010 2H9v-4h1.5a1 1 0 010 2"/><path d="M14 13v4"/><path d="M17 13h-1.5v4H17"/>
      </svg>
    );
  }
  if (isSheet) {
    return (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" className="text-green-400" aria-hidden="true">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/>
        <path d="M8 13h8M8 17h8M8 9h2"/>
      </svg>
    );
  }
  if (isDoc) {
    return (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" className="text-blue-300" aria-hidden="true">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/>
        <path d="M8 13h8M8 17h8M8 9h2"/>
      </svg>
    );
  }
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" className="text-paper-dim" aria-hidden="true">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/>
    </svg>
  );
}

function fmtSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ── page ───────────────────────────────────────────────────────────────────

export default function DocumentsPage() {
  const [docs, setDocs]           = useState(null);
  const [activeCategory, setActiveCategory] = useState("all");
  const [search, setSearch]       = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadForm, setUploadForm] = useState({ name: "", category: "", notes: "" });
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadError, setUploadError] = useState("");
  const [uploadBusy, setUploadBusy] = useState(false);
  const [editingDoc, setEditingDoc] = useState(null);
  const [editForm, setEditForm]   = useState({ name: "", category: "", notes: "" });
  const [editBusy, setEditBusy]   = useState(false);
  const [editError, setEditError] = useState("");
  const [viewBusy, setViewBusy]   = useState(null);
  const fileInputRef = useRef(null);

  async function load() {
    const { data } = await supabase
      .from("documents")
      .select("*")
      .order("created_at", { ascending: false });
    setDocs(data ?? []);
  }

  useEffect(() => { load(); }, []);

  // ── upload ──────────────────────────────────────────────────────────────

  function openUpload() {
    setUploadForm({ name: "", category: CATEGORIES[0].code, notes: "" });
    setUploadFile(null);
    setUploadError("");
    setUploading(true);
  }

  function onFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_MB * 1024 * 1024) {
      setUploadError(`File exceeds ${MAX_MB} MB limit.`);
      return;
    }
    setUploadError("");
    setUploadFile(file);
    if (!uploadForm.name) {
      // Pre-fill name from filename (strip extension)
      const base = file.name.replace(/\.[^/.]+$/, "").replace(/[-_]/g, " ");
      setUploadForm((f) => ({ ...f, name: base }));
    }
  }

  async function saveUpload() {
    if (!uploadFile || !uploadForm.name || !uploadForm.category) return;
    setUploadBusy(true);
    setUploadError("");

    const { data: { user } } = await supabase.auth.getUser();
    const ext       = uploadFile.name.split(".").pop();
    const timestamp = Date.now();
    const filePath  = `${user.id}/${uploadForm.category}/${timestamp}_${uploadFile.name}`;

    const { error: storageErr } = await supabase.storage
      .from("documents")
      .upload(filePath, uploadFile, { upsert: false });

    if (storageErr) {
      setUploadBusy(false);
      setUploadError(storageErr.message);
      return;
    }

    const { error: dbErr } = await supabase.from("documents").insert({
      user_id:   user.id,
      name:      uploadForm.name.trim(),
      category:  uploadForm.category,
      notes:     uploadForm.notes.trim() || null,
      file_path: filePath,
      file_name: uploadFile.name,
      file_size: uploadFile.size,
      mime_type: uploadFile.type || null,
    });

    setUploadBusy(false);
    if (dbErr) {
      // Roll back storage upload on DB failure
      await supabase.storage.from("documents").remove([filePath]);
      setUploadError(dbErr.message);
      return;
    }

    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
    load();
  }

  // ── view (signed URL) ───────────────────────────────────────────────────

  async function viewDoc(doc) {
    setViewBusy(doc.id);
    const { data, error } = await supabase.storage
      .from("documents")
      .createSignedUrl(doc.file_path, 3600);
    setViewBusy(null);
    if (error || !data?.signedUrl) return;
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  }

  // ── edit metadata ───────────────────────────────────────────────────────

  function openEdit(doc) {
    setEditingDoc(doc);
    setEditForm({ name: doc.name, category: doc.category, notes: doc.notes ?? "" });
    setEditError("");
  }

  async function saveEdit() {
    setEditBusy(true);
    setEditError("");
    const { error } = await supabase
      .from("documents")
      .update({
        name:     editForm.name.trim(),
        category: editForm.category,
        notes:    editForm.notes.trim() || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", editingDoc.id);
    setEditBusy(false);
    if (error) { setEditError(error.message); return; }
    setEditingDoc(null);
    load();
  }

  // ── delete ───────────────────────────────────────────────────────────────

  async function deleteDoc(doc) {
    if (!confirm(`Delete "${doc.name}"? This cannot be undone.`)) return;
    await supabase.storage.from("documents").remove([doc.file_path]);
    await supabase.from("documents").delete().eq("id", doc.id);
    load();
  }

  // ── filtered list ────────────────────────────────────────────────────────

  const filtered = (docs ?? []).filter((d) => {
    const catOk    = activeCategory === "all" || d.category === activeCategory;
    const searchOk = !search || d.name.toLowerCase().includes(search.toLowerCase()) ||
                     (d.notes ?? "").toLowerCase().includes(search.toLowerCase());
    return catOk && searchOk;
  });

  const countByCategory = {};
  for (const d of docs ?? []) {
    countByCategory[d.category] = (countByCategory[d.category] ?? 0) + 1;
  }

  // ── render ───────────────────────────────────────────────────────────────

  return (
    <Shell>
      {/* Page header */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold tracking-tight">Documents</h1>
        <button onClick={openUpload} className="btn flex items-center gap-2 text-sm px-3 py-1.5">
          <IconUpload /> Upload
        </button>
      </div>

      <div className="flex gap-4">
        {/* Category sidebar */}
        <aside className="w-44 shrink-0">
          <div className="card p-2 space-y-0.5">
            <button
              onClick={() => setActiveCategory("all")}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center justify-between ${
                activeCategory === "all"
                  ? "bg-ink text-brass-soft"
                  : "text-paper-dim hover:text-paper hover:bg-ink"
              }`}
            >
              <span>All</span>
              {docs && <span className="text-xs opacity-60">{docs.length}</span>}
            </button>
            {CATEGORIES.map((cat) => (
              <button
                key={cat.code}
                onClick={() => setActiveCategory(cat.code)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center justify-between ${
                  activeCategory === cat.code
                    ? "bg-ink text-brass-soft"
                    : "text-paper-dim hover:text-paper hover:bg-ink"
                }`}
              >
                <span>{cat.label}</span>
                {(countByCategory[cat.code] ?? 0) > 0 && (
                  <span className="text-xs opacity-60">{countByCategory[cat.code]}</span>
                )}
              </button>
            ))}
          </div>
        </aside>

        {/* Main area */}
        <div className="flex-1 min-w-0">
          {/* Search */}
          <div className="mb-3">
            <input
              className="field text-sm"
              placeholder="Search documents…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {/* Document list */}
          <div className="card overflow-hidden">
            {docs === null && (
              <p className="px-5 py-10 text-center text-paper-dim text-sm">Loading…</p>
            )}
            {docs !== null && filtered.length === 0 && (
              <p className="px-5 py-10 text-center text-paper-dim text-sm">
                {search || activeCategory !== "all"
                  ? "No documents match."
                  : "No documents yet. Use Upload to add your first one."}
              </p>
            )}
            {filtered.length > 0 && (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-line">
                    <th className="w-10 px-4 py-3"></th>
                    <th className="label text-left font-medium px-3 py-3">Name</th>
                    <th className="label text-left font-medium px-3 py-3 hidden sm:table-cell">Category</th>
                    <th className="label text-left font-medium px-3 py-3 hidden md:table-cell">Notes</th>
                    <th className="label text-right font-medium px-3 py-3 hidden sm:table-cell">Size</th>
                    <th className="label text-right font-medium px-3 py-3">Added</th>
                    <th className="w-20 px-3 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((doc) => (
                    <tr
                      key={doc.id}
                      className="border-b border-ink-line/60 last:border-0 hover:bg-ink/30 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <FileTypeIcon mimeType={doc.mime_type} fileName={doc.file_name} />
                      </td>
                      <td className="px-3 py-3">
                        <button
                          onClick={() => viewDoc(doc)}
                          disabled={viewBusy === doc.id}
                          className="font-medium text-left hover:text-brass transition-colors disabled:opacity-50"
                        >
                          {doc.name}
                        </button>
                        <p className="text-xs text-paper-dim/70 mt-0.5">{doc.file_name}</p>
                      </td>
                      <td className="px-3 py-3 hidden sm:table-cell">
                        <span className="text-paper-dim text-xs">
                          {CATEGORIES.find((c) => c.code === doc.category)?.label ?? doc.category}
                        </span>
                      </td>
                      <td className="px-3 py-3 hidden md:table-cell">
                        <span className="text-paper-dim text-xs line-clamp-1">{doc.notes ?? "—"}</span>
                      </td>
                      <td className="px-3 py-3 text-right hidden sm:table-cell">
                        <span className="text-paper-dim text-xs">{fmtSize(doc.file_size)}</span>
                      </td>
                      <td className="px-3 py-3 text-right text-paper-dim text-xs whitespace-nowrap">
                        {fmtDate(doc.created_at)}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => viewDoc(doc)}
                            disabled={viewBusy === doc.id}
                            className="p-1.5 rounded-lg text-paper-dim hover:text-brass hover:bg-ink transition-colors disabled:opacity-40"
                            aria-label="Open"
                          >
                            <IconExternalLink />
                          </button>
                          <button
                            onClick={() => openEdit(doc)}
                            className="p-1.5 rounded-lg text-paper-dim hover:text-paper hover:bg-ink transition-colors"
                            aria-label="Edit"
                          >
                            <IconEdit />
                          </button>
                          <button
                            onClick={() => deleteDoc(doc)}
                            className="p-1.5 rounded-lg text-paper-dim hover:text-loss hover:bg-ink transition-colors"
                            aria-label="Delete"
                          >
                            <IconTrash />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* Upload drawer */}
      <div className={`fixed inset-0 z-30 ${uploading ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/70 transition-opacity ${uploading ? "opacity-100" : "opacity-0"}`}
          onClick={() => setUploading(false)}
        />
        <div
          className={`absolute right-0 top-0 h-full w-full max-w-sm bg-ink-soft border-l border-ink-line p-5 space-y-4 overflow-y-auto transition-transform duration-300 ${
            uploading ? "translate-x-0" : "translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between">
            <p className="font-medium">Upload document</p>
            <button onClick={() => setUploading(false)} className="text-paper-dim hover:text-paper" aria-label="Close">
              <IconClose />
            </button>
          </div>

          {/* Drop zone / file picker */}
          <div>
            <label
              htmlFor="doc-file"
              className={`flex flex-col items-center justify-center gap-2 w-full border-2 border-dashed rounded-xl px-4 py-8 cursor-pointer transition-colors ${
                uploadFile
                  ? "border-brass/60 bg-brass/5"
                  : "border-ink-line hover:border-brass/40"
              }`}
            >
              {uploadFile ? (
                <>
                  <FileTypeIcon mimeType={uploadFile.type} fileName={uploadFile.name} />
                  <p className="text-sm font-medium text-center break-all">{uploadFile.name}</p>
                  <p className="text-xs text-paper-dim">{fmtSize(uploadFile.size)}</p>
                  <p className="text-xs text-brass-soft">Click to change</p>
                </>
              ) : (
                <>
                  <IconUpload />
                  <p className="text-sm text-paper-dim text-center">
                    Click to select a file
                    <br />
                    <span className="text-xs">PDF, images, Word, Excel · max {MAX_MB} MB</span>
                  </p>
                </>
              )}
            </label>
            <input
              id="doc-file"
              ref={fileInputRef}
              type="file"
              accept={ACCEPT}
              className="sr-only"
              onChange={onFileChange}
            />
          </div>

          <div>
            <label className="label block mb-1.5" htmlFor="doc-name">Name</label>
            <input
              id="doc-name"
              className="field"
              placeholder="2024 Bank Statement"
              value={uploadForm.name}
              onChange={(e) => setUploadForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>

          <div>
            <label className="label block mb-1.5" htmlFor="doc-cat">Category</label>
            <select
              id="doc-cat"
              className="field"
              value={uploadForm.category}
              onChange={(e) => setUploadForm((f) => ({ ...f, category: e.target.value }))}
            >
              {CATEGORIES.map((c) => (
                <option key={c.code} value={c.code}>{c.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="label block mb-1.5" htmlFor="doc-notes">Notes (optional)</label>
            <textarea
              id="doc-notes"
              className="field resize-none"
              rows={3}
              placeholder="Any context or description…"
              value={uploadForm.notes}
              onChange={(e) => setUploadForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </div>

          {uploadError && <p className="text-loss text-sm">{uploadError}</p>}

          <button
            className="btn w-full"
            onClick={saveUpload}
            disabled={uploadBusy || !uploadFile || !uploadForm.name || !uploadForm.category}
          >
            {uploadBusy ? "Uploading…" : "Upload document"}
          </button>
        </div>
      </div>

      {/* Edit metadata drawer */}
      <div className={`fixed inset-0 z-30 ${editingDoc ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/70 transition-opacity ${editingDoc ? "opacity-100" : "opacity-0"}`}
          onClick={() => setEditingDoc(null)}
        />
        <div
          className={`absolute right-0 top-0 h-full w-full max-w-sm bg-ink-soft border-l border-ink-line p-5 space-y-4 overflow-y-auto transition-transform duration-300 ${
            editingDoc ? "translate-x-0" : "translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between">
            <p className="font-medium">Edit document</p>
            <button onClick={() => setEditingDoc(null)} className="text-paper-dim hover:text-paper" aria-label="Close">
              <IconClose />
            </button>
          </div>

          <div>
            <label className="label block mb-1.5" htmlFor="edit-name">Name</label>
            <input
              id="edit-name"
              className="field"
              value={editForm.name}
              onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>

          <div>
            <label className="label block mb-1.5" htmlFor="edit-cat">Category</label>
            <select
              id="edit-cat"
              className="field"
              value={editForm.category}
              onChange={(e) => setEditForm((f) => ({ ...f, category: e.target.value }))}
            >
              {CATEGORIES.map((c) => (
                <option key={c.code} value={c.code}>{c.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="label block mb-1.5" htmlFor="edit-notes">Notes (optional)</label>
            <textarea
              id="edit-notes"
              className="field resize-none"
              rows={3}
              value={editForm.notes}
              onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </div>

          {editError && <p className="text-loss text-sm">{editError}</p>}

          <div className="flex gap-3">
            <button
              className="btn flex-1"
              onClick={saveEdit}
              disabled={editBusy || !editForm.name || !editForm.category}
            >
              {editBusy ? "Saving…" : "Save changes"}
            </button>
            <button className="btn-ghost flex-1" onClick={() => setEditingDoc(null)}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </Shell>
  );
}
