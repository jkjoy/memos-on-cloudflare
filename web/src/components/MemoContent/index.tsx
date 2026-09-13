import { memo, useMemo } from "react";
import { cn } from "@/lib/utils";
import { extractMentionUsernames } from "@/utils/remark-plugins/remark-mention";
import { MemoMarkdownRenderer } from "./MemoMarkdownRenderer";
import { useResolvedMentionUsernames } from "./MentionResolutionContext";
import type { MemoContentProps } from "./types";

// Stateless markdown renderer. Truncation is not this component's concern — compact cards
// are bounded by ClampedSection around the whole memo body; `compact` here only informs
// the renderer (e.g. footnote links navigate to the detail page instead of scrolling,
// since a collapsed card may hide the target).
const MemoContent = (props: MemoContentProps) => {
  const { className, contentClassName, content, onClick, onDoubleClick } = props;
  const mentionUsernames = useMemo(() => extractMentionUsernames(content), [content]);
  const resolvedMentionUsernames = useResolvedMentionUsernames(mentionUsernames);

  return (
    <div className={`w-full flex flex-col justify-start items-start text-foreground ${className || ""}`}>
      <div
        data-memo-content
        className={cn(
          "relative w-full max-w-full wrap-break-word text-base leading-6",
          "[&>*:last-child]:mb-0",
          "[&_.katex-display]:max-w-full",
          "[&_.katex-display]:overflow-x-auto",
          "[&_.katex-display]:overflow-y-hidden",
          contentClassName,
        )}
        onMouseUp={onClick}
        onDoubleClick={onDoubleClick}
      >
        <MemoMarkdownRenderer content={content} resolvedMentionUsernames={resolvedMentionUsernames} />
      </div>
    </div>
  );
};

export default memo(MemoContent);
