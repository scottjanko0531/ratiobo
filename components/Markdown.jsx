"use client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const COMPONENTS = {
  h1: ({ children }) => <h2 className="text-base font-semibold text-paper mt-5 mb-2 first:mt-0">{children}</h2>,
  h2: ({ children }) => <h2 className="text-base font-semibold text-paper mt-5 mb-2 pb-1.5 border-b border-ink-line first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-semibold text-paper mt-4 mb-1.5">{children}</h3>,
  p: ({ children }) => <p className="text-sm text-paper-dim leading-relaxed mb-2.5">{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-5 space-y-1 mb-2.5 text-sm text-paper-dim">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 space-y-1 mb-2.5 text-sm text-paper-dim">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="text-paper font-medium">{children}</strong>,
  em: ({ children }) => <em className="text-paper-dim">{children}</em>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-brass-soft hover:underline">
      {children}
    </a>
  ),
  hr: () => <hr className="border-ink-line my-4" />,
  table: ({ children }) => (
    <div className="overflow-x-auto mb-3">
      <table className="w-full text-xs border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead>{children}</thead>,
  th: ({ children }) => (
    <th className="label text-left font-medium py-1.5 pr-3 border-b border-ink-line whitespace-nowrap">{children}</th>
  ),
  td: ({ children }) => <td className="py-1.5 pr-3 border-b border-ink-line/40 text-paper-dim">{children}</td>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-brass/40 pl-3 my-2 text-sm text-paper-dim italic">{children}</blockquote>
  ),
  code: ({ children }) => <code className="text-xs bg-ink px-1 py-0.5 rounded">{children}</code>,
};

export default function Markdown({ children }) {
  return (
    <div>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
